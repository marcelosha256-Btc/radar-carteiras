"""Banco do radar: Postgres (Supabase) quando DATABASE_URL existe, SQLite local caso contrário.

O SQL do resto do código usa "?" como marcador e INSERT ... ON CONFLICT, que os dois
bancos entendem; aqui só se troca o marcador para o Postgres.
"""
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CAMINHO = RAIZ / "data" / "radar2.db"

ESQUEMA = """
CREATE TABLE IF NOT EXISTS carteiras (
  endereco TEXT PRIMARY KEY,
  valor_conta DOUBLE PRECISION, pnl_mes DOUBLE PRECISION, volume_mes DOUBLE PRECISION, pnl_total DOUBLE PRECISION,
  robo INTEGER DEFAULT 0,          -- 1 = alta frequência (fills truncados pela API)
  ultimo_fill BIGINT,              -- ms do último fill processado, para coleta incremental
  atualizado BIGINT
);
CREATE TABLE IF NOT EXISTS estados (
  endereco TEXT, moeda TEXT,
  estado TEXT,                     -- operação em andamento (JSON), continua na próxima coleta
  PRIMARY KEY (endereco, moeda)
);
CREATE TABLE IF NOT EXISTS operacoes (
  endereco TEXT, moeda TEXT, lado TEXT, t0 BIGINT, t1 BIGINT,
  preco_entrada DOUBLE PRECISION, preco_saida DOUBLE PRECISION, tamanho_max DOUBLE PRECISION,
  pnl DOUBLE PRECISION, retorno DOUBLE PRECISION, horas DOUBLE PRECISION,
  retorno_copia DOUBLE PRECISION,  -- mesma operação copiada com atraso, sem alavancagem
  PRIMARY KEY (endereco, moeda, t0)
);
CREATE TABLE IF NOT EXISTS fluxo_diario (
  dia BIGINT, moeda TEXT, compra DOUBLE PRECISION, venda DOUBLE PRECISION,   -- US$ negociado pelas carteiras rastreadas
  PRIMARY KEY (dia, moeda)
);
CREATE TABLE IF NOT EXISTS velas (
  moeda TEXT, t BIGINT, abertura DOUBLE PRECISION, fechamento DOUBLE PRECISION,
  PRIMARY KEY (moeda, t)
);
CREATE TABLE IF NOT EXISTS posicoes (
  endereco TEXT, moeda TEXT, lado TEXT, tamanho DOUBLE PRECISION, preco_entrada DOUBLE PRECISION,
  alavancagem DOUBLE PRECISION, pnl_aberto DOUBLE PRECISION, preco_liquidacao DOUBLE PRECISION, coletado BIGINT,
  PRIMARY KEY (endereco, moeda)
);
CREATE TABLE IF NOT EXISTS ordens (
  endereco TEXT, moeda TEXT, oid BIGINT,
  tipo TEXT,                       -- Limit | Stop Market | Take Profit Market | ...
  lado TEXT,                       -- B = compra, A = venda
  preco DOUBLE PRECISION,          -- preço de gatilho (stops e alvos) ou preço limite
  tamanho DOUBLE PRECISION, gatilho INTEGER, reduz INTEGER, coletado BIGINT,
  PRIMARY KEY (endereco, oid)
);
CREATE TABLE IF NOT EXISTS livro (
  tempo BIGINT, moeda TEXT, fonte TEXT, preco DOUBLE PRECISION, lado TEXT, valor DOUBLE PRECISION,  -- US$ por faixa
  PRIMARY KEY (tempo, moeda, fonte, preco, lado)
);
CREATE TABLE IF NOT EXISTS regime (
  tempo BIGINT, moeda TEXT, p_alta DOUBLE PRECISION, p_lateral DOUBLE PRECISION, p_baixa DOUBLE PRECISION,
  preco DOUBLE PRECISION, fatores TEXT,
  PRIMARY KEY (tempo, moeda)
);
CREATE TABLE IF NOT EXISTS alertas (
  tempo BIGINT, endereco TEXT, moeda TEXT,
  evento TEXT,                     -- abriu | fechou | aumentou | reduziu | virou
  lado TEXT, tamanho_antes DOUBLE PRECISION, tamanho_depois DOUBLE PRECISION, preco DOUBLE PRECISION,
  alavancagem DOUBLE PRECISION,
  confiavel INTEGER,               -- a carteira era confiável no momento do alerta
  PRIMARY KEY (tempo, endereco, moeda)
);
CREATE TABLE IF NOT EXISTS sinais (
  id {ID},
  origem TEXT,                     -- 'copia' (carteira confiável) ou o nome do setup de swing
  endereco TEXT, moeda TEXT, lado TEXT,
  aberto_em BIGINT, preco_abertura DOUBLE PRECISION,
  fechado_em BIGINT, preco_fechamento DOUBLE PRECISION,
  retorno DOUBLE PRECISION,        -- sem alavancagem, já com taxa de entrada e saída
  stop DOUBLE PRECISION, alvo DOUBLE PRECISION, r DOUBLE PRECISION   -- só nos sinais de swing
);
CREATE TABLE IF NOT EXISTS fotos (
  endereco TEXT PRIMARY KEY,       -- última foto das posições da carteira
  tempo BIGINT
);
CREATE TABLE IF NOT EXISTS kv (
  chave TEXT PRIMARY KEY,          -- ranking, painel, marcos de tempo
  valor TEXT, atualizado BIGINT
);
CREATE TABLE IF NOT EXISTS mercado_hist (
  tempo BIGINT, moeda TEXT, preco DOUBLE PRECISION,
  oi_usd DOUBLE PRECISION,          -- contratos abertos na Hyperliquid, em US$
  funding DOUBLE PRECISION,         -- funding anualizado em %
  PRIMARY KEY (tempo, moeda)
);
CREATE TABLE IF NOT EXISTS formadores_pos (
  tempo BIGINT, moeda TEXT,
  long_usd DOUBLE PRECISION, short_usd DOUBLE PRECISION,   -- posição somada dos formadores de mercado
  carteiras INTEGER,
  PRIMARY KEY (tempo, moeda)
);
CREATE INDEX IF NOT EXISTS ix_ops_t1 ON operacoes (t1);
CREATE INDEX IF NOT EXISTS ix_sinais_abertos ON sinais (endereco, moeda, fechado_em);
CREATE INDEX IF NOT EXISTS ix_livro_moeda ON livro (moeda, tempo);
CREATE INDEX IF NOT EXISTS ix_alertas_tempo ON alertas (tempo);
"""


