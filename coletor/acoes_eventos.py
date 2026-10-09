"""Balanços e eventos das ações (aba que, em ações, fica no lugar do SOPR).

- Calendário de balanços: calendário diário da Nasdaq (grátis, sem chave), guardado na tabela
  `balancos` só para os tickers do grupo xyz. A carga de 10 anos é feita uma vez
  (`--historico`, ~2 h, retomável); depois, todo dia, só a janela de -3 a +60 dias.
- Reação histórica: preço diário de 10 anos do Yahoo. Reação = fechamento do pregão seguinte ao
  anúncio ÷ fechamento do pregão anterior (janela de 2 pregões, porque a Nasdaq muitas vezes
  não informa se foi antes da abertura ou depois do fechamento).
- Agenda macro da semana (ForexFactory: eventos dos EUA de impacto alto e médio).
- Teste do fim de semana: o contrato da Hyperliquid no domingo à noite antecipa a abertura
  de segunda na bolsa? Compara com "sem gap" para saber se ajuda de verdade.

  python acoes_eventos.py                 # atualiza tudo e grava kv 'acoes_eventos'
  python acoes_eventos.py --se-velho 20   # só se o último tiver mais de 20 h (laço da nuvem)
  python acoes_eventos.py --historico     # carga dos 10 anos de datas de balanço
"""
import argparse
import os
import statistics as st
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import requests

import acoes
from db import conectar
from hl import Hyperliquid

NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
NASDAQ = "https://api.nasdaq.com/api/calendar/earnings?date={}"
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/{}?range={}&interval=1d"
FOREX_FACTORY = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
ANOS = 10
SEM_BALANCO = {"Commodities", "Câmbio", "Índices e ETFs"}   # nesses setores o ticker não é de empresa
ETFS = {"SOXL", "SMH", "DRAM", "KORU", "MAGS", "XBI", "XLE", "TLT", "URNM", "EWJ", "EWT", "EWY", "EWZ"}
YAHOO_SIMBOLO = {"SP500": "^GSPC", "XYZ100": "^NDX", "SKHX": "000660.KS"}
DATAS_DE = {"SKHX": "SKHY"}   # SK hynix na Coreia não está no calendário da Nasdaq: usa as datas do ADR
HORA = {"time-pre-market": "antes", "time-after-hours": "depois"}
DIA = 86_400_000
NA_NUVEM = bool(os.environ.get("GITHUB_ACTIONS"))


def log(msg):
    print(time.strftime("%H:%M:%S"), "[eventos]", msg, flush=True)


def _get(url, tentativas=3, **kw):
    for t in range(tentativas):
        try:
            r = requests.get(url, headers={"User-Agent": NAVEGADOR, "Accept": "application/json"}, timeout=30, **kw)
            if r.status_code == 200:
                return r.json()
        except (requests.RequestException, ValueError):
            pass
        time.sleep(2 * (t + 1))
    return None


# ---------- calendário de balanços ----------

def tickers_de_empresas(hl):
    """Todos os tickers do xyz (inclusive os que saíram) que são de empresa."""
    meta = hl.info({"type": "meta", "dex": acoes.DEX})
    return ({u["name"].split(":", 1)[1] for u in meta["universe"]} - {t for t, s in acoes.SETOR.items() if s in SEM_BALANCO}
            - ETFS)


def _dia(d, tickers):
    j = _get(NASDAQ.format(d.isoformat()))
    if j is None:
        return d, None
    rows = ((j.get("data") or {}).get("rows")) or []
    return d, [(r["symbol"], d.isoformat(), HORA.get(r.get("time")), r.get("fiscalQuarterEnding"), r.get("epsForecast"))
               for r in rows if r.get("symbol") in tickers]


