"""Ações, índices e commodities da Hyperliquid (grupo HIP-3 "xyz"): coleta e dados do painel.

Fase 1 (09/10/2026): posições e ordens (stops e alvos) das carteiras nos 20 mercados mais
líquidos do xyz, o mercado de cada um e o mapa de stops e liquidações. Tudo fica em tabelas
próprias (acoes_*): os alertas, o Diário e o ranking de cripto continuam olhando só o grupo
principal, e um erro aqui não para a coleta de cripto.

Na API, posições e ordens do xyz só aparecem pedindo dex="xyz"; os nomes vêm com prefixo
("xyz:MU"). Os contratos negociam 24 h, 7 dias por semana, mas a ação de verdade só negocia
no pregão da bolsa dela: fora dele o preço é dos próprios traders da Hyperliquid e pode
abrir com salto no pregão seguinte.
"""
import math
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import fase2

DEX = "xyz"
N_MERCADOS = 20
MARGEM = 28                # quem já está na lista só sai se cair abaixo do 28º (evita troca diária por ruído)
LER_COM_ACAO = 500         # por coleta: carteiras que tinham posição no xyz na última leitura, as mais antigas primeiro
LER_DESCOBERTA = 300       # + carteiras ainda sem posição, para achar quem passou a operar ações
ORDENS_POR_COLETA = 150    # ordens pesam 10x mais que posições na API
ORDENS_INTERVALO_H = 3     # não relê as ordens de uma carteira lidas há menos de 3 h
FUNDING_BASE = 5.475       # % a.a.: taxa fixa do xyz (0,000625% por hora); igual a ela não diz nada
HORA = 3_600_000
DIA = 86_400_000

SETORES = {
    "Índices e ETFs": "SP500 XYZ100 JP225 KR200 EWJ EWT EWY EWZ KORU MAGS XBI XLE TLT URNM",
    "Commodities": "GOLD SILVER CL BRENTOIL NATGAS COPPER PLATINUM PALLADIUM HO",
    "Câmbio": "EUR GBP JPY",
    "Chips e memória": "NVDA MU SNDK SKHX SKHY DRAM SOXL SMH INTC AMD TSM SMSN CXMT AVGO ARM MRVL WDC QCOM "
                       "ASML AAOI AMAT LRCX UMC KIOXIA GIGADEV LITE CBRS",
    "Tecnologia": "AAPL MSFT GOOGL AMZN META TSLA ORCL NFLX IBM NOW PLTR CRWD NET DELL CRWV NBIS",
    "Ações de cripto": "CRCL MSTR COIN HOOD BMNR IREN",
}
SETOR = {t: s for s, ts in SETORES.items() for t in ts.split()}
NOMES = {
    "SP500": "S&P 500", "XYZ100": "Nasdaq 100 (índice da XYZ)", "JP225": "Nikkei 225", "KR200": "Kospi 200",
    "EWZ": "ETF de ações do Brasil", "MAGS": "ETF das 7 gigantes", "TLT": "ETF de títulos longos dos EUA",
    "XLE": "ETF de energia", "SMH": "ETF de semicondutores", "SOXL": "ETF de semicondutores 3x",
    "GOLD": "Ouro", "SILVER": "Prata", "CL": "Petróleo WTI", "BRENTOIL": "Petróleo Brent", "NATGAS": "Gás natural",
    "COPPER": "Cobre", "PLATINUM": "Platina", "PALLADIUM": "Paládio", "HO": "Óleo de aquecimento",
    "EUR": "Euro", "GBP": "Libra", "JPY": "Iene",
    "NVDA": "Nvidia", "MU": "Micron", "SNDK": "SanDisk", "SKHX": "SK hynix (ação na Coreia)",
    "SKHY": "SK hynix (ADR na Nasdaq)", "INTC": "Intel", "AMD": "AMD", "TSM": "TSMC", "SMSN": "Samsung",
    "AVGO": "Broadcom", "ARM": "Arm", "MRVL": "Marvell", "WDC": "Western Digital", "QCOM": "Qualcomm",
    "ASML": "ASML", "AMAT": "Applied Materials", "LRCX": "Lam Research", "KIOXIA": "Kioxia", "CBRS": "Cerebras",
    "AAPL": "Apple", "MSFT": "Microsoft", "GOOGL": "Alphabet", "AMZN": "Amazon", "META": "Meta", "TSLA": "Tesla",
    "ORCL": "Oracle", "NFLX": "Netflix", "IBM": "IBM", "PLTR": "Palantir", "CRWV": "CoreWeave", "NBIS": "Nebius",
    "CRCL": "Circle", "MSTR": "Strategy", "COIN": "Coinbase", "HOOD": "Robinhood", "SPCX": "SpaceX",
}
# bolsa de cada mercado; o resto negocia em Nova York
SEUL = {"SKHX", "SMSN", "HYUNDAI", "KR200"}
TOQUIO = {"JP225", "KIOXIA", "SOFTBANK"}


