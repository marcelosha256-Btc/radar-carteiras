"""Histórico da Hyperliquid para o backtest: candles (15m, 1h, 4h, 1d) e funding de hora em hora.

A Hyperliquid só devolve os 5.000 candles mais recentes de cada intervalo (medido em 23/11/2026: 1h vai
até ~29/04/2026, 4h até ~08/2024, 1d desde o início de cada moeda). Quem não gravar perde o 1h mais
antigo para sempre — por isso esta rotina roda todo dia e só acrescenta o que falta.
O 15m (~52 dias na API) serve para decidir, no backtest, se o stop ou o alvo veio primeiro quando os dois
caem no mesmo candle; gravado todo dia, esse desempate passa a valer para operações cada vez mais antigas.
O funding tem o histórico inteiro na API (de 500 em 500, desde a listagem), então a primeira execução
já pega tudo.

Para acrescentar moedas: inclua o nome em ATIVOS (o nome da Hyperliquid, ex.: "DOGE") ou passe
--ativos BTC,ETH,DOGE. A primeira execução de uma moeda nova grava todo o histórico disponível.

  python historico_hl.py                 # completa tudo
  python historico_hl.py --se-velho 20   # só se a última execução tiver mais de 20 h (laço da nuvem)
"""
import argparse
import os
import time

from db import conectar
from hl import Hyperliquid

ATIVOS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "NEAR"]
HORA = 3_600_000
INTERVALOS = {"15m": HORA // 4, "1h": HORA, "4h": 4 * HORA, "1d": 24 * HORA}   # 15m: desempate stop × alvo no backtest
NA_NUVEM = bool(os.environ.get("GITHUB_ACTIONS"))


def log(msg):
    print(time.strftime("%H:%M:%S"), "[histórico HL]", msg, flush=True)


def gravar_candles(hl, con, coin, iv, agora):
    r = con.execute('SELECT MAX(ts) AS t FROM candles WHERE coin=? AND "interval"=?', (coin, iv)).fetchone()
    ini = (r["t"] + 1) if r and r["t"] is not None else 0
    velas = hl.info({"type": "candleSnapshot", "req": {"coin": coin, "interval": iv, "startTime": ini, "endTime": agora}}) or []
    dur = INTERVALOS[iv]
    linhas = [(coin, iv, int(v["t"]), float(v["o"]), float(v["h"]), float(v["l"]), float(v["c"]), float(v["v"]))
              for v in velas if int(v["t"]) >= ini and int(v["t"]) + dur <= agora]   # só candles fechados e novos
    con.executemany('INSERT INTO candles (coin, "interval", ts, o, h, l, c, v) VALUES (?,?,?,?,?,?,?,?) '
                    'ON CONFLICT DO NOTHING', linhas)
    con.commit()
    return len(linhas)


def gravar_funding(hl, con, coin):
    r = con.execute("SELECT MAX(ts) AS t FROM funding WHERE coin=?", (coin,)).fetchone()
    ini = (r["t"] + 1) if r and r["t"] is not None else 0
    total = 0
    while True:
        pts = hl.info({"type": "fundingHistory", "coin": coin, "startTime": ini}) or []
        if not pts:
            break
        con.executemany("INSERT INTO funding (coin, ts, rate) VALUES (?,?,?) ON CONFLICT DO NOTHING",
                        [(coin, int(p["time"]), float(p["fundingRate"])) for p in pts])
        con.commit()
        total += len(pts)
        if len(pts) < 500:
            break
        ini = int(pts[-1]["time"]) + 1
        time.sleep(0.2)
    return total


def executar(con=None, hl=None, ativos=None):
    con = con or conectar()
    hl = hl or Hyperliquid()
    agora = int(time.time() * 1000)
    resumo = {}
    for coin in ativos or ATIVOS:
        try:
            n = {iv: gravar_candles(hl, con, coin, iv, agora) for iv in INTERVALOS}
            n["funding"] = gravar_funding(hl, con, coin)
            resumo[coin] = n
        except Exception as e:   # uma moeda com problema não impede as outras
            resumo[coin] = {"erro": repr(e)[:200]}
        time.sleep(0.3)
    con.kv_gravar("historico_hl", {"gerado": agora, "resumo": resumo})
    log(" · ".join(f"{k}: {v}" for k, v in resumo.items()))
    return resumo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--se-velho", type=float, default=None)
    ap.add_argument("--ativos", default=None, help="lista separada por vírgula (padrão: ATIVOS)")
    a = ap.parse_args()
    con = conectar()
    if a.se_velho is not None:
        v = con.kv_ler("historico_hl")
        if v and time.time() * 1000 - v["gerado"] < a.se_velho * 3_600_000:
            return
    inicio, ok, det = time.time(), True, ""
    try:
        r = executar(con, ativos=a.ativos.split(",") if a.ativos else None)
        det = f"{sum(sum(x for k, x in v.items() if k != 'erro') for v in r.values() if 'erro' not in v)} linhas novas"
    except Exception as e:
        ok, det = False, repr(e)
        raise
    finally:
        try:
            lista = (con.kv_ler("execucoes") or [])[-199:]
            lista.append({"tempo": int(time.time() * 1000), "tipo": "historico_hl", "origem": "github" if NA_NUVEM else "pc",
                          "ok": ok, "detalhe": det[:200]})
            con.kv_gravar("execucoes", lista)
        except Exception:
            pass
        log(f"{(time.time() - inicio) / 60:.1f} min")


if __name__ == "__main__":
    main()
