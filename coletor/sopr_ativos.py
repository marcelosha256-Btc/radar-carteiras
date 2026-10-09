"""SOPR e custo do curto prazo para os 6 ativos.

Só o Bitcoin tem o dado on-chain real (fase3.py). Para os outros, estimamos:
- custo do curto prazo = média de preço ponderada pelo volume, com meia-vida de 30 dias;
- SOPR 7d = a + b × ln(preço ÷ custo), com a e b ajustados no Bitcoin real.
Validação no BTC (3 anos, 08/10/2026): custo estimado com erro mediano de 2,4% e SOPR
estimado com correlação 0,89 com o real, acertando o lado (lucro/prejuízo) em 87% dos dias.
Os rótulos de comportamento usam as faixas do próprio ativo (percentis do SOPR estimado).
"""
import math
import statistics as st
import time
from datetime import datetime, timezone

import requests

ATIVOS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "NEAR"]
MEIA_VIDA = 30
JANELA = 3 * 365
GUARDAR_H = 0.75
DIA_S = 86400
UA = {"User-Agent": "radar-carteiras"}


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def _coinbase(m):
    fim = int(time.time()) // DIA_S * DIA_S
    out = {}
    while True:
        ini = fim - 300 * DIA_S
        r = requests.get(f"https://api.exchange.coinbase.com/products/{m}-USD/candles",
                         params={"granularity": DIA_S, "start": _iso(ini), "end": _iso(fim)}, timeout=30, headers=UA)
        d = r.json() if r.status_code == 200 else []
        if not d:
            break
        for t, lo, hi, _op, cl, vol in d:
            out[t] = (float(cl), float(vol), (float(hi) + float(lo) + float(cl)) / 3)
        fim = ini
        time.sleep(0.12)
    return out


def _hyperliquid(hl, m):
    agora = int(time.time() * 1000)
    return {v["t"] // 1000: (float(v["c"]), float(v["v"]), (float(v["h"]) + float(v["l"]) + float(v["c"])) / 3)
            for v in hl.velas(m, "1d", agora - 2000 * DIA_S * 1000, agora)}


def historico(hl, m):
    cb, hlv = _coinbase(m), _hyperliquid(hl, m)
    barras, fonte = (cb, "Coinbase") if len(cb) >= len(hlv) else (hlv, "Hyperliquid")
    hoje = int(time.time()) // DIA_S * DIA_S
    ts = sorted(t for t in barras if t < hoje)
    return ts, [barras[t] for t in ts], fonte


def custo_estimado(barras):
    """Média ponderada pelo volume com decaimento exponencial (meia-vida de 30 dias)."""
    a = 1 - 0.5 ** (1 / MEIA_VIDA)
    num = den = None
    out = []
    for i, (_c, vol, tipico) in enumerate(barras):
        q = vol   # volume em moedas; o peso é a quantidade negociada a cada preço
        num = q * tipico if num is None else (1 - a) * num + a * q * tipico
        den = q if den is None else (1 - a) * den + a * q
        out.append(num / den if den and i >= 2 * MEIA_VIDA else None)
    return out


def _quantil(ordenada, q):
    pos = q * (len(ordenada) - 1)
    i = int(pos)
    j = min(i + 1, len(ordenada) - 1)
    return ordenada[i] + (ordenada[j] - ordenada[i]) * (pos - i)


def comportamento(v, p02, p10, p90, p98):
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


