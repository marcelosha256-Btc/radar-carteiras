"""Chance de o preço tocar as zonas de stops e liquidações (ideia do vídeo de 16/10/2026).

Empírico, sem modelo: nas velas de 1 h da Hyperliquid (~7 meses), mede para cada hora quanto o
preço chegou a subir e a cair nas 4 h e 24 h seguintes, em múltiplos da volatilidade daquele
momento (amplitude média das 24 velas anteriores). A chance de tocar uma zona a d% de distância
hoje é a fração da história em que a excursão passou de d ÷ volatilidade de agora.

"Qual lado primeiro" usa só as distâncias: dd ÷ (du + dd), a conta do passeio aleatório (sem
tendência). As duas coisas são conferidas no histórico: escolhe com os 70% iniciais e mede nos
30% finais, e o painel mostra o resultado.
"""
import bisect
import statistics as st
import time

ATIVOS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "NEAR"]
HORIZONTES = (4, 24)
JANELA_VOL = 24
QUANTIS = 101
FORA = 0.30
PRIMEIRO_H = 168            # no teste do "lado primeiro", espera até 7 dias
DIA = 86_400_000
HORA = 3_600_000


def _vol(h, l, c, i):
    """Amplitude média (máxima − mínima) ÷ fechamento das 24 velas até i, inclusive."""
    return st.fmean((h[k] - l[k]) / c[k] for k in range(i - JANELA_VOL + 1, i + 1))


def _excursoes(h, l, c, ini, fim, H):
    """[(vol, subida/vol, queda/vol)] para cada hora t em [ini, fim) com H horas à frente."""
    out = []
    for t in range(max(ini, JANELA_VOL), min(fim, len(c) - H)):
        v = _vol(h, l, c, t)
        if v <= 0:
            continue
        out.append((v, (max(h[t + 1:t + H + 1]) / c[t] - 1) / v, (1 - min(l[t + 1:t + H + 1]) / c[t]) / v))
    return out


def _quantis(xs):
    xs = sorted(xs)
    return [round(xs[min(len(xs) - 1, int(k * (len(xs) - 1) / (QUANTIS - 1)))], 4) for k in range(QUANTIS)]


def prob(qs, x):
    """Fração da história com excursão ≥ x (qs = quantis ordenados)."""
    if x <= 0:
        return 1.0
    k = bisect.bisect_left(qs, x)
    return max(0.0, min(1.0, 1 - k / (len(qs) - 1)))


def _calibrar(h, l, c, corte):
    """Ajusta os quantis antes do corte e mede depois: para distâncias de 0,5% a 5%, a chance
    prevista contra o que aconteceu, agrupada em faixas de 10 pontos."""
    linhas = []
    for H in HORIZONTES:
        treino = _excursoes(h, l, c, 0, corte, H)
        qu, qd = _quantis([e[1] for e in treino]), _quantis([e[2] for e in treino])
        for v, up, dn in _excursoes(h, l, c, corte, len(c), H)[::3]:   # uma hora em três: menos repetição
            for d in (0.005, 0.01, 0.02, 0.03, 0.05):
                linhas.append((prob(qu, d / v), up >= d / v))
                linhas.append((prob(qd, d / v), dn >= d / v))
    faixas = []
    for k in range(10):
        g = [o for p, o in linhas if k / 10 <= p < (k + 1) / 10 or (k == 9 and p == 1.0)]
        ps = [p for p, _ in linhas if k / 10 <= p < (k + 1) / 10 or (k == 9 and p == 1.0)]
        if g:
            faixas.append({"prevista": st.fmean(ps), "tocou": sum(g) / len(g), "n": len(g)})
    base = sum(o for _, o in linhas) / len(linhas)
    brier = st.fmean((p - o) ** 2 for p, o in linhas)
    brier_fixo = st.fmean((base - o) ** 2 for _, o in linhas)
    return {"faixas": faixas, "brier": brier, "brier_fixo": brier_fixo, "n": len(linhas)}


def _testar_primeiro(h, l, c, corte):
    """Confere "lado primeiro = dd ÷ (du + dd)" nos 30% finais, para pares de distâncias."""
    pares = [(du, dd) for du in (0.01, 0.02, 0.03) for dd in (0.01, 0.02, 0.03)]
    res = []
    for du, dd in pares:
        cima = baixo = 0
        for t in range(corte, len(c) - 1, 6):
            alvo_c, alvo_b = c[t] * (1 + du), c[t] * (1 - dd)
            for k in range(t + 1, min(len(c), t + 1 + PRIMEIRO_H)):
                hc, hb = h[k] >= alvo_c, l[k] <= alvo_b
                if hc and hb:
                    break           # os dois na mesma vela: não dá para saber a ordem
                if hc:
                    cima += 1
                    break
                if hb:
                    baixo += 1
                    break
        n = cima + baixo
        if n:
            res.append({"acima": du, "abaixo": dd, "previsto": dd / (du + dd), "observado": cima / n, "n": n})
    erro = st.fmean(abs(r["previsto"] - r["observado"]) for r in res) if res else None
    return {"pares": res, "erro_medio": erro}