# ---------- horário das bolsas ----------

def _hora_ny(ms):
    """Hora de Nova York (horário de verão dos EUA: do 2º domingo de março ao 1º de novembro)."""
    utc = datetime.fromtimestamp(ms / 1000, timezone.utc)

    def domingo(mes, n):
        d = datetime(utc.year, mes, 1, tzinfo=timezone.utc)
        return d + timedelta(days=(6 - d.weekday()) % 7 + 7 * (n - 1))
    verao = domingo(3, 2) + timedelta(hours=7) <= utc < domingo(11, 1) + timedelta(hours=6)
    return utc - timedelta(hours=4 if verao else 5)


def _h(t):
    return t.hour + t.minute / 60


def pregao_ny(ms):
    """Bolsa de Nova York: 9h30 às 16h, segunda a sexta (feriados não entram na conta)."""
    t = _hora_ny(ms)
    return t.weekday() < 5 and 9.5 <= _h(t) < 16


def cme(ms):
    """Futuros (commodities e câmbio): domingo 18h a sexta 17h em Nova York, pausa diária das 17h às 18h."""
    t = _hora_ny(ms)
    d, h = t.weekday(), _h(t)
    if d == 5 or (d == 6 and h < 18) or (d == 4 and h >= 17):
        return False
    return not 17 <= h < 18


def _asia(ms):
    """Seul e Tóquio: 9h às 15h30 locais (UTC+9, sem horário de verão), segunda a sexta."""
    t = datetime.fromtimestamp(ms / 1000, timezone.utc) + timedelta(hours=9)
    return t.weekday() < 5 and 9 <= _h(t) < 15.5


SESSOES = {"Nova York": pregao_ny, "Futuros": cme, "Seul": _asia, "Tóquio": _asia}


def sessao_de(tk):
    setor = SETOR.get(tk)
    if setor in ("Commodities", "Câmbio"):
        return "Futuros"
    return "Seul" if tk in SEUL else "Tóquio" if tk in TOQUIO else "Nova York"


