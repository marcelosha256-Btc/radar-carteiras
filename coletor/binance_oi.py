"""Guarda o histórico de open interest de 5 min da Binance (a Binance só mantém 30 dias).

Serve para testar depois, com mais meses, o mapa estimado de liquidação e a "possível cascata"
(o teste de 11/11/2026 só teve 30 dias, todos de queda). Só roda no PC: a Binance bloqueia os
servidores do GitHub (EUA). Como a Binance guarda 30 dias, o PC pode ficar desligado até ~4 semanas
sem perder nada; a próxima execução completa o buraco.

  python binance_oi.py     # completa o que falta e mostra quantos pontos há por moeda
"""
import time

import requests

from db import conectar

ATIVOS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "NEAR"]
API = "https://fapi.binance.com/futures/data/openInterestHist"
PASSO = 300_000            # 5 min
GUARDA = 29 * 86_400_000   # a Binance devolve no máximo ~30 dias para trás


def gravar(con, log=print):
    agora = int(time.time() * 1000)
    total = 0
    for a in ATIVOS:
        r = con.execute("SELECT MAX(t) AS t FROM binance_oi WHERE moeda=?", (a,)).fetchone()
        ini = max((r["t"] or 0) + PASSO, agora - GUARDA)
        linhas = []
        while ini < agora - PASSO:
            fim = min(ini + 499 * PASSO, agora)
            resp = requests.get(API, params={"symbol": a + "USDT", "period": "5m", "limit": 500,
                                             "startTime": ini, "endTime": fim}, timeout=30)
            resp.raise_for_status()
            raw = resp.json()
            linhas += [(a, int(x["timestamp"]), float(x["sumOpenInterest"]), float(x["sumOpenInterestValue"])) for x in raw]
            ini = fim + 1
            time.sleep(0.2)
        con.executemany("INSERT INTO binance_oi VALUES (?,?,?,?) ON CONFLICT DO NOTHING", linhas)
        con.commit()
        total += len(linhas)
    log(f"open interest da Binance: {total} pontos novos")
    return total


if __name__ == "__main__":
    c = conectar()
    gravar(c)
    for r in c.execute("SELECT moeda, COUNT(*) AS n, MIN(t) AS de, MAX(t) AS ate FROM binance_oi GROUP BY moeda ORDER BY moeda").fetchall():
        print(r["moeda"], r["n"], time.strftime("%d/%m %H:%M", time.localtime(r["de"] / 1000)), "→",
              time.strftime("%d/%m %H:%M", time.localtime(r["ate"] / 1000)))
