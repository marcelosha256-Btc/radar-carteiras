"""Fase 3: SOPR e custo médio do curto prazo do BTC, on-chain e em tempo real.

Fonte: bitview.space (Bitcoin Research Kit, API aberta, calculada de um nó próprio).
Conferido em 07/10/2026 contra o bitcoin-data.com: SOPR igual e custo 0,17% diferente.

Sem olhar para o futuro: as faixas de "capitulação" e "lucro extremo" de cada dia
são percentis do SOPR de 7 dias nos 3 anos ANTERIORES àquele dia.
"""
import bisect
import math
import statistics as st
import time

import requests

API = "https://bitview.space/api/metric/{}/day1?from=-{}"
API4 = "https://bitview.space/api/metric/{}/hour4?from=-{}"
DIAS = 4400                  # ~12 anos: 3 de janela + eventos desde 2017 com retorno de até 365 dias
JANELA = 3 * 365
HORIZONTES = [7, 30, 60, 120, 180, 365]
AGRUPAR_DIAS = 14            # eventos do mesmo tipo a menos de 14 dias contam uma vez
GUARDAR_H = 3                # recalcula no máximo a cada 3 h
SERIES = ("date", "price_close", "sth_realized_price", "sth_sopr_1w", "sth_sopr_24h")


def baixar():
    s = {}
    for m in SERIES:
        r = requests.get(API.format(m, DIAS), timeout=60, headers={"User-Agent": "radar-carteiras"})
        r.raise_for_status()
        s[m] = r.json()
    n = min(len(v) for v in s.values())
    s = {k: v[-n:] for k, v in s.items()}
    ok = [i for i in range(n) if all(s[m][i] is not None for m in SERIES)]
    s = {k: [v[i] for i in ok] for k, v in s.items()}
    # SOPR de 24 h em velas de 4 h (últimos 7 dias), para ver o dia corrente sem esperar o fechamento
    v4 = requests.get(API4.format("sth_sopr_24h", 42), timeout=60, headers={"User-Agent": "radar-carteiras"}).json()
    t4 = requests.get(API4.format("timestamp", 42), timeout=60, headers={"User-Agent": "radar-carteiras"}).json()
    s["h4"] = [[t * 1000, v] for t, v in zip(t4, v4) if v is not None]
    return s


def _quantil(ordenada, q):
    if not ordenada:
        return None
    pos = q * (len(ordenada) - 1)
    i = int(pos)
    j = min(i + 1, len(ordenada) - 1)
    return ordenada[i] + (ordenada[j] - ordenada[i]) * (pos - i)


def faixas_rolantes(sopr):
    """Para cada dia, percentis 2/10/90/98 do SOPR 7d nos JANELA dias anteriores."""
    janela, saida = [], []
    for i, v in enumerate(sopr):
        if i >= JANELA:
            saida.append(tuple(_quantil(janela, q) for q in (0.02, 0.10, 0.90, 0.98)))
            janela.pop(bisect.bisect_left(janela, sopr[i - JANELA]))
        else:
            saida.append(None)
        bisect.insort(janela, v)
    return saida


def comportamento(v, f):
    p02, p10, p90, p98 = f
    if v <= p02:
        return "Capitulação"
    if v <= p10:
        return "Prejuízo forte"
    if v < 1:
        return "Vendendo com prejuízo"
    if v < p90:
        return "Vendendo com lucro"
    if v < p98:
        return "Realização de lucro forte"
    return "Lucro extremo"


def validacao(eventos, niveis, custo):
    """Onde o preço estava em relação ao custo do curto prazo nos dias-chave reais, para
    conferir se os níveis de hoje fazem sentido (ex.: uma "capitulação" acima do custo não faz)."""
    out = {}
    for tipo in ("capitulacao", "lucro"):
        v = [e["vs_custo"] for e in eventos if e["tipo"] == tipo]
        out[tipo] = {"n": len(v), "mediana": st.median(v) if v else None,
                     "min": min(v) if v else None, "max": max(v) if v else None}
    nome = {"capitulacao": "Capitulação", "lucro": "Lucro extremo"}
    for tipo, prefixo in nome.items():
        nv = next((x for x in niveis if x["nome"].startswith(prefixo)), None)
        out[tipo]["nivel_hoje"] = nv["preco"] / custo - 1 if nv and nv["preco"] else None
    return out


def sopr_4h(s):
    """SOPR de 24 h atualizado a cada 4 h, com as faixas de 2% e 98% do SOPR de 24 h diário
    nos últimos 3 anos (é uma série mais nervosa que a de 7 dias, então tem faixas próprias)."""
    if not s.get("h4"):
        return None
    hist = sorted(s["sth_sopr_24h"][-JANELA:])
    return {"pontos": s["h4"], "p02": _quantil(hist, 0.02), "p98": _quantil(hist, 0.98),
            "p10": _quantil(hist, 0.10), "p90": _quantil(hist, 0.90)}


