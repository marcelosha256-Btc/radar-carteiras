"""Limpeza das tabelas que mais crescem, para o banco ficar abaixo do limite do plano (500 MB no Supabase gratuito).

  python limpeza.py              # só mostra o tamanho de cada tabela e quantas linhas seriam apagadas (não apaga nada)
  python limpeza.py --aplicar    # apaga de verdade

Só mexe em séries de tempo que o radar usa nos últimos dias ou meses. Nunca toca no Diário (sinais), nas operações,
no regime, nos candles, no funding nem no kv. Os prazos estão em RETENCAO (dias) e podem ser ajustados.
O Postgres reaproveita o espaço apagado; o tamanho no painel do Supabase só encolhe depois do autovacuum.
"""
import argparse
import time

from db import conectar

# tabela: (coluna de tempo em ms, dias que ficam)
RETENCAO = {
    "livro": ("tempo", 21),             # livro de ofertas por faixa de preço: a leitura usa só o mais recente
    "binance_oi": ("t", 180),           # open interest de 5 min
    "alertas": ("tempo", 120),          # alertas das carteiras de cripto
    "acoes_alertas": ("tempo", 120),    # idem, ações
    "liquidez_hist": ("tempo", 180),    # mapa de stops ao longo do tempo
    "formadores_pos": ("tempo", 180),   # posição dos formadores de mercado
    "mercado_hist": ("tempo", 365),     # preço, open interest e funding da Hyperliquid
}
LOTE = 20000


def log(msg):
    print(time.strftime("%H:%M:%S"), "[limpeza]", msg, flush=True)


def tamanhos(con):
    return con.execute("""SELECT relname AS tabela, pg_total_relation_size(c.oid) AS bytes
                          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY bytes DESC""").fetchall()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aplicar", action="store_true")
    a = ap.parse_args()
    con = conectar()
    if not con.pg:
        raise SystemExit("A limpeza é para o Postgres (o banco da nuvem).")
    tam = tamanhos(con)
    log(f"banco: {sum(r['bytes'] for r in tam) / 1e6:.0f} MB · maiores: "
        + " · ".join(f"{r['tabela']} {r['bytes'] / 1e6:.0f} MB" for r in tam[:6]))
    agora = int(time.time() * 1000)
    total = 0
    for tab, (col, dias) in RETENCAO.items():
        corte = agora - dias * 86_400_000
        try:
            n = con.execute(f'SELECT COUNT(*) AS n FROM "{tab}" WHERE "{col}" < ?', (corte,)).fetchone()["n"]
        except Exception as e:
            log(f"{tab}: ignorada ({repr(e)[:80]})")
            continue
        if not a.aplicar:
            log(f"{tab:16s} {n:>9,} linhas com mais de {dias} dias seriam apagadas")
            continue
        apagadas = 0
        while apagadas < n:   # em lotes: uma transação gigante trava o banco
            con.execute(f'DELETE FROM "{tab}" WHERE ctid IN (SELECT ctid FROM "{tab}" WHERE "{col}" < ? LIMIT {LOTE})', (corte,))
            con.commit()
            apagadas += LOTE
        total += n
        log(f"{tab:16s} {n:,} linhas apagadas (mais de {dias} dias)")
    log(f"total apagado: {total:,} linhas" if a.aplicar else "simulação: nada foi apagado. Use --aplicar para apagar.")


if __name__ == "__main__":
    main()
