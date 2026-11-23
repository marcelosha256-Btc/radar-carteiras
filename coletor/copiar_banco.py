"""Copia o histórico de um banco Postgres (o Neon antigo) para o banco atual do radar (o Supabase), sem duplicar.

Precisa de duas linhas no .env da raiz (nenhuma é impressa):
  DATABASE_URL=...          o banco NOVO (destino): o mesmo que o radar já usa
  DATABASE_URL_ORIGEM=...   o banco ANTIGO (origem): a URL do Neon

  python copiar_banco.py --simular     # só compara as contagens, não grava nada
  python copiar_banco.py               # copia tudo o que falta
  python copiar_banco.py --tabelas sinais,operacoes,regime
  python copiar_banco.py --pular candles,funding   # (já copiados pelo historico_local.py)

Regras: só lê da origem; no destino usa INSERT ... ON CONFLICT DO NOTHING, então o que o banco novo já coletou
nesses dias fica como está e rodar duas vezes não duplica. As tabelas do Diário (sinais, acoes_sinais,
acoes_swing_sinais) têm id automático e os ids do banco novo já foram usados: elas são copiadas SEM o id, pulando o que
já existe (mesma origem/endereço/moeda/abertura).
"""
import argparse
import os
import sys
import time

from db import RAIZ, Banco, limpar_url

LOTE = 5000
COM_ID = {"sinais", "acoes_sinais", "acoes_swing_sinais"}
FECHAMENTO = {"id", "fechado_em", "preco_fechamento", "retorno", "r"}   # colunas que mudam quando o sinal fecha


def ler_env(chave):
    if os.environ.get(chave):
        return limpar_url(os.environ[chave])
    arq = RAIZ / ".env"
    if arq.exists():
        for linha in arq.read_text(encoding="utf-8").splitlines():
            if linha.strip().startswith(chave + "="):
                return limpar_url(linha.split("=", 1)[1])
    return ""


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def abrir_origem(url):
    libs = RAIZ / "libs"
    if libs.exists() and str(libs) not in sys.path:
        sys.path.insert(0, str(libs))
    import psycopg
    return psycopg.connect(url, prepare_threshold=None, connect_timeout=30, autocommit=True)


def colunas_origem(orig, tabela, esquema):
    with orig.cursor() as c:
        c.execute("SELECT column_name FROM information_schema.columns WHERE table_schema=%s AND table_name=%s "
                  "ORDER BY ordinal_position", (esquema, tabela))
        return [r[0] for r in c.fetchall()]


def pk_origem(orig, tabela, esquema):
    with orig.cursor() as c:
        c.execute("""SELECT kcu.column_name FROM information_schema.table_constraints tc
                     JOIN information_schema.key_column_usage kcu
                       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = %s AND tc.table_name = %s
                     ORDER BY kcu.ordinal_position""", (esquema, tabela))
        return [r[0] for r in c.fetchall()]


def contar_d(dest, tabela):
    return dest.execute(f'SELECT COUNT(*) AS n FROM "{tabela}"').fetchone()["n"]


