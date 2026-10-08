"""Amostra de varejo para o mapa de stops e liquidações.

As carteiras do ranking são traders bons e ativos; para saber onde estão os stops e as
liquidações "do varejo" é preciso uma amostra grande de contas comuns. Escolhemos até
8 mil contas pequenas do leaderboard (US$ 1 mil a 100 mil, com movimento no mês) e
lemos em rodízio: ~600 posições por coleta (as lidas há mais tempo primeiro) e as
ordens de ~60 delas que têm posição nos 6 ativos. Em ~14 h a amostra inteira é lida.
"""
import hashlib
from concurrent.futures import ThreadPoolExecutor

ATIVOS = ("BTC", "ETH", "SOL", "XRP", "HYPE", "NEAR")
AMOSTRA = 8000
POSICOES_POR_COLETA = 600
ORDENS_POR_COLETA = 60
HORA = 3_600_000


def escolher(con, linhas_leaderboard):
    """Sorteio estável (pelo hash do endereço) entre as contas pequenas e ativas."""
    cands = []
    for r in linhas_leaderboard:
        mes = {w: v for w, v in r["windowPerformances"]}["month"]
        conta, vol = float(r["accountValue"]), float(mes["vlm"])
        if 1_000 <= conta <= 100_000 and vol >= 20_000:
            cands.append(r["ethAddress"])
    cands.sort(key=lambda e: hashlib.sha1(e.encode()).hexdigest())
    escolhidas = cands[:AMOSTRA]
    con.execute("UPDATE varejo_lido SET ativo=0")
    con.executemany("INSERT INTO varejo_lido (endereco, ativo) VALUES (?,1) "
                    "ON CONFLICT (endereco) DO UPDATE SET ativo=1", [(e,) for e in escolhidas])
    con.commit()
    return len(escolhidas)


def _em_lotes(con, sql, enderecos, n=200):
    for i in range(0, len(enderecos), n):
        lote = enderecos[i:i + n]
        con.execute(sql.format(",".join("?" * len(lote))), lote)


def ler_posicoes(hl, con, agora):
    ends = [r["endereco"] for r in con.execute(
        "SELECT endereco FROM varejo_lido WHERE ativo=1 ORDER BY COALESCE(posicoes_em, 0) LIMIT ?",
        (POSICOES_POR_COLETA,))]
    if not ends:
        return 0, 0

    def uma(end):
        try:
            return end, hl.estado(end)
        except RuntimeError:
            return end, None
    with ThreadPoolExecutor(8) as ex:
        lidas = [(e, s) for e, s in ex.map(uma, ends) if s is not None]
    linhas = []
    for end, est in lidas:
        for ap in est.get("assetPositions", []):
            p = ap["position"]
            tam = float(p["szi"])
            if tam:
                linhas.append((end, p["coin"], "long" if tam > 0 else "short", abs(tam), float(p["entryPx"]),
                               float(p["liquidationPx"]) if p.get("liquidationPx") else None, agora))
    feitas = [e for e, _ in lidas]
    _em_lotes(con, "DELETE FROM varejo_posicoes WHERE endereco IN ({})", feitas)
    con.executemany("INSERT INTO varejo_posicoes VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", linhas)
    con.executemany("UPDATE varejo_lido SET posicoes_em=? WHERE endereco=?", [(agora, e) for e in feitas])
    con.commit()
    return len(feitas), len(linhas)


def ler_ordens(hl, con, agora):
    marcas = ",".join(f"'{m}'" for m in ATIVOS)
    ends = [r["endereco"] for r in con.execute(
        f"SELECT p.endereco, MIN(COALESCE(l.ordens_em, 0)) AS o FROM varejo_posicoes p "
        f"JOIN varejo_lido l ON l.endereco = p.endereco WHERE p.moeda IN ({marcas}) AND p.coletado >= ? "
        f"GROUP BY p.endereco ORDER BY o LIMIT ?", (agora - 24 * HORA, ORDENS_POR_COLETA))]
    if not ends:
        return 0, 0

    def uma(end):
        try:
            return end, hl.ordens(end)
        except RuntimeError:
            return end, None
    with ThreadPoolExecutor(4) as ex:
        lidas = [(e, o) for e, o in ex.map(uma, ends) if o is not None]
    linhas = []
    for end, ordens in lidas:
        for o in ordens:
            gat = bool(o.get("isTrigger"))
            linhas.append((end, o["coin"], o["oid"], o.get("orderType") or "Limit", o["side"],
                           float(o["triggerPx"] if gat else o["limitPx"]), float(o["sz"]), int(gat), agora))
    feitas = [e for e, _ in lidas]
    _em_lotes(con, "DELETE FROM varejo_ordens WHERE endereco IN ({})", feitas)
    con.executemany("INSERT INTO varejo_ordens VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", linhas)
    con.executemany("UPDATE varejo_lido SET ordens_em=? WHERE endereco=?", [(agora, e) for e in feitas])
    con.commit()
    return len(feitas), len(linhas)


def limpar(con, agora):
    con.execute("DELETE FROM varejo_posicoes WHERE coletado < ?", (agora - 36 * HORA,))
    con.execute("DELETE FROM varejo_ordens WHERE coletado < ?", (agora - 48 * HORA,))
    con.commit()