def escanear(con, tickers, inicio, fim, substituir=False, threads=3):
    """Lê o calendário dia a dia (só dias úteis). substituir=True apaga o que havia na janela antes
    (datas futuras mudam: a empresa confirma ou remarca)."""
    dias = [inicio + timedelta(n) for n in range((fim - inicio).days + 1)]
    dias = [d for d in dias if d.weekday() < 5]
    agora = int(time.time() * 1000)
    linhas, falhas = [], 0
    with ThreadPoolExecutor(threads) as ex:
        for d, achadas in ex.map(lambda d: _dia(d, tickers), dias):
            if achadas is None:
                falhas += 1
            else:
                linhas += [(*a, agora) for a in achadas]
    if falhas > len(dias) / 2:
        raise RuntimeError(f"calendário da Nasdaq falhou em {falhas} de {len(dias)} dias")
    if substituir:
        con.execute("DELETE FROM balancos WHERE data >= ? AND data <= ?", (inicio.isoformat(), fim.isoformat()))
    con.executemany("INSERT INTO balancos VALUES (?,?,?,?,?,?) ON CONFLICT (simbolo, data) DO UPDATE SET "
                    "hora=excluded.hora, trimestre=excluded.trimestre, eps_previsto=excluded.eps_previsto, "
                    "atualizado=excluded.atualizado", linhas)
    con.commit()
    return len(dias), len(linhas), falhas


def carga_historica(con, hl):
    """10 anos de datas, em blocos de 60 dias, do mais recente para o mais antigo. Retomável."""
    tickers = tickers_de_empresas(hl)
    feito = con.kv_ler("balancos_historico") or {}
    ate = date.fromisoformat(feito["ate"]) if feito.get("ate") else date.today()
    limite = date.today() - timedelta(days=365 * ANOS + 10)
    while ate > limite:
        inicio = max(limite, ate - timedelta(days=59))
        n, achadas, falhas = escanear(con, tickers, inicio, ate)
        con.kv_gravar("balancos_historico", {"ate": inicio.isoformat(), "limite": limite.isoformat()})
        log(f"histórico: {inicio} a {ate} · {n} dias · {achadas} balanços dos tickers do xyz · {falhas} falhas")
        ate = inicio - timedelta(days=1)
    log("carga histórica completa")


# ---------- preços da bolsa (Yahoo) ----------

def yahoo_diario(tk, faixa="10y"):
    """[(AAAA-MM-DD, abertura, fechamento)] da ação de verdade, ajustado por desdobramentos."""
    j = _get(YAHOO.format(YAHOO_SIMBOLO.get(tk, tk), faixa))
    try:
        res = j["chart"]["result"][0]
        q, off = res["indicators"]["quote"][0], res["meta"].get("gmtoffset", 0)
    except (TypeError, KeyError, IndexError):
        return [], {}
    barras = [(datetime.fromtimestamp(t + off, timezone.utc).date().isoformat(), o, c)
              for t, o, c in zip(res.get("timestamp") or [], q["open"], q["close"]) if o is not None and c is not None]
    return barras, res["meta"]


# ---------- reação aos balanços ----------

def reacao(barras, datas, hoje):
    """Reação = fechamento do pregão seguinte ao anúncio ÷ fechamento do pregão anterior.
    Comparada com o movimento normal de 2 pregões da mesma ação (mediana)."""
    import bisect
    dias = [b[0] for b in barras]
    fech = [b[2] for b in barras]
    movs = []
    for d, hora in sorted(datas):
        if d >= hoje:
            continue
        i_ant, i_dep = bisect.bisect_left(dias, d) - 1, bisect.bisect_right(dias, d)
        if i_ant < 0 or i_dep >= len(dias):
            continue
        if (date.fromisoformat(dias[i_dep]) - date.fromisoformat(d)).days > 5:   # buraco no histórico
            continue
        movs.append((d, hora, fech[i_dep] / fech[i_ant] - 1))
    normal = st.median(abs(fech[i + 2] / fech[i] - 1) for i in range(len(fech) - 2)) if len(fech) > 30 else None
    if not movs:
        return {"n": 0, "normal": normal}
    r = [m[2] for m in movs]
    altas, quedas = [x for x in r if x > 0], [x for x in r if x <= 0]
    med_abs = st.median(abs(x) for x in r)
    return {"n": len(r), "desde": movs[0][0], "mediana_abs": med_abs, "subiu": len(altas) / len(r),
            "media_alta": st.fmean(altas) if altas else None, "media_queda": st.fmean(quedas) if quedas else None,
            "maior_alta": max(r), "maior_queda": min(r), "normal": normal,
            "vezes": med_abs / normal if normal else None,
            "ultimas": [[d, h, round(x, 4)] for d, h, x in movs[-4:]]}