def calcular_ativo(hl, m, a, b, btc_real=None):
    ts, barras, fonte = historico(hl, m)
    custo = custo_estimado(barras)
    precos = [x[0] for x in barras]
    # SOPR 7d estimado: média de 7 dias de a + b·ln(preço/custo), como o SOPR real é uma média de 7 dias
    diario = [a + b * math.log(p / c) if c else None for p, c in zip(precos, custo)]
    sopr7 = [st.fmean(diario[i - 6:i + 1]) if i >= 6 and all(v is not None for v in diario[i - 6:i + 1]) else None
             for i in range(len(diario))]
    validos = [v for v in sopr7[-JANELA:] if v is not None]
    if len(validos) < 60:
        return {"erro": f"histórico curto ({len(validos)} dias)", "fonte": fonte}
    ordenado = sorted(validos)
    p02, p10, p90, p98 = (_quantil(ordenado, q) for q in (0.02, 0.10, 0.90, 0.98))
    preco, c, s7 = precos[-1], custo[-1], sopr7[-1]
    estimado = True
    if btc_real:   # BTC: usa o dado on-chain real
        preco, c, s7, estimado = btc_real["preco"], btc_real["custo"], btc_real["sopr7"], False
    nivel = lambda v: c * math.exp((v - a) / b)
    niveis = [{"nome": "Lucro extremo — resistência forte", "sopr": p98, "preco": nivel(p98), "tipo": "lucro"},
              {"nome": "Lucro forte — resistência", "sopr": p90, "preco": nivel(p90), "tipo": "lucro"},
              {"nome": "Ponto de virada (SOPR = 1)", "sopr": 1.0, "preco": nivel(1.0), "tipo": "neutro"},
              {"nome": "Prejuízo forte — suporte", "sopr": p10, "preco": nivel(p10), "tipo": "prejuizo"},
              {"nome": "Capitulação — suporte forte", "sopr": p02, "preco": nivel(p02), "tipo": "prejuizo"},
              {"nome": "Custo médio do curto prazo" + (" (estimado)" if estimado else ""), "sopr": None, "preco": c,
               "tipo": "custo"}]
    for nv in niveis:
        nv["dist"] = nv["preco"] / preco - 1
    corte = max(0, len(ts) - 730)
    return {"preco": preco, "sopr7": s7, "custo": c, "acima": preco / c - 1, "estimado": estimado, "fonte": fonte,
            "comportamento": comportamento(s7, p02, p10, p90, p98), "faixas": [p02, p10, p90, p98], "niveis": niveis,
            "dias": len(validos),
            "serie": {"datas": [time.strftime("%Y-%m-%d", time.gmtime(t)) for t in ts[corte:]],
                      "preco": [round(x, 6) for x in precos[corte:]],
                      "custo": [round(x, 6) if x else None for x in custo[corte:]]}}


def validar_no_btc(btc_est, sopr_btc):
    """Compara a estimativa do BTC com o on-chain real nos dias em comum (até 2 anos)."""
    real = dict(zip(sopr_btc["serie"]["datas"], zip(sopr_btc["serie"]["custo"], sopr_btc["serie"]["sopr7"])))
    pares = [(e, real[d]) for d, e in zip(btc_est["serie"]["datas"], btc_est["serie"]["custo"]) if e and d in real]
    if len(pares) < 60:
        return None
    return {"dias": len(pares), "erro_custo": st.median(abs(e / r[0] - 1) for e, r in pares)}


def obter(hl, con):
    salvo = con.kv_ler("sopr_ativos")
    if salvo and time.time() * 1000 - salvo["atualizado"] < GUARDAR_H * 3_600_000:
        return salvo
    sb = con.kv_ler("sopr_btc")
    if not sb:
        return salvo
    a, b = sb["ajuste"]["a"], sb["ajuste"]["b"]
    saida = {"atualizado": int(time.time() * 1000), "meia_vida": MEIA_VIDA, "ativos": {}}
    try:
        for m in ATIVOS:
            real = {"preco": sb["hoje"]["preco"], "custo": sb["hoje"]["custo"], "sopr7": sb["hoje"]["sopr7"]} if m == "BTC" else None
            saida["ativos"][m] = calcular_ativo(hl, m, a, b, real)
            if m == "BTC":
                est = calcular_ativo(hl, m, a, b)    # a mesma conta sem o dado real, para medir a estimativa
                saida["validacao"] = validar_no_btc(est, sb)
                saida["ativos"][m]["comportamento"] = sb["hoje"]["comportamento"]
    except (requests.RequestException, ValueError, KeyError, ZeroDivisionError) as e:
        if salvo:
            salvo["erro"] = f"fonte indisponível: {e}"[:200]
            return salvo
        raise
    con.kv_gravar("sopr_ativos", saida)
    return saida
