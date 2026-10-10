"""Ações, fase 4: swing trade testado em 10 anos e a aba Setores e força.

Swing: os mesmos setups, regras de saída e filtro do cripto (fase4.py), em velas diárias da
bolsa (Yahoo, 10 anos). Diferenças:
- nenhuma entrada perto de balanço (do pregão anterior ao anúncio até 5 pregões antes dele):
  o gap do balanço não é o que o setup tenta capturar e decide a operação sozinho;
- a semana fecha na sexta (RSI semanal);
- os níveis são convertidos para o preço do contrato da Hyperliquid (escala = preço do
  contrato ÷ último fechamento na bolsa; quase sempre ~1, mas a SK hynix na Coreia é em won).

Setores e força: força relativa de cada papel do grupo xyz contra o S&P 500 (retornos de 3, 6,
9 e 12 meses, com peso maior no último trimestre) e um teste honesto no histórico: o terço mais
forte do mês continuou melhor que o terço mais fraco no mês seguinte?

  python acoes_swing.py                 # recalcula tudo e grava kv 'acoes_swing_base' e 'acoes_forca'
  python acoes_swing.py --se-velho 20   # só se o último tiver mais de 20 h (laço da nuvem)
"""
import argparse
import bisect
import os
import statistics as st
import time
from datetime import date, datetime, timezone

import acoes
import acoes_eventos
import fase4
from db import conectar
from hl import Hyperliquid

DIA_S = 86400
DIA = 86_400_000
NA_NUVEM = bool(os.environ.get("GITHUB_ACTIONS"))
YAHOO_HIST = {**acoes_eventos.YAHOO_SIMBOLO,
              "BRENTOIL": "BZ=F", "CL": "CL=F", "GOLD": "GC=F", "SILVER": "SI=F", "COPPER": "HG=F", "NATGAS": "NG=F",
              "PLATINUM": "PL=F", "PALLADIUM": "PA=F", "HO": "HO=F", "JP225": "^N225", "KR200": "^KS200",
              "SKHY": "000660.KS",   # o ADR estreou em 2026: o histórico é o da ação na Coreia (mesma empresa)
              "SMSN": "005930.KS", "HYUNDAI": "005380.KS", "SOFTBANK": "9984.T", "KIOXIA": "285A.T"}
BALANCO_ANTES = 5          # pregões antes do anúncio em que não se entra
BALANCO_DEPOIS = 1         # e o pregão do anúncio + 1 depois
MAX_DIAS_CORRIDOS = 28     # 20 pregões ≈ 28 dias corridos (acompanhamento do Diário)


def log(msg):
    print(time.strftime("%H:%M:%S"), "[swing ações]", msg, flush=True)


# ---------- dados ----------

def velas_bolsa(tk, faixa="10y"):
    """Velas diárias fechadas da bolsa (Yahoo), no formato do fase4. A vela do pregão em andamento
    fica de fora (o setup só vale no fechamento)."""
    sim = YAHOO_HIST.get(tk, tk)
    j = acoes_eventos._get(acoes_eventos.YAHOO.format(sim, faixa))
    try:
        res = j["chart"]["result"][0]
        q, meta = res["indicators"]["quote"][0], res["meta"]
    except (TypeError, KeyError, IndexError):
        return None
    off = meta.get("gmtoffset", 0)
    linhas = []
    for t, o, h, l, c in zip(res.get("timestamp") or [], q["open"], q["high"], q["low"], q["close"]):
        if None in (o, h, l, c) or min(o, h, l, c) <= 0:   # petróleo negativo em 04/2020 e buracos
            continue
        dia = datetime.fromtimestamp(t + off, timezone.utc).date()
        linhas.append((int(datetime(dia.year, dia.month, dia.day, tzinfo=timezone.utc).timestamp()), t, o, h, l, c))
    regular = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    if linhas and regular.get("start") and regular.get("end") and time.time() < regular["end"] \
            and linhas[-1][1] >= regular["start"]:
        linhas.pop()                                       # pregão de hoje ainda aberto
    vistos, limpas = set(), []
    for x in linhas:
        if x[0] not in vistos:
            vistos.add(x[0])
            limpas.append(x)
    if not limpas:
        return None
    ts, _, o, h, l, c = (list(v) for v in zip(*limpas))
    return {"ts": ts, "o": o, "h": h, "l": l, "c": c, "fonte": f"Yahoo {sim}", "fim_semana": 4}


