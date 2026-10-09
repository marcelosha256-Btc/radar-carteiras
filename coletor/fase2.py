"""Fase 2: stops e liquidações das carteiras, livro de ofertas e suportes/resistências.

Tudo é agrupado em faixas de preço de ~0,5% (500 no BTC) dentro de ±15% do preço.
"""
import math
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import requests

ATIVOS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "NEAR"]
ALCANCE = 0.15
HORA = 3_600_000


def passo(px):
    """Faixa "redonda" perto de 0,75% do preço: 500 no BTC a 81 mil, 20 no ETH a 2,5 mil
    (o mesmo agrupamento do radar original; faixas mais finas picavam os aglomerados)."""
    alvo = px * 0.0075
    base = 10 ** math.floor(math.log10(alvo))
    return min((base * m for m in (1, 2, 5, 10)), key=lambda s: abs(s - alvo))


def faixa(preco, p):
    return round(math.floor(preco / p) * p, 10)


# ---------- coleta ----------

def coletar_ordens(hl, con, enderecos, agora):
    def uma(end):
        try:
            return end, hl.ordens(end)
        except RuntimeError:
            return end, None
    with ThreadPoolExecutor(4) as ex:
        resultados = list(ex.map(uma, enderecos))
    lidas = [(end, ordens) for end, ordens in resultados if ordens is not None]
    linhas = []
    for end, ordens in lidas:
        for o in ordens:
            gat = bool(o.get("isTrigger"))
            preco = float(o["triggerPx"] if gat else o["limitPx"])
            linhas.append((end, o["coin"], o["oid"], o.get("orderType") or "Limit", o["side"], preco,
                           float(o["sz"]), int(gat), int(bool(o.get("reduceOnly"))), agora))
    ends = [e for e, _ in lidas]
    for i in range(0, len(ends), 200):
        lote = ends[i:i + 200]
        con.execute(f"DELETE FROM ordens WHERE endereco IN ({','.join('?' * len(lote))})", lote)
    n = con.executemany("INSERT INTO ordens VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (endereco, oid) DO NOTHING", linhas)
    con.commit()
    return n


def _bandas(niveis, p, px, lado, acc):
    for nv in niveis:
        preco = float(nv["px"] if isinstance(nv, dict) else nv[0])
        tam = float(nv["sz"] if isinstance(nv, dict) else nv[1])
        if abs(preco / px - 1) <= ALCANCE:
            acc[(faixa(preco, p), lado)] += preco * tam


def livro_hyperliquid(hl, moeda, px, p):
    """Duas leituras: fina (perto do preço) e grossa (longe). A grossa só entra fora da fina."""
    acc = defaultdict(float)
    fino_b, fino_a = hl.livro(moeda, 3)
    grosso_b, grosso_a = hl.livro(moeda, 2)
    _bandas(fino_b, p, px, "bid", acc)
    _bandas(fino_a, p, px, "ask", acc)
    lim_b = min(float(x["px"]) for x in fino_b) if fino_b else px
    lim_a = max(float(x["px"]) for x in fino_a) if fino_a else px
    _bandas([x for x in grosso_b if float(x["px"]) < lim_b], p, px, "bid", acc)
    _bandas([x for x in grosso_a if float(x["px"]) > lim_a], p, px, "ask", acc)
    return acc


def livro_coinbase(moeda, px, p):
    acc = defaultdict(float)
    try:
        r = requests.get(f"https://api.exchange.coinbase.com/products/{moeda}-USD/book?level=2",
                         timeout=30, headers={"User-Agent": "radar-carteiras"})
        if r.status_code != 200:
            return acc
        d = r.json()
        _bandas(d.get("bids", []), p, px, "bid", acc)
        _bandas(d.get("asks", []), p, px, "ask", acc)
    except (requests.RequestException, ValueError):
        pass
    return acc


def coletar_livro(hl, con, precos, agora):
    linhas = []
    for m in ATIVOS:
        px = precos[m]
        p = passo(px)
        for fonte, acc in (("hyperliquid", livro_hyperliquid(hl, m, px, p)), ("coinbase", livro_coinbase(m, px, p))):
            linhas += [(agora, m, fonte, preco, lado, v) for (preco, lado), v in acc.items()]
    con.executemany("INSERT INTO livro VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING", linhas)
    con.commit()
    return len(linhas)