def _agrupar_datas(linhas):
    """Uma data por balanço: o calendário às vezes repete a empresa em dias seguidos."""
    saida = []
    for d, h in sorted(linhas):
        if saida and (date.fromisoformat(d) - date.fromisoformat(saida[-1][0])).days < 20:
            continue
        saida.append((d, h))
    return saida


def proximo(datas, hoje):
    """Próximo balanço: o do calendário (até ~60 dias à frente) ou, se não houver, estimado (marcado):
    o balanço da mesma época do ano passado + 52 semanas (mesmo dia da semana); sem um ano de
    histórico, o espaçamento mediano dos últimos."""
    futuros = [x for x in datas if x[0] >= hoje]
    if futuros:
        return {"data": futuros[0][0], "hora": futuros[0][1], "estimado": False}
    passados = [date.fromisoformat(x[0]) for x in datas if x[0] < hoje]
    if len(passados) < 2:
        return None
    hoje_d = date.fromisoformat(hoje)
    ano_passado = [d + timedelta(weeks=52) for d in passados if d + timedelta(weeks=52) >= hoje_d
                   and passados[-1] + timedelta(days=45) < d + timedelta(weeks=52) <= passados[-1] + timedelta(days=120)]
    if ano_passado:
        est = min(ano_passado)
    else:
        passo = max(30, round(st.median([(b - a).days for a, b in zip(passados, passados[1:])][-4:])))
        est = passados[-1] + timedelta(days=passo)
        while est < hoje_d:
            est += timedelta(days=passo)
        while est.weekday() > 4:
            est += timedelta(days=1)
    return {"data": est.isoformat(), "hora": None, "estimado": True}


# ---------- agenda macro ----------

# nome na Nasdaq -> (nome em português, impacto)
MACRO = {
    "CPI": ("Inflação ao consumidor (CPI)", "alto"), "Core CPI": ("Núcleo da inflação (CPI)", "alto"),
    "Nonfarm Payrolls": ("Payroll (empregos fora do agro)", "alto"), "Unemployment Rate": ("Taxa de desemprego", "alto"),
    "Fed Interest Rate Decision": ("Decisão de juros do Fed", "alto"), "FOMC Statement": ("Comunicado do Fed", "alto"),
    "FOMC Press Conference": ("Entrevista do presidente do Fed", "alto"),
    "Core PCE Price Index": ("Núcleo do PCE (inflação que o Fed usa)", "alto"), "GDP": ("PIB", "alto"),
    "Retail Sales": ("Vendas no varejo", "alto"), "PPI": ("Inflação ao produtor (PPI)", "médio"),
    "Core PPI": ("Núcleo do PPI", "médio"), "FOMC Meeting Minutes": ("Ata do Fed", "médio"),
    "ISM Manufacturing PMI": ("ISM da indústria", "médio"), "ISM Non-Manufacturing PMI": ("ISM de serviços", "médio"),
    "Initial Jobless Claims": ("Pedidos de seguro-desemprego", "médio"), "JOLTS Job Openings": ("Vagas de emprego (JOLTS)", "médio"),
    "ADP Nonfarm Employment Change": ("Empregos ADP", "médio"), "CB Consumer Confidence": ("Confiança do consumidor", "médio"),
    "Michigan Consumer Sentiment": ("Sentimento do consumidor (Michigan)", "médio"), "Beige Book": ("Livro Bege do Fed", "médio"),
    "Crude Oil Inventories": ("Estoques de petróleo (EIA)", "médio"), "Natural Gas Storage": ("Estoques de gás natural", "médio"),
    "OPEC Meeting": ("Reunião da Opep", "médio"), "U.S. President Trump Speaks": ("Fala do presidente dos EUA", "médio"),
}


def _ms_ny(d, hora, minuto=0):
    """Instante (ms) de um horário de Nova York num dia."""
    for off in (4, 5):
        ms = int(datetime(d.year, d.month, d.day, hora, minuto, tzinfo=timezone.utc).timestamp() * 1000) + off * 3_600_000
        t = acoes._hora_ny(ms)
        if t.date() == d and t.hour == hora and t.minute == minuto:
            return ms
    return None