def datas_de_balanco(con, tk):
    fonte = acoes_eventos.DATAS_DE.get(tk, tk)
    if tk == "SKHY":
        fonte = "SKHY"
    linhas = [(r["data"], r["hora"]) for r in con.execute("SELECT data, hora FROM balancos WHERE simbolo=?", (fonte,))]
    return [d for d, _ in acoes_eventos._agrupar_datas(linhas)]


def bloqueios(ts, datas):
    """Índices das barras em que não se entra: de 5 pregões antes do anúncio até 1 depois."""
    dias = [datetime.fromtimestamp(t, timezone.utc).date().isoformat() for t in ts]
    fora = set()
    for d in datas:
        k = bisect.bisect_left(dias, d)            # primeiro pregão no dia do anúncio ou depois
        fora.update(range(max(0, k - BALANCO_ANTES), min(len(ts), k + BALANCO_DEPOIS + 1)))
    return fora


def _bloqueado_agora(datas, hoje):
    """Balanço nos próximos ~7 dias corridos (5 pregões) ou no último pregão: sem entrada nova."""
    h = date.fromisoformat(hoje)
    return any(-2 <= (date.fromisoformat(d) - h).days <= 7 for d in datas)


# ---------- swing ----------

def _escalar(x, k):
    return None if x is None else x * k


def calcular_ativo(con, m, px_contrato, hoje):
    tk = m.split(":", 1)[1]
    d = velas_bolsa(tk)
    if not d:
        return {"erro": "sem histórico na bolsa (Yahoo)", "fonte": f"Yahoo {YAHOO_HIST.get(tk, tk)}"}
    if len(d["c"]) < fase4.AQUECIMENTO + 60:
        return {"erro": f"histórico curto: {len(d['c'])} pregões na bolsa (precisa de {fase4.AQUECIMENTO + 60})",
                "fonte": d["fonte"]}
    empresa = acoes.SETOR.get(tk) not in acoes_eventos.SEM_BALANCO and tk not in acoes_eventos.ETFS
    datas = datas_de_balanco(con, tk) if empresa else []
    fora = bloqueios(d["ts"], datas) if datas else set()
    ind = fase4.indicadores(d)
    ts = d["ts"]
    corte = ts[fase4.AQUECIMENTO] + (ts[-1] - ts[fase4.AQUECIMENTO]) * (1 - fase4.FORA_DA_AMOSTRA)
    escala = px_contrato / d["c"][-1] if px_contrato else 1.0
    px_bolsa = d["c"][-1] if not px_contrato else px_contrato / escala
    ult = len(d["c"]) - 1
    bloqueado = bool(datas) and _bloqueado_agora(datas, hoje)
    setups = []
    for s in fase4.SETUPS:
        ops = fase4.testar(s, ind, ts, fora)
        r = fase4.resumo(ops, corte)
        ativo = bool(ind["atr"][-1] and s["cond"](ind, ult)) and ult not in fora
        r.update({"id": s["id"], "nome": s["nome"].replace("(só no domingo)", "(só na sexta)"), "lado": s["lado"],
                  "ativo_ontem": ativo,
                  "gatilho": None if ativo else _escalar(fase4.gatilho(s, d, px_bolsa), escala),
                  "ultimas": [{"t": x["t"], "r": round(x["r"], 2)} for x in ops[-5:]]})
        if s["id"] == "rsi_semanal_60":
            v = next((x for x in reversed(ind["rsi_sem"]) if x is not None), None)
            r["nota"] = f"RSI sem. {v:.0f} (sexta)" if v is not None else None
        setups.append(r)
    ref = fase4.resumo(fase4.testar(fase4.QUALQUER_DIA, ind, ts, fora), corte)
    ref.update({"id": "referencia", "nome": fase4.QUALQUER_DIA["nome"], "lado": "long"})
    # ações subiram muito em 10 anos: um setup de compra só passa se também ganhar de comprar em
    # qualquer dia (no histórico todo e fora da amostra); senão é só carona na alta
    for r in setups:
        r["filtro_basico"] = r["passa"]
        if r["lado"] == "long":
            r["ganha_ref"] = bool(r["media"] is not None and ref["media"] is not None and r["media"] > ref["media"]
                                  and r["media_fora"] is not None and ref["media_fora"] is not None
                                  and r["media_fora"] > ref["media_fora"])
            r["passa"] = r["passa"] and r["ganha_ref"]
    ctx = fase4.contexto(d, ind)
    ctx["atr"] *= escala
    return {"fonte": d["fonte"], "desde": time.strftime("%Y-%m-%d", time.gmtime(ts[0])), "dias": len(ts),
            "ultimo_fechamento": d["c"][-1] * escala, "baixa_ontem": d["l"][-1] * escala,
            "alta_ontem": d["h"][-1] * escala, "sinal_ts": ts[-1], "escala": escala,
            "ultimo_pregao": time.strftime("%Y-%m-%d", time.gmtime(ts[-1])),
            "contexto": ctx, "setups": setups, "referencia": ref,
            "balanco": {"empresa": empresa, "datas": len(datas), "bloqueado": bloqueado,
                        "fora": len([i for i in fora if i >= fase4.AQUECIMENTO])}}