def _proxima_mudanca(fn, ms):
    """Quando a bolsa abre (se fechada) ou fecha (se aberta), em passos de 15 min."""
    agora = fn(ms)
    t = (ms // 900_000 + 1) * 900_000
    for _ in range(4 * 24 * 5):
        if fn(t) != agora:
            return t
        t += 900_000
    return None


# ---------- universo: os 20 mais líquidos ----------

def _contextos(hl):
    meta, ctxs = hl.info({"type": "metaAndAssetCtxs", "dex": DEX})
    return {u["name"]: c for u, c in zip(meta["universe"], ctxs) if not u.get("isDelisted")}


def universo(con, ctx, agora):
    """Liquidez = raiz de (open interest × volume de 24 h). Refeito uma vez por dia."""
    hoje = time.strftime("%Y-%m-%d", time.gmtime(agora / 1000))
    salvo = con.kv_ler("acoes_universo")
    if salvo and salvo.get("dia") == hoje:
        return [m for m in salvo["moedas"] if m in ctx]

    def liquidez(c):
        try:
            return math.sqrt(float(c["openInterest"]) * float(c["markPx"]) * float(c["dayNtlVlm"]))
        except (TypeError, ValueError, KeyError):
            return 0.0
    ordem = sorted(ctx, key=lambda m: -liquidez(ctx[m]))
    antes = (salvo or {}).get("moedas") or []
    ficam = [m for m in antes if m in ordem[:MARGEM]]
    moedas = sorted((ficam + [m for m in ordem if m not in ficam])[:N_MERCADOS], key=ordem.index)
    con.kv_gravar("acoes_universo", {"dia": hoje, "moedas": moedas,
                                     "liquidez": {m: round(liquidez(ctx[m])) for m in moedas}})
    return moedas


# ---------- coleta ----------

def _em_lotes(con, sql, enderecos, n=200):
    for i in range(0, len(enderecos), n):
        lote = enderecos[i:i + n]
        con.execute(sql.format(",".join("?" * len(lote))), lote)


# carteiras lidas: a amostra ampla do mapa de cripto (até 10 mil contas) + as do ranking
POOL = "(SELECT endereco FROM varejo_lido WHERE ativo=1 UNION SELECT endereco FROM fotos)"


def ler_posicoes(hl, con, agora):
    com = [r["endereco"] for r in con.execute(
        f"SELECT endereco FROM acoes_lido WHERE tem_acao=1 AND endereco IN {POOL} "
        "ORDER BY posicoes_em LIMIT ?", (LER_COM_ACAO,))]
    sem = [r["endereco"] for r in con.execute(
        f"SELECT e.endereco FROM {POOL} e LEFT JOIN acoes_lido a ON a.endereco = e.endereco "
        "WHERE COALESCE(a.tem_acao, 0) = 0 ORDER BY COALESCE(a.posicoes_em, 0) LIMIT ?",
        (LER_COM_ACAO + LER_DESCOBERTA - len(com),))]

    def uma(end):
        try:
            return end, hl.estado(end, DEX)
        except RuntimeError:
            return end, None
    with ThreadPoolExecutor(8) as ex:
        lidas = [(e, s) for e, s in ex.map(uma, com + sem) if s is not None]
    linhas, tem = [], set()
    for end, est in lidas:
        for ap in est.get("assetPositions", []):
            p = ap["position"]
            tam = float(p["szi"])
            if not tam:
                continue
            linhas.append((end, p["coin"], "long" if tam > 0 else "short", abs(tam), float(p["entryPx"]),
                           float(p["leverage"]["value"]), float(p["unrealizedPnl"]),
                           float(p["liquidationPx"]) if p.get("liquidationPx") else None,
                           abs(float(p["positionValue"])), agora))
            tem.add(end)
    feitas = [e for e, _ in lidas]
    _em_lotes(con, "DELETE FROM acoes_posicoes WHERE endereco IN ({})", feitas)
    con.executemany("INSERT INTO acoes_posicoes VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", linhas)
    con.executemany("INSERT INTO acoes_lido (endereco, posicoes_em, tem_acao) VALUES (?,?,?) ON CONFLICT (endereco) "
                    "DO UPDATE SET posicoes_em=excluded.posicoes_em, tem_acao=excluded.tem_acao",
                    [(e, agora, int(e in tem)) for e in feitas])
    con.commit()
    return len(feitas), len(tem), len(linhas)


def ler_ordens(hl, con, moedas, agora):
    """Ordens das carteiras com posição nos mercados acompanhados, as lidas há mais tempo primeiro."""
    if not moedas:
        return 0, 0
    ends = [r["endereco"] for r in con.execute(
        "SELECT DISTINCT p.endereco, COALESCE(a.ordens_em, 0) AS o FROM acoes_posicoes p "
        "JOIN acoes_lido a ON a.endereco = p.endereco "
        f"WHERE p.moeda IN ({','.join('?' * len(moedas))}) AND p.coletado >= ? AND COALESCE(a.ordens_em, 0) < ? "
        "ORDER BY o LIMIT ?", (*moedas, agora - 24 * HORA, agora - ORDENS_INTERVALO_H * HORA, ORDENS_POR_COLETA))]

    def uma(end):
        try:
            return end, hl.ordens(end, DEX)
        except RuntimeError:
            return end, None
    with ThreadPoolExecutor(4) as ex:
        lidas = [(e, o) for e, o in ex.map(uma, ends) if o is not None]
    linhas = []
    for end, ordens in lidas:
        for o in ordens:
            gat = bool(o.get("isTrigger"))
            linhas.append((end, o["coin"], o["oid"], o.get("orderType") or "Limit", o["side"],
                           float(o["triggerPx"] if gat else o["limitPx"]), float(o["sz"]), int(gat),
                           int(bool(o.get("reduceOnly"))), agora))
    feitas = [e for e, _ in lidas]
    _em_lotes(con, "DELETE FROM acoes_ordens WHERE endereco IN ({})", feitas)
    con.executemany("INSERT INTO acoes_ordens VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", linhas)
    con.executemany("UPDATE acoes_lido SET ordens_em=? WHERE endereco=?", [(agora, e) for e in feitas])
    con.commit()
    return len(feitas), len(linhas)


def coletar(hl, con, agora):
    moedas = universo(con, _contextos(hl), agora)
    lp = ler_posicoes(hl, con, agora)
    lo = ler_ordens(hl, con, moedas, agora)
    con.execute("DELETE FROM acoes_posicoes WHERE coletado < ?", (agora - 36 * HORA,))
    con.execute("DELETE FROM acoes_ordens WHERE coletado < ?", (agora - 48 * HORA,))
    con.commit()
    return (f"{lp[0]} carteiras lidas ({lp[1]} com posição no xyz, {lp[2]} posições) · "
            f"ordens de {lo[0]} ({lo[1]} ordens)")


# ---------- dados do painel ----------

def _tendencias(hl, con, moedas, agora, tendencia_diaria):
    """Tendência do diário: muda uma vez por dia, fica guardada e só busca os mercados novos."""
    hoje = time.strftime("%Y-%m-%d", time.gmtime(agora / 1000))
    salvo = con.kv_ler("acoes_tendencia") or {}
    if salvo.get("dia") != hoje:
        salvo = {"dia": hoje, "ativos": {}}
    faltam = [m for m in moedas if m not in salvo["ativos"]]
    for m in faltam:
        velas = hl.velas(m, "1d", agora - 320 * DIA, agora)
        d, por_que = tendencia_diaria(velas)
        salvo["ativos"][m] = [d, por_que, len(velas)]
    if faltam:
        con.kv_gravar("acoes_tendencia", salvo)
    return salvo["ativos"]


def _amostra(con, agora):
    um = lambda sql, *a: con.execute(sql, a).fetchone()[0] or 0
    return {"pool": um(f"SELECT COUNT(*) FROM {POOL} e"),
            "lidas": um("SELECT COUNT(*) FROM acoes_lido"),
            "lidas_24h": um("SELECT COUNT(*) FROM acoes_lido WHERE posicoes_em >= ?", agora - DIA),
            "com_acao": um("SELECT COUNT(*) FROM acoes_lido WHERE tem_acao=1"),
            "com_posicao_24h": um("SELECT COUNT(DISTINCT endereco) FROM acoes_posicoes WHERE coletado >= ?", agora - DIA),
            "ordens_36h": um("SELECT COUNT(DISTINCT endereco) FROM acoes_ordens WHERE coletado >= ?", agora - 36 * HORA),
            "tempo": agora}


def painel(hl, con, agora):
    # importado aqui: gerar_painel importa este módulo
    from gerar_painel import FRASES, leitura_4h, tendencia_diaria
    ctx = _contextos(hl)
    moedas = universo(con, ctx, agora)
    diarias = _tendencias(hl, con, moedas, agora, tendencia_diaria)

    lados = {}
    for r in con.execute("SELECT moeda, lado, COUNT(*) AS n, SUM(valor) AS v FROM acoes_posicoes "
                         "WHERE coletado >= ? GROUP BY moeda, lado", (agora - DIA,)):
        s = lados.setdefault(r["moeda"], {"L": 0, "S": 0, "vL": 0.0, "vS": 0.0})
        s["L" if r["lado"] == "long" else "S"] += r["n"]
        s["vL" if r["lado"] == "long" else "vS"] += r["v"] or 0.0

    sessoes = {k: {"aberta": fn(agora), "muda_em": _proxima_mudanca(fn, agora)} for k, fn in SESSOES.items()}
    ativos, mapas, hist, liq_hist = [], {}, [], []
    for m in moedas:
        c = ctx[m]
        tk = m.split(":", 1)[1]
        px, ontem = float(c["markPx"]), float(c["prevDayPx"])
        oi = float(c["openInterest"]) * px
        funding = float(c["funding"]) * 24 * 365 * 100
        d, d_por_que, dias = (diarias.get(m) or ["flat", "sem histórico", 0])[:3]
        velas4 = hl.velas(m, "4h", agora - 90 * DIA, agora)
        if velas4:
            h, lo, hi, vol, amp = leitura_4h(velas4)
            de_hoje = [v for v in velas4 if v["t"] >= agora // DIA * DIA] or velas4[-1:]
            lo_hoje, hi_hoje = min(float(v["l"]) for v in de_hoje), max(float(v["h"]) for v in de_hoje)
        else:
            h, lo, hi, vol, amp, lo_hoje, hi_hoje = "flat", px, px, None, 1.0, px, px
        ses = sessao_de(tk)
        aberta = sessoes[ses]["aberta"]
        frase = FRASES[(d, h)]   # o site acrescenta o aviso de bolsa fechada com o horário de quem está vendo
        if aberta and vol is not None and vol < 10:
            frase += " Volume seco: espere o rompimento."
        pos = lados.get(m, {"L": 0, "S": 0, "vL": 0.0, "vS": 0.0})
        ativos.append({"t": m, "tk": tk, "nome": NOMES.get(tk), "setor": SETOR.get(tk, "Outras"),
                       "px": px, "ch": (px / ontem - 1) * 100 if ontem else 0.0, "oraculo": float(c["oraclePx"]),
                       "D": d, "D_por_que": d_por_que, "dias": dias, "H": h, "lo": lo, "hi": hi, "vol": vol,
                       "amp": amp, "lo_hoje": lo_hoje, "hi_hoje": hi_hoje, "funding": funding, "oi": oi,
                       "vol24": float(c["dayNtlVlm"]), "sessao": ses, "aberta": aberta, "frase": frase, "pos": pos})

        posicoes = {r["endereco"]: dict(r) for r in con.execute(
            "SELECT * FROM acoes_posicoes WHERE moeda=? AND coletado >= ?", (m, agora - DIA))}
        ordens = [dict(r) for r in con.execute(
            "SELECT * FROM acoes_ordens WHERE moeda=? AND gatilho=1 AND coletado >= ?", (m, agora - 36 * HORA))]
        L = fase2.mapa_de(posicoes, ordens, px, oi, posicao_inteira=True)
        mapas[m] = L
        hist.append((agora, m, px, oi, funding))
        liq_hist.append((agora, m, px, L["acima"], L["abaixo"], L["acima5"], L["abaixo5"], L["carteiras"]))

    # histórico próprio (a Hyperliquid não guarda): OI, funding e o lado mais carregado de cada mercado
    con.executemany("INSERT INTO mercado_hist VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING", hist)
    con.executemany("INSERT INTO liquidez_hist VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", liq_hist)
    con.commit()
    return {"gerado": agora, "ativos": ativos, "liquidez": mapas, "sessoes": sessoes,
            "funding_base": FUNDING_BASE, "amostra": _amostra(con, agora),
            "universo_dia": (con.kv_ler("acoes_universo") or {}).get("dia")}
