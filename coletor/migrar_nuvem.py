"""Copia o banco local (data/radar2.db) para o Supabase. Roda uma vez, na migração.

A connection string vem do arquivo .env na raiz do projeto (DATABASE_URL=...).
"""
import sqlite3

from db import RAIZ, Banco

TABELAS = ["carteiras", "estados", "operacoes", "fluxo_diario", "velas", "posicoes", "ordens", "livro",
           "regime", "alertas", "sinais", "fotos", "kv"]


def ler_env():
    for linha in (RAIZ / ".env").read_text(encoding="utf-8").splitlines():
        if linha.strip().startswith("DATABASE_URL="):
            return linha.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("Não achei DATABASE_URL no arquivo .env")


local = sqlite3.connect(RAIZ / "data" / "radar2.db")
nuvem = Banco(ler_env())
for t in TABELAS:
    cols = [c[1] for c in local.execute(f"PRAGMA table_info({t})")]
    linhas = local.execute(f"SELECT {','.join(cols)} FROM {t}").fetchall()
    nuvem.execute(f"DELETE FROM {t}")
    for i in range(0, len(linhas), 5000):
        nuvem.executemany(f"INSERT INTO {t} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", linhas[i:i + 5000])
    nuvem.commit()
    print(f"{t}: {len(linhas)} linhas", flush=True)
# a sequência do id dos sinais precisa continuar depois do último id copiado
nuvem.execute("SELECT setval(pg_get_serial_sequence('sinais','id'), COALESCE((SELECT MAX(id) FROM sinais), 1))")
nuvem.commit()
print("pronto")