def calcular_base(hl):
    agora = int(time.time() * 1000)
    saida = {"dia": time.strftime("%Y-%m-%d", time.gmtime()), "gerado": agora, "ativos": {}}
    for m in ATIVOS:
        vs = hl.velas(m, "1h", agora - 5000 * HORA, agora)
        vs = [v for v in vs if v["t"] + HORA <= agora]          # só velas fechadas
        h, l, c = ([float(v[k]) for v in vs] for k in ("h", "l", "c"))
        if len(c) < 1000:
            saida["ativos"][m] = {"erro": f"histórico curto ({len(c)} velas de 1 h)"}
            continue
        q = {}
        for H in HORIZONTES:
            ex = _excursoes(h, l, c, 0, len(c), H)
            q[str(H)] = {"up": _quantis([e[1] for e in ex]), "dn": _quantis([e[2] for e in ex])}
        corte = int(len(c) * (1 - FORA))
        saida["ativos"][m] = {"quantis": q, "velas": len(c), "desde": vs[0]["t"],
                              "calibracao": _calibrar(h, l, c, corte), "primeiro": _testar_primeiro(h, l, c, corte)}
    return saida


def base_do_dia(hl, con):
    salvo = con.kv_ler("chance_base")
    if salvo and salvo.get("dia") == time.strftime("%Y-%m-%d", time.gmtime()):
        return salvo
    base = calcular_base(hl)
    con.kv_gravar("chance_base", base)
    return base


def zonas(L, px):
    """Até 3 zonas de cada lado, até ±8%: a mais perto que tem volume relevante (≥ 35% da maior
    do lado) e as maiores. Acima: stops e liquidações de quem está vendido; abaixo: de comprado."""
    p = L["passo"]
    saida = []
    for lado in ("acima", "abaixo"):
        val = (lambda f: f["stop_short"] + f["liq_short"]) if lado == "acima" else (lambda f: f["stop_long"] + f["liq_long"])
        cand = [f for f in L["faixas"] if (f["preco"] > px if lado == "acima" else f["preco"] + p < px)
                and abs((f["preco"] + p / 2) / px - 1) <= 0.08 and val(f) > 0]
        if not cand:
            continue
        maior = max(val(f) for f in cand)
        relevantes = [f for f in cand if val(f) >= 0.35 * maior]
        perto = min(relevantes, key=lambda f: abs(f["preco"] - px))
        escolhidas = [perto] + [f for f in sorted(relevantes, key=lambda f: -val(f)) if f is not perto][:2]
        for f in escolhidas:
            borda = f["preco"] if lado == "acima" else f["preco"] + p    # a borda que o preço toca primeiro
            saida.append({"lado": lado, "de": f["preco"], "ate": f["preco"] + p, "borda": borda, "valor": val(f),
                          "maior": f["preco"] == max(relevantes, key=val)["preco"], "perto": f is perto})
    return saida


def montar(hl, con, f2, ativos, agora):
    """Acrescenta em f2[moeda]['chance'] as zonas com a chance de toque em 4 h e 24 h."""
    base = base_do_dia(hl, con)
    for a in ativos:
        m, px = a["t"], a["px"]
        b = base["ativos"].get(m)
        if not b or "erro" in b or m not in f2:
            continue
        vs = hl.velas(m, "1h", agora - 30 * HORA, agora)
        vs = [v for v in vs if v["t"] + HORA <= agora][-JANELA_VOL:]
        if len(vs) < JANELA_VOL:
            continue
        vol = st.fmean((float(v["h"]) - float(v["l"])) / float(v["c"]) for v in vs)
        zs = zonas(f2[m]["liquidez"], px)
        for z in zs:
            d = abs(z["borda"] / px - 1)
            q = "up" if z["lado"] == "acima" else "dn"
            z["dist"] = z["borda"] / px - 1
            z["p4"], z["p24"] = prob(b["quantis"]["4"][q], d / vol), prob(b["quantis"]["24"][q], d / vol)
        perto_c = next((z for z in zs if z["lado"] == "acima" and z["perto"]), None)
        perto_b = next((z for z in zs if z["lado"] == "abaixo" and z["perto"]), None)
        primeiro = None
        if perto_c and perto_b:
            du, dd = abs(perto_c["dist"]), abs(perto_b["dist"])
            primeiro = {"acima": dd / (du + dd), "abaixo": du / (du + dd)}
        f2[m]["chance"] = {"vol": vol, "zonas": zs, "primeiro": primeiro, "px": px, "quantis": b["quantis"],
                           "calibracao": b["calibracao"], "teste_primeiro": b["primeiro"], "velas": b["velas"],
                           "desde": b["desde"]}
    return f2
