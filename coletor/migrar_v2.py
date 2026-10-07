"""Converte o banco da fase 1 (data/radar.db, com todos os fills) para o formato novo
(data/radar2.db, só operações + estados). Roda uma vez."""
import json
import os
import sqlite3
import time
from collections import defaultdict

import analise as an
from db import RAIZ, Banco

os.environ.pop("DATABASE_URL", None)
DIA = 86_400_000
velho = sqlite3.connect(RAIZ / "data" / "radar.db")
velho.row_factory = sqlite3.Row
novo = Banco("")
agora = int(time.time() * 1000)

novo.executemany("INSERT INTO carteiras VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                 [tuple(r) for r in velho.execute("SELECT * FROM carteiras")])

copia = {(r["endereco"], r["moeda"], r["t0"]): r["retorno_copia"]
         for r in velho.execute("SELECT endereco, moeda, t0, retorno_copia FROM operacoes")}
n_ops = 0
fluxo = defaultdict(lambda: [0.0, 0.0])
for (end,) in velho.execute("SELECT endereco FROM carteiras WHERE robo=0").fetchall():
    fills = [dict(r) for r in velho.execute("SELECT * FROM fills WHERE endereco=? ORDER BY tempo", (end,))]
    ops, estados = an.montar_operacoes(fills)
    novo.executemany("INSERT INTO operacoes VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", [
        (end, o["moeda"], o["lado"], o["t0"], o["t1"], o["preco_entrada"], o["preco_saida"], o["tamanho_max"],
         o["pnl"], o["retorno"], o["horas"], copia.get((end, o["moeda"], o["t0"]))) for o in ops])
    novo.executemany("INSERT INTO estados VALUES (?,?,?) ON CONFLICT DO NOTHING",
                     [(end, m, json.dumps(e) if e else None) for m, e in estados.items()])
    for f in fills:
        if f["tempo"] >= agora - 35 * DIA and an.eh_perp(f["moeda"]):
            fluxo[(f["tempo"] // DIA * DIA, f["moeda"])][0 if f["lado"] == "B" else 1] += f["preco"] * f["tamanho"]
    n_ops += len(ops)
novo.executemany("INSERT INTO fluxo_diario VALUES (?,?,?,?) ON CONFLICT DO NOTHING",
                 [(d, m, c, v) for (d, m), (c, v) in fluxo.items()])

for tabela, n in (("velas", 4), ("posicoes", 9), ("alertas", 10), ("fotos", 2)):
    filtro = f" WHERE t>={agora - 93 * DIA}" if tabela == "velas" else ""
    novo.executemany(f"INSERT INTO {tabela} VALUES ({','.join('?' * n)}) ON CONFLICT DO NOTHING",
                     [tuple(r) for r in velho.execute(f"SELECT * FROM {tabela}{filtro}")])
novo.executemany("INSERT INTO sinais (id, origem, endereco, moeda, lado, aberto_em, preco_abertura, fechado_em, "
                 "preco_fechamento, retorno) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                 [tuple(r) for r in velho.execute("SELECT * FROM sinais")])
novo.commit()
novo.kv_gravar("ranking", json.loads((RAIZ / "data" / "ranking.json").read_text(encoding="utf-8")))
print(f"operações {n_ops} · estados abertos "
      f"{novo.execute('SELECT COUNT(*) FROM estados WHERE estado IS NOT NULL').fetchone()[0]} · "
      f"fluxo {len(fluxo)} dias×moedas · tamanho {os.path.getsize(RAIZ / 'data' / 'radar2.db') / 1e6:.1f} MB")