def perfil_volume(hl, moeda, px, p, agora):
    """Volume negociado em 30 dias por faixa (vela de 1 h espalhada entre mínima e máxima)."""
    acc = defaultdict(float)
    for v in hl.velas(moeda, "1h", agora - 30 * 24 * HORA, agora):
        lo, hi, usd = float(v["l"]), float(v["h"]), float(v["v"]) * float(v["c"])
        faixas = [f for f in _faixas_entre(lo, hi, p) if abs(f / px - 1) <= ALCANCE]
        for f in faixas:
            acc[f] += usd / max(1, len(faixas))
    return acc


def perfil_volume_guardado(con, hl, moeda, px, p, agora):
    """O perfil de 30 dias quase não muda entre coletas: recalcula a cada 6 h."""
    chave = f"perfil_volume_{moeda}"
    salvo = con.kv_ler(chave)
    if salvo and agora - salvo["tempo"] < 6 * HORA and salvo["passo"] == p:
        return {float(k): v for k, v in salvo["faixas"].items()}
    acc = perfil_volume(hl, moeda, px, p, agora)
    con.kv_gravar(chave, {"tempo": agora, "passo": p, "faixas": {str(k): v for k, v in acc.items()}})
    return acc


def _faixas_entre(lo, hi, p):
    f = faixa(lo, p)
    while f <= hi:
        yield round(f, 10)
        f += p


# ---------- cálculo ----------

def mapa_liquidez(con, m, px, oi_usd, agora):
    """Stops e liquidações das carteiras do ranking + amostra de varejo lida nas últimas 24 h.
    Uma carteira que está nas duas conta uma vez (vale a leitura do ranking, mais recente)."""
    posicoes = {r["endereco"]: dict(r) for r in con.execute(
        "SELECT * FROM varejo_posicoes WHERE moeda=? AND coletado>=?", (m, agora - 24 * HORA))}
    posicoes.update({r["endereco"]: dict(r) for r in con.execute("SELECT * FROM posicoes WHERE moeda=?", (m,))})
    ordens = {(r["endereco"], r["oid"]): dict(r) for r in con.execute(
        "SELECT * FROM varejo_ordens WHERE moeda=? AND gatilho=1 AND coletado>=?", (m, agora - 36 * HORA))}
    ordens.update({(r["endereco"], r["oid"]): dict(r) for r in con.execute(
        "SELECT * FROM ordens WHERE moeda=? AND gatilho=1", (m,))})
    return mapa_de(posicoes, ordens.values(), px, oi_usd)


def mapa_de(posicoes, ordens, px, oi_usd, posicao_inteira=False):
    """Mapa a partir das posições ({endereco: linha}) e das ordens com gatilho já lidas.
    Usado pelos 6 ativos de cripto e pelas ações (acoes.py), que ficam em tabelas próprias.

    posicao_inteira=True: o stop/alvo "da posição inteira" (isPositionTpsl) vem da API com
    tamanho 0; conta com o tamanho da posição da carteira, quando ela está na leitura."""
    p = passo(px)
    b = defaultdict(lambda: {"stop_long": 0.0, "liq_long": 0.0, "stop_short": 0.0, "liq_short": 0.0,
                             "tp_long": 0.0, "tp_short": 0.0})
    n = defaultdict(lambda: defaultdict(set))      # faixa -> tipo -> carteiras (para o detalhe ao passar o mouse)
    notional, longs = 0.0, 0
    for end, r in posicoes.items():
        notional += r["tamanho"] * px
        longs += r["lado"] == "long"
        liq = r["preco_liquidacao"]
        if liq and abs(liq / px - 1) <= ALCANCE:
            k = "liq_long" if r["lado"] == "long" else "liq_short"
            b[faixa(liq, p)][k] += r["tamanho"] * liq
            n[faixa(liq, p)][k].add(end)
    com_stop = set()
    for r in ordens:
        if abs(r["preco"] / px - 1) > ALCANCE:
            continue
        f = faixa(r["preco"], p)
        if "Take Profit" in r["tipo"]:
            # alvo de venda = de quem está comprado; alvo de compra = de quem está vendido
            k = "tp_long" if r["lado"] == "A" else "tp_short"
        elif "Stop" in r["tipo"]:
            com_stop.add(r["endereco"])
            # stop de venda protege comprado (fica abaixo); stop de compra protege vendido (acima)
            k = "stop_long" if r["lado"] == "A" else "stop_short"
        else:
            continue
        tam = r["tamanho"]
        if not tam and posicao_inteira:
            tam = (posicoes.get(r["endereco"]) or {}).get("tamanho") or 0
        b[f][k] += tam * r["preco"]
        n[f][k].add(r["endereco"])
    faixas = sorted(({"preco": f, **v, "n": {k: len(s) for k, s in n[f].items()}} for f, v in b.items()),
                    key=lambda x: -x["preco"])
    acima = sum(x["stop_short"] + x["liq_short"] for x in faixas if x["preco"] > px)
    abaixo = sum(x["stop_long"] + x["liq_long"] for x in faixas if x["preco"] < px)
    acima5 = sum(x["stop_short"] + x["liq_short"] for x in faixas if px < x["preco"] <= px * 1.05)
    abaixo5 = sum(x["stop_long"] + x["liq_long"] for x in faixas if px * 0.95 <= x["preco"] < px)

    def ima(lado):
        cand = [x for x in faixas if (x["preco"] > px if lado == "acima" else x["preco"] + p < px)
                and abs(x["preco"] / px - 1) <= 0.05]
        chave = (lambda x: x["stop_short"] + x["liq_short"]) if lado == "acima" else (lambda x: x["stop_long"] + x["liq_long"])
        cand = [x for x in cand if chave(x) > 0]
        return max(cand, key=chave)["preco"] if cand else None

    return {"passo": p, "faixas": faixas, "acima": acima, "abaixo": abaixo, "acima5": acima5, "abaixo5": abaixo5,
            "ima_acima": ima("acima"),
            "ima_abaixo": ima("abaixo"), "carteiras": len(posicoes), "longs": longs, "shorts": len(posicoes) - longs,
            "com_stop": len(com_stop), "cobertura": notional / oi_usd if oi_usd else None}


