"""Mostra os últimos alertas das carteiras confiáveis e o placar do Diário de sinais.

  python ver.py           # últimas 24 h
  python ver.py --horas 72
"""
import argparse
import statistics as st
import time

from db import conectar


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--horas", type=int, default=24)
    a = ap.parse_args()
    con = conectar()
    desde = int((time.time() - a.horas * 3600) * 1000)
    hora = lambda ms: time.strftime("%d/%m %H:%M", time.localtime(ms / 1000))

    print(f"Alertas das carteiras confiáveis nas últimas {a.horas} h")
    for r in con.execute("SELECT * FROM alertas WHERE confiavel=1 AND tempo>=? ORDER BY tempo DESC", (desde,)):
        alav = f"{r['alavancagem']:.0f}x" if r["alavancagem"] else ""
        print(f"  {hora(r['tempo'])}  {r['endereco'][:6]}…{r['endereco'][-4:]}  {r['evento']:<8} {r['lado']:<5} "
              f"{r['moeda']:<8} a {r['preco'] or 0:,.4g} {alav}")

    print("\nDiário de sinais (cópia das confiáveis)")
    abertos = con.execute("SELECT * FROM sinais WHERE fechado_em IS NULL ORDER BY aberto_em DESC").fetchall()
    for s in abertos:
        print(f"  ABERTO  {hora(s['aberto_em'])}  {s['moeda']:<8} {s['lado']:<5} entrada {s['preco_abertura']:,.4g}")
    fechados = [s["retorno"] for s in con.execute("SELECT retorno FROM sinais WHERE retorno IS NOT NULL")]
    if fechados:
        print(f"  {len(fechados)} fechados · acerto {sum(r > 0 for r in fechados) / len(fechados):.0%} · "
              f"mediana {st.median(fechados) * 100:+.2f}% · soma {sum(fechados) * 100:+.1f}% (sem alavancagem)")
    else:
        print(f"  {len(abertos)} abertos · nenhum fechado ainda")


if __name__ == "__main__":
    main()
