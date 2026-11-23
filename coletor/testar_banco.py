"""Testa a DATABASE_URL do .env: conecta, cria as tabelas do radar no schema certo e mostra onde caíram.
  python testar_banco.py
Não imprime a URL nem a senha."""
import sys
from db import conectar, url_do_ambiente, limpar_url

url = limpar_url(url_do_ambiente())
if not url:
    sys.exit("Sem DATABASE_URL no .env: nada a testar (o radar cairia no SQLite local).")
print("servidor:", url.split("@")[-1].split("/")[0])
con = conectar()
print("schema atual:", con.execute("select current_schema() as s").fetchone()["s"])
con.execute("insert into kv values ('teste_conexao', '1', 0) on conflict (chave) do update set atualizado = excluded.atualizado")
con.commit()
print("tabelas no schema:", con.execute("select count(*) as n from information_schema.tables where table_schema = current_schema()").fetchone()["n"])
print("gravação e leitura:", con.execute("select valor from kv where chave = 'teste_conexao'").fetchone()["valor"] == "1")
con.execute("delete from kv where chave = 'teste_conexao'"); con.commit()
print("OK: o radar pode usar este banco.")