def zonas(con, hl, m, px, agora):
    p = passo(px)
    ultimo = con.execute("SELECT MAX(tempo) FROM livro WHERE moeda=?", (m,)).fetchone()[0]
    livro = defaultdict(lambda: defaultdict(float))     # faixa -> fonte -> US$
    lado_livro = {}
    for r in con.execute("SELECT * FROM livro WHERE moeda=? AND tempo=?", (m, ultimo)):
        livro[r["preco"]][r["fonte"]] += r["valor"]
        lado_livro[r["preco"]] = r["lado"]
    baleias = defaultdict(float)
    n_baleias = defaultdict(set)
    alvos = defaultdict(float)
    for r in con.execute("SELECT * FROM ordens WHERE moeda=?", (m,)):
        if abs(r["preco"] / px - 1) > ALCANCE:
            continue
        f = faixa(r["preco"], p)
        if not r["gatilho"]:
            baleias[f] += r["preco"] * r["tamanho"]
            n_baleias[f].add(r["endereco"])
        elif "Take Profit" in r["tipo"]:
            alvos[f] += r["preco"] * r["tamanho"]
    volume = perfil_volume_guardado(con, hl, m, px, p, agora)
    corte_vol = sorted(volume.values(), reverse=True)[max(0, len(volume) // 10)] if volume else math.inf

    # persistência: em quantas coletas das últimas 24 h a faixa tinha pelo menos metade do valor de agora
    historico = defaultdict(dict)
    tempos = set()
    for r in con.execute("SELECT tempo, preco, SUM(valor) AS v FROM livro WHERE moeda=? AND tempo>=? "
                         "GROUP BY tempo, preco", (m, agora - 24 * HORA)):
        historico[r["preco"]][r["tempo"]] = r["v"]
        tempos.add(r["tempo"])

    todas = set(livro) | set(baleias) | set(alvos)
    zs = []
    for f in todas:
        fontes = {k: v for k, v in (("Livro Hyperliquid", livro[f].get("hyperliquid", 0)),
                                     ("Livro Coinbase", livro[f].get("coinbase", 0)),
                                     ("Ordens de baleias", baleias[f]), ("Take profit", alvos[f])) if v > 0}
        forca = sum(fontes.values())
        if forca <= 0:
            continue
        atual = sum(livro[f].values())
        presente = sum(1 for t in tempos if historico[f].get(t, 0) >= 0.5 * atual) if atual else None
        zs.append({"preco": f, "forca": forca, "fontes": fontes, "baleias": len(n_baleias[f]),
                   "volume30d": volume.get(f, 0) if volume.get(f, 0) >= corte_vol else 0,
                   "presente": presente, "coletas": len(tempos), "dist": (f + p / 2) / px - 1})
    acima = sorted((z for z in zs if z["preco"] > px), key=lambda z: -z["forca"])[:5]
    abaixo = sorted((z for z in zs if z["preco"] + p <= px), key=lambda z: -z["forca"])[:5]
    perto = [z for z in zs if abs(z["dist"]) <= 0.03]
    parede = max((z for z in perto if z["preco"] > px), key=lambda z: z["forca"], default=None)
    apoio = max((z for z in perto if z["preco"] + p <= px), key=lambda z: z["forca"], default=None)

    # vácuo: 3+ faixas seguidas com livro muito raso (menos de 20% da mediana) até ±10%
    prof = {f: sum(v.values()) for f, v in livro.items()}
    med = sorted(prof.values())[len(prof) // 2] if prof else 0
    vacuos, corrida = [], []
    f = faixa(px * 0.90, p)
    while f <= px * 1.10:
        f = round(f, 10)
        if prof.get(f, 0) < 0.2 * med and abs(f / px - 1) > 0.01:
            corrida.append(f)
        else:
            if len(corrida) >= 3:
                vacuos.append([corrida[0], corrida[-1] + p])
            corrida = []
        f += p
    if len(corrida) >= 3:
        vacuos.append([corrida[0], corrida[-1] + p])

    bid2 = sum(v for f, v in prof.items() if lado_livro.get(f) == "bid" and f >= px * 0.98)
    ask2 = sum(v for f, v in prof.items() if lado_livro.get(f) == "ask" and f <= px * 1.02)
    bal_b = sum(v for f, v in baleias.items() if f < px and f >= px * 0.95)
    bal_a = sum(v for f, v in baleias.items() if f > px and f <= px * 1.05)
    return {"passo": p, "zonas": sorted(acima + abaixo, key=lambda z: -z["preco"]), "parede": parede, "apoio": apoio,
            "vacuos": vacuos, "livro2": [bid2, ask2], "baleias5": [bal_b, bal_a]}


def _razao(a, b):
    return (a - b) / (a + b) if a + b > 0 else 0.0


def placar_regime(ativo, z, fluxo7, cons):
    """Placar de alta/lateral/baixa. Não é probabilidade calibrada: fica registrado a cada
    coleta para, no futuro, medir se os números acertam na proporção que dizem."""
    f_fluxo = max(-1, min(1, 5 * _razao(*fluxo7)))
    f_pos = _razao(cons.get("long", 0), cons.get("short", 0))
    f_baleias = _razao(*z["baleias5"])
    f_livro = _razao(*z["livro2"])
    fu = ativo["funding"]
    f_funding = -min(1, (fu - 13) / 30) if fu > 13 else min(1, -fu / 30) if fu < 0 else 0.0
    fatores = [["Fluxo das carteiras (7 dias)", 0.25, f_fluxo], ["Posição das carteiras confiáveis", 0.25, f_pos],
               ["Ordens limite das baleias (±5%)", 0.15, f_baleias], ["Livro de ofertas (±2%)", 0.15, f_livro],
               ["Funding (lotado = contra)", 0.20, f_funding]]
    score = sum(w * v for _, w, v in fatores)
    lateral = max(0.1, min(0.9, (1 - 2 * abs(score)) * (1.2 if ativo.get("amp", 1) < 0.8 else 1.0)))
    alta = (1 - lateral) * (0.5 + 0.5 * math.tanh(3 * score))
    return {"alta": alta, "lateral": lateral, "baixa": 1 - lateral - alta, "score": score, "fatores": fatores}


def calcular(hl, con, ativos, consenso, agora):
    """Monta os dados das abas Stops e liquidações e Suportes e resistências, e registra o regime."""
    fluxo = defaultdict(lambda: [0.0, 0.0])
    for r in con.execute("SELECT moeda, SUM(compra) c, SUM(venda) v FROM fluxo_diario WHERE dia>=? GROUP BY moeda",
                         (agora - 7 * 24 * HORA,)):
        fluxo[r["moeda"]] = [r["c"] or 0, r["v"] or 0]
    saida = {}
    regs = []
    for a in ativos:
        m, px = a["t"], a["px"]
        z = zonas(con, hl, m, px, agora)
        reg = placar_regime(a, z, fluxo[m], consenso.get(m, {}))
        regs.append((agora, m, reg["alta"], reg["lateral"], reg["baixa"], px,
                     ";".join(f"{n}={v:.3f}" for n, _, v in reg["fatores"])))
        saida[m] = {"liquidez": mapa_liquidez(con, m, px, a["oi"], agora), "sr": z, "regime": reg,
                    "fluxo7": fluxo[m], "faixa": [a["lo"], a["hi"]], "amp": a.get("amp")}
    con.executemany("INSERT INTO regime VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", regs)
    # histórico do lado mais carregado, para testar a tese "liquidez abaixo → o preço vai buscar"
    con.executemany("INSERT INTO liquidez_hist VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                    [(agora, a["t"], a["px"], saida[a["t"]]["liquidez"]["acima"], saida[a["t"]]["liquidez"]["abaixo"],
                      saida[a["t"]]["liquidez"]["acima5"], saida[a["t"]]["liquidez"]["abaixo5"],
                      saida[a["t"]]["liquidez"]["carteiras"]) for a in ativos])
    con.commit()
    saida["_tese_lado"] = estudo_lado(con, agora)
    lidas = con.execute("SELECT COUNT(*) FROM varejo_lido WHERE ativo=1 AND posicoes_em>=?", (agora - 24 * HORA,)).fetchone()[0]
    saida["_amostra"] = {"varejo_24h": lidas, "ranking": con.execute("SELECT COUNT(*) FROM fotos").fetchone()[0],
                         "varejo_total": con.execute("SELECT COUNT(*) FROM varejo_lido WHERE ativo=1").fetchone()[0],
                         "tempo": agora}
    return saida


LADO_FORTE = 0.65          # 65% ou mais da liquidez de um lado = lado carregado
HORIZONTES_H = (24, 72)


def estudo_lado(con, agora):
    """Testa a tese do vídeo de 08/10/2026: "lado mais carregado é para onde o preço vai".
    Uma leitura por ativo a cada 24 h (leituras de hora em hora seriam quase a mesma coisa
    contada várias vezes); o retorno vem do preço gravado no histórico 24 h e 72 h depois."""
    # só os 6 ativos de cripto: as ações também gravam liquidez_hist, mas o teste delas é separado
    linhas = con.execute("SELECT tempo, moeda, preco, acima, abaixo FROM liquidez_hist WHERE moeda IN ({}) "
                         "ORDER BY moeda, tempo".format(",".join("?" * len(ATIVOS))), ATIVOS).fetchall()
    if not linhas:
        return None
    precos = defaultdict(list)
    for r in con.execute("SELECT tempo, moeda, preco FROM mercado_hist WHERE moeda IN ({}) AND tempo>=?".format(
            ",".join("?" * len(ATIVOS))), (*ATIVOS, linhas[0]["tempo"])):
        precos[r["moeda"]].append((r["tempo"], r["preco"]))
    for v in precos.values():
        v.sort()

    def preco_em(m, t):
        """Preço gravado mais perto de t (até 90 min de diferença)."""
        serie = precos.get(m) or []
        lo, hi = 0, len(serie)
        while lo < hi:
            mid = (lo + hi) // 2
            if serie[mid][0] < t:
                lo = mid + 1
            else:
                hi = mid
        cands = [serie[k] for k in (lo - 1, lo) if 0 <= k < len(serie)]
        melhor = min(cands, key=lambda x: abs(x[0] - t), default=None)
        return melhor[1] if melhor and abs(melhor[0] - t) <= 90 * 60_000 else None

    grupos = {g: {h: [] for h in HORIZONTES_H} for g in ("abaixo", "acima", "equilibrado")}
    ultimo = {}
    leituras = 0
    for r in linhas:
        tot = (r["acima"] or 0) + (r["abaixo"] or 0)
        if not tot or r["tempo"] - ultimo.get(r["moeda"], -10 ** 15) < 24 * HORA:
            continue
        ultimo[r["moeda"]] = r["tempo"]
        leituras += 1
        frac = r["abaixo"] / tot
        g = "abaixo" if frac >= LADO_FORTE else "acima" if frac <= 1 - LADO_FORTE else "equilibrado"
        for h in HORIZONTES_H:
            fut = preco_em(r["moeda"], r["tempo"] + h * HORA)
            if fut:
                grupos[g][h].append(fut / r["preco"] - 1)

    def resumo(xs, lado):
        if not xs:
            return {"n": 0}
        xs = sorted(xs)
        meio = len(xs) // 2
        med = xs[meio] if len(xs) % 2 else (xs[meio - 1] + xs[meio]) / 2
        # "acertou" = o preço andou na direção do lado carregado
        acerto = None if lado == "equilibrado" else sum(1 for x in xs if (x < 0 if lado == "abaixo" else x > 0)) / len(xs)
        return {"n": len(xs), "mediana": med, "acerto": acerto}
    return {"desde": linhas[0]["tempo"], "leituras": leituras, "limite": LADO_FORTE,
            "grupos": {g: {str(h): resumo(v[h], g) for h in HORIZONTES_H} for g, v in grupos.items()}}


def hora_das_ordens(con, intervalo_h):
    ult = con.kv_ler("ordens_em") or 0
    return time.time() * 1000 - ult >= intervalo_h * HORA - 10 * 60_000