def calcular_base(con, hl):
    ctx = acoes._contextos(hl)
    agora = int(time.time() * 1000)
    moedas = acoes.universo(con, ctx, agora)
    hoje = acoes._hora_ny(agora).date().isoformat()
    saida = {"dia": hoje, "criterio": fase4.CRITERIO, "ids": [s["id"] for s in fase4.SETUPS],
             "regras": {"stop_atr": fase4.STOP_ATR, "alvo_r": fase4.ALVO_R, "max_dias": fase4.MAX_DIAS,
                        "custo": fase4.CUSTO, "fora_da_amostra": fase4.FORA_DA_AMOSTRA,
                        "balanco_antes": BALANCO_ANTES, "balanco_depois": BALANCO_DEPOIS},
             "ordem": moedas, "ativos": {}}
    for m in moedas:
        try:
            saida["ativos"][m] = calcular_ativo(con, m, float(ctx[m]["markPx"]) if m in ctx else None, hoje)
        except Exception as e:   # um papel com dado estranho não derruba os outros
            saida["ativos"][m] = {"erro": f"falha no cálculo: {e!r}"[:200]}
        time.sleep(0.3)
    saida["testes"] = sum(len(a.get("setups", [])) for a in saida["ativos"].values())
    saida["passam"] = sum(1 for a in saida["ativos"].values() for s in a.get("setups", []) if s["passa"])
    saida["gerado"] = int(time.time() * 1000)
    return saida


# ---------- Diário (sinais dos setups aprovados) ----------