def agenda_macro(hoje_d, dias=10):
    eventos = []
    for k in range(dias):
        d = hoje_d + timedelta(k)
        if d.weekday() > 4:
            continue
        j = _get(f"https://api.nasdaq.com/api/calendar/economicevents?date={d.isoformat()}")
        for r in ((j or {}).get("data") or {}).get("rows") or []:
            nome = r.get("eventName", "").strip()
            pt = MACRO.get(nome) or (("Fala do presidente do Fed", "alto") if nome.startswith("Fed Chair") else None)
            if r.get("country") != "United States" or not pt:
                continue
            try:   # o campo se chama "gmt", mas os horários vêm em hora de Nova York (CPI às 08:30)
                h, m = (int(x) for x in r["gmt"].split(":"))
                t = _ms_ny(d, h, m)
            except (ValueError, KeyError):
                t = None
            limpa = lambda v: (v or "").replace("&nbsp;", "").strip() or None
            eventos.append({"t": t, "dia": d.isoformat(), "nome": pt[0], "original": nome, "impacto": pt[1],
                            "previsto": limpa(r.get("consensus")), "anterior": limpa(r.get("previous")),
                            "real": limpa(r.get("actual"))})
    # o mesmo dado sai em mais de uma linha (variação mensal e anual): junta numa só
    juntos = {}
    for e in eventos:
        k = (e["dia"], e["t"], e["nome"])
        if k not in juntos:
            juntos[k] = e
            continue
        for campo in ("previsto", "anterior", "real"):
            if e[campo] and e[campo] != juntos[k][campo]:
                juntos[k][campo] = " · ".join(x for x in (juntos[k][campo], e[campo]) if x)
    return sorted(juntos.values(), key=lambda e: (e["dia"], e["t"] or 0))


# ---------- teste do fim de semana ----------

def teste_fim_de_semana(hl, tickers, agora):
    """Para cada fim de semana dos últimos ~200 dias (velas de 1 h da Hyperliquid): o movimento do
    contrato de sexta 16h (fechamento da bolsa) até domingo 20h e até segunda 9h (antes da abertura)
    contra o gap real da abertura de segunda (Yahoo)."""
    linhas = []
    for tk in tickers:
        barras, _ = yahoo_diario(tk, "1y")
        velas = {v["t"]: float(v["c"]) for v in hl.velas(f"{acoes.DEX}:{tk}", "1h", agora - 210 * DIA, agora)}
        if not barras or not velas:
            continue
        preco_em = lambda ms: velas.get(ms - 3_600_000) if ms else None   # fechamento da vela que termina em ms
        for (d0, _, c0), (d1, o1, _) in zip(barras, barras[1:]):
            f, m = date.fromisoformat(d0), date.fromisoformat(d1)
            if f.weekday() != 4 or (m - f).days < 3:
                continue
            p_sex, p_dom, p_pre = preco_em(_ms_ny(f, 16)), preco_em(_ms_ny(f + timedelta(2), 20)), preco_em(_ms_ny(m, 9))
            if not (p_sex and p_dom and p_pre):
                continue
            linhas.append({"tk": tk, "sexta": d0, "gap": o1 / c0 - 1, "dom": p_dom / p_sex - 1, "pre": p_pre / p_sex - 1})

    def resumo(xs, chave):
        if len(xs) < 5:
            return {"n": len(xs)}
        fortes = [x for x in xs if abs(x[chave]) >= 0.005]
        acertos = [x for x in fortes if (x["gap"] > 0) == (x[chave] > 0)]
        pr, gp = [x[chave] for x in xs], [x["gap"] for x in xs]
        try:
            corr = st.correlation(pr, gp)
        except st.StatisticsError:
            corr = None
        return {"n": len(xs), "fins": len({x["sexta"] for x in xs}), "fortes": len(fortes),
                "acerto": len(acertos) / len(fortes) if fortes else None,
                "erro": st.median(abs(x["gap"] - x[chave]) for x in xs),
                "erro_sem_gap": st.median(abs(x["gap"]) for x in xs), "corr": corr}
    por_tk = {}
    for x in linhas:
        por_tk.setdefault(x["tk"], []).append(x)
    return {"dom": resumo(linhas, "dom"), "pre": resumo(linhas, "pre"),
            "por_acao": {tk: resumo(xs, "dom") for tk, xs in por_tk.items()},
            "desde": min((x["sexta"] for x in linhas), default=None)}


# ---------- tudo junto ----------

