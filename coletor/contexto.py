"""Contexto das carteiras e do mercado, acrescentado depois do vídeo de 07/10/2026:

- histórico de open interest e funding (a Hyperliquid não guarda; começamos a gravar);
- posição somada dos formadores de mercado por ativo, para testar a tese do vídeo
  ("formador vendido = o ativo tende a subir") com dados, e não na palavra;
- rótulos nos alertas: short protegido com a moeda à vista (delta neutro),
  alavancagem mínima e carteira nova.
"""
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

DIA = 86_400_000
OI_MINIMO = 5_000_000        # guarda o histórico só dos perps com mais de US$ 5 mi em aberto
FORMADORES = 60              # quantos formadores de mercado acompanhar
NOVA_DIAS = 90               # conta com menos de 90 dias de vida = carteira nova


# ---------- histórico de mercado ----------

def gravar_mercado(hl, con, agora):
    meta, ctxs = hl.info({"type": "metaAndAssetCtxs"})
    linhas = []
    for u, c in zip(meta["universe"], ctxs):
        try:
            px = float(c["markPx"])
            oi = float(c["openInterest"]) * px
        except (TypeError, ValueError, KeyError):
            continue
        if oi >= OI_MINIMO:
            linhas.append((agora, u["name"], px, oi, float(c["funding"]) * 24 * 365 * 100))
    con.executemany("INSERT INTO mercado_hist VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING", linhas)
    con.commit()
    return len(linhas)


# ---------- formadores de mercado ----------

def escolher_formadores(linhas_leaderboard):
    """Carteiras que giram mais de 150x a conta no mês e negociaram US$ 300 mi ou mais:
    perfil de formador de mercado ou robô de alta frequência."""
    cands = []
    for r in linhas_leaderboard:
        mes = {w: v for w, v in r["windowPerformances"]}["month"]
        conta, vol = float(r["accountValue"]), float(mes["vlm"])
        if conta >= 50_000 and vol >= 300_000_000 and vol / conta >= 150:
            cands.append({"endereco": r["ethAddress"], "volume_mes": vol, "conta": conta})
    return sorted(cands, key=lambda c: -c["volume_mes"])[:FORMADORES]


def gravar_formadores(hl, con, agora):
    lista = con.kv_ler("formadores") or []
    if not lista:
        return 0

    def uma(end):
        try:
            return hl.estado(end)
        except RuntimeError:
            return None
    with ThreadPoolExecutor(8) as ex:
        estados = list(ex.map(uma, [f["endereco"] for f in lista]))
    soma = defaultdict(lambda: [0.0, 0.0, 0])
    for est in estados:
        if not est:
            continue
        for ap in est.get("assetPositions", []):
            p = ap["position"]
            tam = float(p["szi"])
            if not tam:
                continue
            valor = abs(float(p["positionValue"]))
            s = soma[p["coin"]]
            s[0 if tam > 0 else 1] += valor
            s[2] += 1
    linhas = [(agora, m, lo, sh, n) for m, (lo, sh, n) in soma.items() if lo + sh >= 100_000]
    con.executemany("INSERT INTO formadores_pos VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING", linhas)
    con.commit()
    return len(linhas)


# ---------- rótulos dos alertas ----------

def _saldo_a_vista(hl, end, moeda):
    """Quantidade da moeda à vista na Hyperliquid (o BTC à vista se chama UBTC, o ETH, UETH...)."""
    try:
        s = hl.info({"type": "spotClearinghouseState", "user": end})
    except RuntimeError:
        return 0.0
    nomes = {moeda, "U" + moeda}
    return sum(float(b["total"]) for b in s.get("balances", []) if b["coin"] in nomes)


def rotulos(hl, con, end, moeda, lado, tamanho, posicao, agora):
    """Rótulos que mudam a leitura de um alerta. `posicao` é a posição atual (ou None)."""
    out = []
    if lado == "short" and tamanho:
        if _saldo_a_vista(hl, end, moeda) >= 0.5 * tamanho:
            out.append("delta neutro")
        elif posicao and posicao.get("preco_liquidacao") and posicao.get("preco_entrada") \
                and posicao["preco_liquidacao"] >= 2 * posicao["preco_entrada"]:
            out.append("alavancagem mínima")
    r = con.execute("SELECT primeira_atividade FROM carteiras WHERE endereco=?", (end,)).fetchone()
    if r and r["primeira_atividade"] and agora - r["primeira_atividade"] < NOVA_DIAS * DIA:
        out.append("carteira nova")
    return out


# ---------- idade das carteiras ----------

def preencher_idades(hl, con, enderecos, maximo=150):
    """Data da primeira atividade da conta (histórico 'allTime' do portfólio). Só busca quem
    ainda não tem; no máximo `maximo` por dia para não pesar na API."""
    ja = {r["endereco"] for r in con.execute("SELECT endereco FROM carteiras WHERE primeira_atividade IS NOT NULL")}
    faltam = [e for e in enderecos if e not in ja]
    n = 0
    for end in faltam[:maximo]:
        try:
            p = dict(hl.info({"type": "portfolio", "user": end}))
        except (RuntimeError, ValueError, TypeError):
            continue
        hist = (p.get("allTime") or {}).get("accountValueHistory") or []
        if hist:
            con.execute("UPDATE carteiras SET primeira_atividade=? WHERE endereco=?", (int(hist[0][0]), end))
            n += 1
    con.commit()
    return n, len(faltam)


# ---------- dados para o painel ----------

def painel(con, agora, ativos):
    ult = con.execute("SELECT MAX(tempo) FROM formadores_pos").fetchone()[0]
    desde_f = con.execute("SELECT MIN(tempo) FROM formadores_pos").fetchone()[0]
    formadores = None
    if ult:
        antes = con.execute("SELECT MAX(tempo) FROM formadores_pos WHERE tempo<=?", (ult - DIA + 3_600_000,)).fetchone()[0]
        net_antes = {r["moeda"]: r["long_usd"] - r["short_usd"] for r in
                     con.execute("SELECT * FROM formadores_pos WHERE tempo=?", (antes,))} if antes else {}
        linhas = [{"moeda": r["moeda"], "long": r["long_usd"], "short": r["short_usd"], "carteiras": r["carteiras"],
                   "liquido": r["long_usd"] - r["short_usd"], "liquido_24h": net_antes.get(r["moeda"])}
                  for r in con.execute("SELECT * FROM formadores_pos WHERE tempo=?", (ult,))]
        linhas.sort(key=lambda x: -abs(x["liquido"]))
        formadores = {"tempo": ult, "desde": desde_f, "acompanhadas": len(con.kv_ler("formadores") or []),
                      "moedas": linhas[:14]}
    hist = {}
    desde_m = con.execute("SELECT MIN(tempo) FROM mercado_hist").fetchone()[0]
    for a in ativos:
        hist[a["t"]] = [[r["tempo"], round(r["oi_usd"]), round(r["funding"], 2), r["preco"]] for r in con.execute(
            "SELECT tempo, oi_usd, funding, preco FROM mercado_hist WHERE moeda=? AND tempo>=? ORDER BY tempo",
            (a["t"], agora - 45 * DIA))]
    return {"formadores": formadores, "oi_hist": {"desde": desde_m, "series": hist}}