def registrar_e_acompanhar(hl, con, agora):
    """Igual ao cripto: registra os setups aprovados que dispararam no último pregão (no preço
    do contrato agora) e fecha os que bateram stop, alvo ou 20 pregões. Devolve (novos, fechados)."""
    base = con.kv_ler("acoes_swing_base")
    if not base:
        return [], []
    mids = {k: float(v) for k, v in hl.info({"type": "allMids", "dex": acoes.DEX}).items()}
    novos = []
    for m, a in base["ativos"].items():
        if "erro" in a or a["balanco"]["bloqueado"]:
            continue
        for s in a["setups"]:
            if not (s["passa"] and s["ativo_ontem"]):
                continue
            chave = f"{s['id']}:{a['ultimo_pregao']}"
            if con.execute("SELECT 1 FROM acoes_swing_sinais WHERE origem=? AND moeda=?", (chave, m)).fetchone():
                continue
            px = mids.get(m)
            if not px:
                continue
            risco = fase4.STOP_ATR * a["contexto"]["atr"]
            long = s["lado"] == "long"
            stop = px - risco if long else px + risco
            alvo = px + fase4.ALVO_R * risco if long else px - fase4.ALVO_R * risco
            con.execute("INSERT INTO acoes_swing_sinais (origem, setup, moeda, lado, aberto_em, preco_abertura, stop, alvo) "
                        "VALUES (?,?,?,?,?,?,?,?)", (chave, s["id"], m, s["lado"], agora, px, stop, alvo))
            novos.append({"moeda": m.split(":", 1)[1], "lado": s["lado"], "nome": s["nome"], "entrada": px, "stop": stop,
                          "alvo": alvo, "n": s["n"], "acerto": s["acerto"], "mediana": s["mediana"],
                          "media_fora": s["media_fora"]})
    fechados = []
    for s in con.execute("SELECT * FROM acoes_swing_sinais WHERE fechado_em IS NULL").fetchall():
        long = s["lado"] == "long"
        risco = abs(s["preco_abertura"] - s["stop"])
        saida = None
        for v in hl.velas(s["moeda"], "1h", s["aberto_em"], agora):
            hi, lo = float(v["h"]), float(v["l"])
            if (long and lo <= s["stop"]) or (not long and hi >= s["stop"]):
                saida = s["stop"]
                break
            if (long and hi >= s["alvo"]) or (not long and lo <= s["alvo"]):
                saida = s["alvo"]
                break
        if saida is None and agora - s["aberto_em"] >= MAX_DIAS_CORRIDOS * DIA:
            saida = mids.get(s["moeda"])
        if saida is None:
            continue
        sinal = 1 if long else -1
        r = sinal * (saida - s["preco_abertura"]) / risco - fase4.CUSTO * s["preco_abertura"] / risco
        ret = sinal * (saida / s["preco_abertura"] - 1) - fase4.CUSTO
        con.execute("UPDATE acoes_swing_sinais SET fechado_em=?, preco_fechamento=?, retorno=?, r=? WHERE id=?",
                    (agora, saida, ret, r, s["id"]))
        fechados.append({"moeda": s["moeda"].split(":", 1)[1], "lado": s["lado"], "entrada": s["preco_abertura"],
                         "saida": saida, "r": r, "retorno": ret,
                         "motivo": "alvo" if saida == s["alvo"] else "stop" if saida == s["stop"] else "tempo (20 pregões)"})
    con.commit()
    return novos, fechados


def painel(con, ativos, mapas, ctx):
    """Dados da aba Swing das ações (mesma montagem do cripto) + sinais do Diário."""
    base = con.kv_ler("acoes_swing_base")
    if not base:
        return None
    f2 = {m: {"liquidez": L} for m, L in mapas.items()}
    out = fase4.painel(con, ativos, f2, base=base, ordem=base.get("ordem"))
    out["gerado"] = base.get("gerado")
    tks = {a["t"]: a for a in ativos}
    for a in out["ativos"]:
        a["tk"] = a["t"].split(":", 1)[1]
        a["nome"] = acoes.NOMES.get(a["tk"])
        a["setor"] = acoes.SETOR.get(a["tk"])
        if a["t"] not in tks:
            a.setdefault("erro", "fora do universo hoje")
    mids = {m: float(c["markPx"]) for m, c in ctx.items()}
    sinais = []
    for s in con.execute("SELECT * FROM acoes_swing_sinais ORDER BY aberto_em DESC LIMIT 200"):
        s = dict(s)
        if s["fechado_em"] is None and mids.get(s["moeda"]):
            sinal = 1 if s["lado"] == "long" else -1
            s["agora"] = sinal * (mids[s["moeda"]] / s["preco_abertura"] - 1) - fase4.CUSTO
        s["moeda"] = s["moeda"].split(":", 1)[1]
        sinais.append(s)
    out["sinais"] = sinais
    return out


# ---------- Setores e força ----------

PESOS = ((63, 0.4), (126, 0.2), (189, 0.2), (252, 0.2))   # 3, 6, 9 e 12 meses (pregões)


def _ret(c, i, n):
    return c[i] / c[i - n] - 1 if i - n >= 0 else None


def _nota(c, i, sp_c, sp_i):
    """Força relativa: soma ponderada do retorno acima do S&P 500 em 3, 6, 9 e 12 meses."""
    tot = 0.0
    for n, w in PESOS:
        a, b = _ret(c, i, n), _ret(sp_c, sp_i, n)
        if a is None or b is None:
            return None
        tot += w * (a - b)
    return tot