def calcular(s):
    datas, preco, custo, sopr = s["date"], s["price_close"], s["sth_realized_price"], s["sth_sopr_1w"]
    n = len(datas)
    faixas = faixas_rolantes(sopr)

    # dias-chave e o que aconteceu depois
    eventos, ultimo = [], {"capitulacao": -10**9, "lucro": -10**9}
    for i in range(n):
        if faixas[i] is None:
            continue
        p02, _, _, p98 = faixas[i]
        tipo = "capitulacao" if sopr[i] <= p02 else "lucro" if sopr[i] >= p98 else None
        if not tipo:
            continue
        novo = i - ultimo[tipo] > AGRUPAR_DIAS
        ultimo[tipo] = i
        if novo:
            eventos.append({"i": i, "data": datas[i], "tipo": tipo, "preco": preco[i], "sopr": sopr[i],
                            "vs_custo": preco[i] / custo[i] - 1,
                            "ret": {h: (preco[i + h] / preco[i] - 1) if i + h < n else None for h in HORIZONTES}})
    estudo = {}
    for tipo in ("capitulacao", "lucro"):
        estudo[tipo] = {}
        for h in HORIZONTES:
            rs = [e["ret"][h] for e in eventos if e["tipo"] == tipo and e["ret"][h] is not None]
            estudo[tipo][h] = {"n": len(rs), "mediana": st.median(rs) if rs else None,
                               "media": st.fmean(rs) if rs else None,
                               "subiu": sum(r > 0 for r in rs) / len(rs) if rs else None}

    # níveis de preço: em que preço o SOPR 7d chegaria em cada faixa (regressão nos últimos 3 anos)
    ini = max(0, n - JANELA)
    xs = [math.log(preco[i] / custo[i]) for i in range(ini, n)]
    ys = sopr[ini:n]
    mx, my = st.fmean(xs), st.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    a = my - b * mx
    sres = sum((y - a - b * x) ** 2 for x, y in zip(xs, ys))
    r2 = 1 - sres / sum((y - my) ** 2 for y in ys)
    atual = sorted(ys)
    hoje_f = tuple(_quantil(atual, q) for q in (0.02, 0.10, 0.90, 0.98))
    p02, p10, p90, p98 = hoje_f
    c = custo[-1]
    nivel = lambda v: c * math.exp((v - a) / b) if b > 0 else None
    niveis = [
        {"nome": "Lucro extremo — resistência forte", "sopr": p98, "preco": nivel(p98), "tipo": "lucro"},
        {"nome": "Lucro forte — resistência", "sopr": p90, "preco": nivel(p90), "tipo": "lucro"},
        {"nome": "Ponto de virada (SOPR = 1)", "sopr": 1.0, "preco": nivel(1.0), "tipo": "neutro"},
        {"nome": "Prejuízo forte — suporte", "sopr": p10, "preco": nivel(p10), "tipo": "prejuizo"},
        {"nome": "Capitulação — suporte forte, zona de desespero", "sopr": p02, "preco": nivel(p02), "tipo": "prejuizo"},
        {"nome": "Custo médio de quem comprou nos últimos ~5 meses", "sopr": None, "preco": c, "tipo": "custo"},
    ]
    for nv in niveis:
        nv["dist"] = nv["preco"] / preco[-1] - 1 if nv["preco"] else None
    rank = bisect.bisect_left(atual, sopr[-1]) / max(1, len(atual) - 1)

    corte = max(0, n - 730)
    return {
        "atualizado": int(time.time() * 1000),
        "fonte": "bitview.space (Bitcoin Research Kit)",
        "hoje": {"data": datas[-1], "preco": preco[-1], "custo": c, "sopr7": sopr[-1], "sopr24": s["sth_sopr_24h"][-1],
                 "acima": preco[-1] / c - 1, "comportamento": comportamento(sopr[-1], hoje_f), "rank": rank},
        "faixas": {"p02": p02, "p10": p10, "p90": p90, "p98": p98},
        "ajuste": {"a": a, "b": b, "r2": r2},
        "niveis": niveis,
        "estudo": estudo,
        "eventos": [{k: v for k, v in e.items() if k != "i"} for e in eventos[::-1][:14]],
        "marcas": [{"data": e["data"], "tipo": e["tipo"]} for e in eventos if e["i"] >= corte],
        "serie": {"datas": datas[corte:], "preco": [round(x) for x in preco[corte:]],
                  "custo": [round(x) for x in custo[corte:]], "sopr7": [round(x, 4) for x in sopr[corte:]]},
        "historico_desde": datas[0],
        "validacao": validacao(eventos, niveis, c),
        "sopr4h": sopr_4h(s),
    }


def obter(con):
    """Resultado guardado no banco por até GUARDAR_H horas. Se a fonte falhar, usa o último bom."""
    salvo = con.kv_ler("sopr_btc")
    if salvo and time.time() * 1000 - salvo["atualizado"] < GUARDAR_H * 3_600_000:
        return salvo
    try:
        novo = calcular(baixar())
    except (requests.RequestException, ValueError, ZeroDivisionError, KeyError) as e:
        if salvo:
            salvo["erro"] = f"fonte indisponível: {e}"[:200]
        return salvo
    con.kv_gravar("sopr_btc", novo)
    return novo


if __name__ == "__main__":
    r = calcular(baixar())
    h = r["hoje"]
    print(f"{h['data']}: preço {h['preco']:,.0f} · custo {h['custo']:,.0f} ({h['acima']:+.1%}) · "
          f"SOPR7d {h['sopr7']:.4f} · {h['comportamento']} · rank {h['rank']:.0%}")
    print(f"faixas: " + " · ".join(f"{k} {v:.4f}" for k, v in r["faixas"].items()) + f" · ajuste R² {r['ajuste']['r2']:.2f}")
    for nv in r["niveis"]:
        print(f"  {nv['preco']:>10,.0f} {nv['dist']:+7.1%}  {nv['nome']}")
    for tipo, hs in r["estudo"].items():
        print(tipo, " · ".join(f"{h}d: n={v['n']} med {v['mediana']:+.1%} méd {v['media']:+.1%} subiu {v['subiu']:.0%}"
                               for h, v in hs.items() if v["n"]))
    print("últimos eventos:", [(e["data"], e["tipo"]) for e in r["eventos"][:8]])