# colunas acrescentadas depois que o banco já existia
COLUNAS_NOVAS = [
    ("sinais", "stop", "DOUBLE PRECISION"), ("sinais", "alvo", "DOUBLE PRECISION"), ("sinais", "r", "DOUBLE PRECISION"),
    ("carteiras", "primeira_atividade", "BIGINT"),   # ms da primeira atividade da conta (para marcar carteira nova)
    ("alertas", "rotulos", "TEXT"),                  # ex.: "delta neutro;carteira nova"
]


class Linha(dict):
    """Linha que aceita r["coluna"] e r[0], como o sqlite3.Row."""
    def __getitem__(self, k):
        return list(self.values())[k] if isinstance(k, int) else dict.__getitem__(self, k)


def _fabrica_linha(cursor):
    nomes = [c.name for c in cursor.description] if cursor.description else []
    return lambda valores: Linha(zip(nomes, valores))


def url_do_ambiente():
    """DATABASE_URL do ambiente (GitHub Actions) ou do arquivo .env na raiz (PC)."""
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    env = RAIZ / ".env"
    if env.exists():
        for linha in env.read_text(encoding="utf-8").splitlines():
            if linha.strip().startswith("DATABASE_URL="):
                return linha.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def limpar_url(url):
    """Aceita a string colada com sobras (prefixo DATABASE_URL=, aspas, outras linhas do .env)."""
    if not url or not url.strip():
        return None
    url = url.split()[0].strip().strip('"').strip("'")
    if url.startswith("DATABASE_URL="):
        url = url.split("=", 1)[1].strip('"').strip("'")
    return url


class Banco:
    def __init__(self, url=None):
        url = limpar_url(url if url is not None else url_do_ambiente())
        self.pg = bool(url)
        if self.pg:
            libs = RAIZ / "libs"   # no PC o psycopg fica instalado na pasta do projeto
            if libs.exists() and str(libs) not in sys.path:
                sys.path.insert(0, str(libs))
            import psycopg
            # prepare_threshold=None: o pooler do Supabase (pgbouncer) não aceita prepared statements
            self.con = psycopg.connect(url, prepare_threshold=None, connect_timeout=30)
            esquema = ESQUEMA.replace("{ID}", "BIGSERIAL PRIMARY KEY")
            with self.con.cursor() as cur:
                cur.execute(esquema)
                for tab, col, tipo in COLUNAS_NOVAS:   # bancos criados antes dessas colunas
                    cur.execute(f"ALTER TABLE {tab} ADD COLUMN IF NOT EXISTS {col} {tipo}")
        else:
            CAMINHO.parent.mkdir(parents=True, exist_ok=True)
            self.con = sqlite3.connect(CAMINHO, timeout=60)
            self.con.row_factory = sqlite3.Row
            self.con.executescript(ESQUEMA.replace("{ID}", "INTEGER PRIMARY KEY AUTOINCREMENT"))
            for tab, col, tipo in COLUNAS_NOVAS:
                if col not in {r[1] for r in self.con.execute(f"PRAGMA table_info({tab})")}:
                    self.con.execute(f"ALTER TABLE {tab} ADD COLUMN {col} {tipo}")
        self.con.commit()

    def _q(self, sql):
        return sql.replace("?", "%s") if self.pg else sql

    def execute(self, sql, args=()):
        if self.pg:
            cur = self.con.cursor(row_factory=_fabrica_linha)
            cur.execute(self._q(sql), args)
            return cur
        return self.con.execute(sql, args)

    def executemany(self, sql, linhas):
        linhas = list(linhas)
        if not linhas:
            return 0
        if self.pg:
            with self.con.cursor() as cur:
                cur.executemany(self._q(sql), linhas)
        else:
            self.con.executemany(sql, linhas)
        return len(linhas)

    def commit(self):
        self.con.commit()

    def kv_ler(self, chave):
        r = self.execute("SELECT valor FROM kv WHERE chave=?", (chave,)).fetchone()
        return json.loads(r["valor"]) if r else None

    def kv_gravar(self, chave, valor):
        self.execute("INSERT INTO kv VALUES (?,?,?) ON CONFLICT (chave) DO UPDATE SET valor=excluded.valor, "
                     "atualizado=excluded.atualizado", (chave, json.dumps(valor, ensure_ascii=False),
                                                        int(time.time() * 1000)))
        self.commit()


def conectar(url=None):
    return Banco(url)