def _sma(c, n):
    return st.fmean(c[-n:]) if len(c) >= n else None


def teste_forca(series, sp):
    """Todo mês (21 pregões do S&P): ordena os papéis pela nota de força e mede o mês seguinte
    (acima do S&P) do terço mais forte contra o terço mais fraco. Só usa o que se sabia no dia."""
    sp_dias, sp_c = sp
    idx = {tk: (dias, c) for tk, (dias, c) in series.items()}
    meses = []
    for i in range(252, len(sp_dias) - 21, 21):
        dia, dia_fut = sp_dias[i], sp_dias[i + 21]
        notas = []
        for tk, (dias, c) in idx.items():
            k = bisect.bisect_right(dias, dia) - 1
            kf = bisect.bisect_right(dias, dia_fut) - 1
            if k < 252 or kf <= k or (date.fromisoformat(dia) - date.fromisoformat(dias[k])).days > 5:
                continue
            nota = _nota(c, k, sp_c, i)
            if nota is None:
                continue
            notas.append((nota, c[kf] / c[k] - 1 - (sp_c[i + 21] / sp_c[i] - 1)))
        if len(notas) < 6:
            continue
        notas.sort(key=lambda x: -x[0])
        t = len(notas) // 3
        fortes, fracos = [x[1] for x in notas[:t]], [x[1] for x in notas[-t:]]
        meses.append({"dia": dia, "n": len(notas), "fortes": st.fmean(fortes), "fracos": st.fmean(fracos)})
    if not meses:
        return None
    dif = [m["fortes"] - m["fracos"] for m in meses]
    fora = dif[int(len(dif) * (1 - fase4.FORA_DA_AMOSTRA)):]
    return {"meses": len(meses), "desde": meses[0]["dia"], "papeis_mediana": st.median(m["n"] for m in meses),
            "fortes_media": st.fmean(m["fortes"] for m in meses), "fracos_media": st.fmean(m["fracos"] for m in meses),
            "dif_mediana": st.median(dif), "dif_media": st.fmean(dif),
            "fortes_ganham": sum(1 for x in dif if x > 0) / len(dif),
            "dif_media_fora": st.fmean(fora) if fora else None, "n_fora": len(fora),
            "ultimos": [[m["dia"], round(m["fortes"] - m["fracos"], 4)] for m in meses[-12:]]}