def copiar_tabela(orig, dest, tabela, esq_orig, simular):
    cols_o = colunas_origem(orig, tabela, esq_orig)
    if not cols_o:
        return "não existe na origem"
    with orig.cursor() as c:
        c.execute(f'SELECT COUNT(*) FROM "{tabela}"')
        n_o = c.fetchone()[0]
    esq_d = dest.execute("SELECT current_schema() AS s").fetchone()["s"]
    cols_d = [r["column_name"] for r in dest.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position",
        (esq_d, tabela))]
    cols = [c for c in cols_d if c in cols_o]
    if simular:
        return f"origem {n_o:,} · destino {contar_d(dest, tabela):,}"
    marcas = ", ".join("?" * len(cols))
    lista = ", ".join(f'"{c}"' for c in cols)
    if tabela in COM_ID:
        cols = [c for c in cols if c != "id"]
        lista = ", ".join(f'"{c}"' for c in cols)
        marcas = ", ".join("?" * len(cols))
        nat = [c for c in cols if c not in FECHAMENTO]
        existentes = {tuple(r[c] for c in nat) for r in dest.execute(f'SELECT {", ".join(nat)} FROM "{tabela}"')}
        with orig.cursor() as c:
            c.execute(f'SELECT {lista} FROM "{tabela}" ORDER BY id')
            linhas = [r for r in c.fetchall() if tuple(r[cols.index(k)] for k in nat) not in existentes]
        for i in range(0, len(linhas), LOTE):
            dest.executemany(f'INSERT INTO "{tabela}" ({lista}) VALUES ({marcas})', linhas[i:i + LOTE])
        dest.commit()
        return f"copiadas {len(linhas):,} (de {n_o:,}) · destino agora {contar_d(dest, tabela):,}"
    pk = pk_origem(orig, tabela, esq_orig)
    sql = f'INSERT INTO "{tabela}" ({lista}) VALUES ({marcas}) ON CONFLICT DO NOTHING'
    lidas, ultimo = 0, None
    with orig.cursor() as c:
        while True:
            if not pk:   # sem chave primária: lê tudo de uma vez
                c.execute(f'SELECT {lista} FROM "{tabela}"')
            else:
                pks = ", ".join(f'"{k}"' for k in pk)
                if ultimo is None:
                    c.execute(f'SELECT {lista} FROM "{tabela}" ORDER BY {pks} LIMIT {LOTE}')
                else:
                    c.execute(f'SELECT {lista} FROM "{tabela}" WHERE ({pks}) > ({", ".join(["%s"] * len(pk))}) '
                              f'ORDER BY {pks} LIMIT {LOTE}', ultimo)
            lote = c.fetchall()
            if not lote:
                break
            dest.executemany(sql, lote)
            lidas += len(lote)
            if not pk or len(lote) < LOTE:
                break
            ultimo = tuple(lote[-1][cols.index(k)] for k in pk)
    dest.commit()
    return f"lidas {lidas:,} · destino agora {contar_d(dest, tabela):,} (origem {n_o:,})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--simular", action="store_true")
    ap.add_argument("--tabelas", default=None)
    ap.add_argument("--pular", default="")
    ap.add_argument("--esquema-origem", default="public")
    a = ap.parse_args()
    url_o, url_d = ler_env("DATABASE_URL_ORIGEM"), ler_env("DATABASE_URL")
    if not url_o or not url_d:
        sys.exit("Faltam DATABASE_URL (destino) e/ou DATABASE_URL_ORIGEM (origem) no .env.")
    if url_o == url_d:
        sys.exit("Origem e destino são o mesmo banco: nada a copiar.")
    dest = Banco(url_d)
    if not dest.pg:
        sys.exit("O destino precisa ser Postgres.")
    orig = abrir_origem(url_o)
    esq = dest.execute("SELECT current_schema() AS s").fetchone()["s"]
    tabelas = [r["table_name"] for r in dest.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE' "
        "ORDER BY table_name", (esq,))]
    if a.tabelas:
        tabelas = [t for t in tabelas if t in a.tabelas.split(",")]
    pular = set(filter(None, a.pular.split(",")))
    log(f"destino: schema '{esq}' · {len(tabelas)} tabelas" + (" · SIMULAÇÃO (nada é gravado)" if a.simular else ""))
    for t in tabelas:
        if t in pular:
            log(f"{t:22s} pulada")
            continue
        try:
            log(f"{t:22s} {copiar_tabela(orig, dest, t, a.esquema_origem, a.simular)}")
        except Exception as e:
            log(f"{t:22s} ERRO {repr(e)[:160]}")
    if not a.simular:   # as sequências dos ids automáticos continuam do maior id existente
        for t in COM_ID:
            try:
                dest.execute(f"SELECT setval(pg_get_serial_sequence('{t}', 'id'), COALESCE((SELECT MAX(id) FROM {t}), 1))")
            except Exception as e:
                log(f"sequência de {t}: {repr(e)[:120]}")
        log("pronto. Confira com: python copiar_banco.py --simular")


if __name__ == "__main__":
    main()
