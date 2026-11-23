"""Histórico da Hyperliquid gravado no PC, para não perder candles enquanto o banco da nuvem está fora.

A Hyperliquid só entrega os 5.000 candles mais recentes de cada intervalo; o que passa desse limite some para
sempre. Quando o Postgres (Neon) fica sem cota, a rotina da nuvem não consegue gravar. Esta rotina faz o mesmo
trabalho de historico_hl.py num arquivo SQLite local (data/historico_local.db) e, quando o banco da nuvem
voltar, copia para lá só o que ele ainda não tem (INSERT ... ON CONFLICT DO NOTHING: rodar duas vezes não duplica).

  python historico_local.py              # grava no PC (se passou de 20 h) e tenta copiar para o banco
  python historico_local.py --forcar     # ignora os intervalos de espera
  python historico_local.py --so-copiar  # não baixa nada; só tenta copiar para o banco da nuvem
"""
import argparse
import time
from pathlib import Path

import historico_hl
from db import conectar

ARQUIVO = Path(__file__).resolve().parent.parent / "data" / "historico_local.db"
ESPERA_GRAVAR_H = 20     # grava no máximo 1 vez a cada 20 h
ESPERA_COPIAR_H = 6      # tenta copiar para a nuvem no máximo a cada 6 h (se ela estiver fora, não adianta insistir)
LOTE = 2000


def log(msg):
    print(time.strftime("%H:%M:%S"), "[histórico local]", msg, flush=True)


def _velho(local, chave, horas):
    v = local.kv_ler(chave)
    return not v or time.time() * 1000 - v.get("tempo", 0) > horas * 3_600_000


def gravar(local):
    resumo = historico_hl.executar(local)
    local.kv_gravar("local_gravou", {"tempo": int(time.time() * 1000)})
    return resumo


def copiar(local, remoto):
    """Copia candles e funding que o banco remoto ainda não tem. A marca d'água fica no arquivo local
    (só avança depois que o lote entra), então uma queda no meio recomeça de onde parou."""
    marca = local.kv_ler("local_copiado") or {"candles": {}, "funding": {}}
    total = 0
    chaves = [(r["coin"], r["interval"]) for r in local.execute('SELECT DISTINCT coin, "interval" FROM candles')]
    for coin, iv in chaves:
        k = f"{coin}|{iv}"
        desde = marca["candles"].get(k, -1)
        while True:
            lin = local.execute('SELECT coin, "interval", ts, o, h, l, c, v FROM candles '
                                'WHERE coin=? AND "interval"=? AND ts>? ORDER BY ts LIMIT ?', (coin, iv, desde, LOTE)).fetchall()
            if not lin:
                break
            remoto.executemany('INSERT INTO candles (coin, "interval", ts, o, h, l, c, v) VALUES (?,?,?,?,?,?,?,?) '
                               'ON CONFLICT DO NOTHING', [tuple(r) for r in lin])
            desde = lin[-1]["ts"]
            marca["candles"][k] = desde
            total += len(lin)
            local.kv_gravar("local_copiado", marca)
    for coin in [r["coin"] for r in local.execute("SELECT DISTINCT coin FROM funding")]:
        desde = marca["funding"].get(coin, -1)
        while True:
            lin = local.execute("SELECT coin, ts, rate FROM funding WHERE coin=? AND ts>? ORDER BY ts LIMIT ?",
                                (coin, desde, LOTE)).fetchall()
            if not lin:
                break
            remoto.executemany("INSERT INTO funding (coin, ts, rate) VALUES (?,?,?) ON CONFLICT DO NOTHING",
                               [tuple(r) for r in lin])
            desde = lin[-1]["ts"]
            marca["funding"][coin] = desde
            total += len(lin)
            local.kv_gravar("local_copiado", marca)
    return total


def rotina(forcar=False, so_copiar=False):
    """Chamada pela coleta horária do PC (antes de abrir o banco da nuvem, que pode estar fora)."""
    local = conectar(caminho=ARQUIVO)
    if not so_copiar and (forcar or _velho(local, "local_gravou", ESPERA_GRAVAR_H)):
        log("gravando o histórico no PC…")
        gravar(local)
    if forcar or so_copiar or _velho(local, "local_tentou_copiar", ESPERA_COPIAR_H):
        local.kv_gravar("local_tentou_copiar", {"tempo": int(time.time() * 1000)})
        try:
            remoto = conectar()
            if not remoto.pg:
                log("sem DATABASE_URL: nada para copiar")
                return
            n = copiar(local, remoto)
            log(f"copiei {n} linhas para o banco da nuvem")
        except Exception as e:   # banco fora do ar (cota do Neon): tenta de novo mais tarde
            log(f"banco da nuvem indisponível ({repr(e)[:120]}); a cópia fica para depois")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--forcar", action="store_true")
    ap.add_argument("--so-copiar", action="store_true")
    a = ap.parse_args()
    rotina(a.forcar, a.so_copiar)