def calcular_forca(hl):
    meta = hl.info({"type": "meta", "dex": acoes.DEX})
    vivos = sorted({u["name"].split(":", 1)[1] for u in meta["universe"] if not u.get("isDelisted")})
    sp = velas_bolsa("SP500")
    if not sp:
        raise RuntimeError("sem histórico do S&P 500 no Yahoo")
    sp_dias = [datetime.fromtimestamp(t, timezone.utc).date().isoformat() for t in sp["ts"]]
    sp_c = sp["c"]
    papeis, series = [], {}
    for tk in vivos:
        setor = acoes.SETOR.get(tk, "Outras")
        if setor == "Câmbio" or tk == "SP500":   # câmbio contra o S&P não diz nada; o S&P é a régua
            continue
        d = velas_bolsa(tk)
        time.sleep(0.25)
        if not d or len(d["c"]) < 30:
            papeis.append({"tk": tk, "nome": acoes.NOMES.get(tk), "setor": setor, "erro": "sem histórico"})
            continue
        dias = [datetime.fromtimestamp(t, timezone.utc).date().isoformat() for t in d["ts"]]
        c = d["c"]
        series[tk] = (dias, c)
        k = len(c) - 1
        sp_i = bisect.bisect_right(sp_dias, dias[k]) - 1
        rel = lambda n: (None if _ret(c, k, n) is None or _ret(sp_c, sp_i, n) is None
                         else _ret(c, k, n) - _ret(sp_c, sp_i, n))
        s50, s200 = _sma(c, 50), _sma(c, 200)
        papeis.append({"tk": tk, "nome": acoes.NOMES.get(tk), "setor": setor, "fonte": d["fonte"], "pregoes": len(c),
                       "ret_1m": _ret(c, k, 21), "ret_3m": _ret(c, k, 63), "ret_12m": _ret(c, k, 252),
                       "rel_1m": rel(21), "rel_3m": rel(63), "rel_6m": rel(126), "rel_12m": rel(252),
                       "nota": _nota(c, k, sp_c, sp_i),
                       "acima_50": c[-1] > s50 if s50 else None, "acima_200": c[-1] > s200 if s200 else None,
                       "do_topo": c[-1] / max(c[-252:]) - 1, "ultimo": dias[k]})
    com_nota = sorted((p for p in papeis if p.get("nota") is not None), key=lambda p: p["nota"])
    for i, p in enumerate(com_nota):   # percentil 1–99 dentro do grupo xyz
        p["forca"] = round(1 + 98 * i / max(1, len(com_nota) - 1))
    setores = {}
    for p in papeis:
        if "erro" in p:
            continue
        setores.setdefault(p["setor"], []).append(p)
    resumo_setores = []
    for nome, ps in setores.items():
        fs = [p["forca"] for p in ps if p.get("forca") is not None]
        a200 = [p["acima_200"] for p in ps if p["acima_200"] is not None]
        r3 = [p["rel_3m"] for p in ps if p["rel_3m"] is not None]
        lider = max((p for p in ps if p.get("forca") is not None), key=lambda p: p["forca"], default=None)
        resumo_setores.append({"setor": nome, "n": len(ps), "forca_mediana": st.median(fs) if fs else None,
                               "rel_3m_mediana": st.median(r3) if r3 else None,
                               "acima_200": sum(a200) / len(a200) if a200 else None,
                               "lider": lider["tk"] if lider else None})
    resumo_setores.sort(key=lambda s: -(s["forca_mediana"] or -1))
    teste = teste_forca({tk: v for tk, v in series.items() if acoes.SETOR.get(tk) != "Commodities"}, (sp_dias, sp_c))
    return {"gerado": int(time.time() * 1000), "sp500": {"ultimo": sp_dias[-1], "ret_1m": _ret(sp_c, len(sp_c) - 1, 21),
                                                         "ret_3m": _ret(sp_c, len(sp_c) - 1, 63),
                                                         "ret_12m": _ret(sp_c, len(sp_c) - 1, 252),
                                                         "acima_200": sp_c[-1] > _sma(sp_c, 200)},
            "papeis": sorted(papeis, key=lambda p: -(p.get("forca") or -1)), "setores": resumo_setores,
            "teste": teste, "pesos": [[n, w] for n, w in PESOS]}


# ---------- tudo junto ----------

def executar(con=None, hl=None):
    con = con or conectar()
    hl = hl or Hyperliquid()
    t0 = time.time()
    base = calcular_base(con, hl)
    con.kv_gravar("acoes_swing_base", base)
    log(f"swing: {base['passam']} de {base['testes']} testes passam ({time.time() - t0:.0f} s)")
    t0 = time.time()
    forca = calcular_forca(hl)
    con.kv_gravar("acoes_forca", forca)
    log(f"força: {len(forca['papeis'])} papéis, {len(forca['setores'])} setores ({time.time() - t0:.0f} s)")
    return base, forca


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--se-velho", type=float, default=None)
    a = ap.parse_args()
    con = conectar()
    b = con.kv_ler("acoes_swing_base")
    if a.se_velho is not None and b and b.get("ids") == [s["id"] for s in fase4.SETUPS] \
            and time.time() * 1000 - b.get("gerado", 0) < a.se_velho * 3_600_000:
        return
    inicio = time.time()
    ok, det = True, ""
    try:
        executar(con)
        det = f"{(time.time() - inicio) / 60:.0f} min"
    except Exception as e:
        ok, det = False, repr(e)
        raise
    finally:
        try:
            lista = (con.kv_ler("execucoes") or [])[-199:]
            lista.append({"tempo": int(time.time() * 1000), "tipo": "swing_acoes",
                          "origem": "github" if NA_NUVEM else "pc", "ok": ok, "detalhe": det[:200]})
            con.kv_gravar("execucoes", lista)
        except Exception:
            pass


if __name__ == "__main__":
    main()