def executar(con=None, hl=None):
    con = con or conectar()
    hl = hl or Hyperliquid()
    agora = int(time.time() * 1000)
    hoje_d = acoes._hora_ny(agora).date()
    hoje = hoje_d.isoformat()
    tickers = tickers_de_empresas(hl)
    try:
        n, achadas, falhas = escanear(con, tickers, hoje_d - timedelta(3), hoje_d + timedelta(60), substituir=True)
        log(f"calendário: {n} dias lidos · {achadas} balanços de tickers do xyz · {falhas} falhas")
        calendario_ok = True
    except RuntimeError as e:
        log(f"calendário da Nasdaq indisponível ({e}); mantenho as datas que já tinha")
        calendario_ok = False

    universo = (con.kv_ler("acoes_universo") or {}).get("moedas") or []
    tks = [m.split(":", 1)[1] for m in universo]
    empresas = [t for t in tks if t in tickers or t in DATAS_DE]
    fontes = sorted({DATAS_DE.get(t, t) for t in empresas})
    datas = {}
    for r in con.execute(f"SELECT simbolo, data, hora FROM balancos WHERE simbolo IN ({','.join('?' * len(fontes))})",
                         fontes) if fontes else []:
        datas.setdefault(r["simbolo"], []).append((r["data"], r["hora"]))
    balancos = {}
    for tk in empresas:
        ds = _agrupar_datas(datas.get(DATAS_DE.get(tk, tk), []))
        barras, _ = yahoo_diario(tk)
        balancos[tk] = {"proximo": proximo(ds, hoje), "reacao": reacao(barras, ds, hoje) if barras else {"n": 0},
                        "dias_bolsa": len(barras)}
        time.sleep(0.3)
    log(f"balanços: {len(empresas)} empresas entre os {len(tks)} mercados · "
        f"{sum(1 for b in balancos.values() if b['reacao'].get('n'))} com histórico de reação")

    macro = agenda_macro(hoje_d)
    if not macro:   # reserva: ForexFactory (só a semana corrente)
        ff = _get(FOREX_FACTORY) or []
        macro = [{"t": int(datetime.fromisoformat(e["date"]).timestamp() * 1000), "dia": e["date"][:10],
                  "nome": e["title"], "original": e["title"], "impacto": "alto" if e["impact"] == "High" else "médio",
                  "previsto": e.get("forecast") or None, "anterior": e.get("previous") or None, "real": None}
                 for e in ff if e.get("country") == "USD" and e.get("impact") in ("High", "Medium")
                 and e["date"][:10] >= hoje]
    log(f"agenda macro: {len(macro)} eventos dos EUA nos próximos 10 dias")

    ny = [t for t in tks if acoes.sessao_de(t) == "Nova York"]
    fds = teste_fim_de_semana(hl, ny, agora)
    log(f"teste do fim de semana: {fds['dom'].get('n', 0)} casos em {fds['dom'].get('fins', 0)} fins de semana")
    dados = {"gerado": agora, "hoje_ny": hoje, "calendario_ok": calendario_ok, "balancos": balancos,
             "macro": macro, "fim_de_semana": fds,
             "historico": con.kv_ler("balancos_historico"),
             "datas_guardadas": con.execute("SELECT COUNT(*) FROM balancos").fetchone()[0]}
    con.kv_gravar("acoes_eventos", dados)
    return dados


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--historico", action="store_true")
    ap.add_argument("--se-velho", type=float, default=None)
    a = ap.parse_args()
    con = conectar()
    hl = Hyperliquid()
    if a.historico:
        carga_historica(con, hl)
        return
    ev = con.kv_ler("acoes_eventos")
    if a.se_velho is not None and ev and time.time() * 1000 - ev["gerado"] < a.se_velho * 3_600_000:
        return
    inicio = time.time()
    ok, det = True, ""
    try:
        executar(con, hl)
        det = f"{(time.time() - inicio) / 60:.0f} min"
    except Exception as e:
        ok, det = False, repr(e)
        raise
    finally:
        try:
            lista = (con.kv_ler("execucoes") or [])[-199:]
            lista.append({"tempo": int(time.time() * 1000), "tipo": "eventos_acoes",
                          "origem": "github" if NA_NUVEM else "pc", "ok": ok, "detalhe": det[:200]})
            con.kv_gravar("execucoes", lista)
        except Exception:
            pass


if __name__ == "__main__":
    main()
