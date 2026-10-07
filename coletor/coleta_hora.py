"""Coleta periódica: foto das posições, alertas, Diário de sinais, livro de ofertas,
ordens das carteiras (stops e alvos) e o painel.

Na nuvem roda pelo GitHub Actions a cada 2 h; o ranking diário é outro workflow.
No PC roda pelo Agendador de Tarefas (pythonw, sem janela) e refaz o ranking
sozinho quando ele passa de 24 h.
"""
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DADOS = Path(__file__).resolve().parent.parent / "data"
DADOS.mkdir(exist_ok=True)
if sys.stdout is None:   # pythonw: sem console, tudo vai para o log
    sys.stdout = sys.stderr = open(DADOS / "hora.log", "a", encoding="utf-8", buffering=1)

import fase2  # noqa: E402
import gerar_painel  # noqa: E402
import ranking_diario  # noqa: E402
from analise import TAXA_TAKER  # noqa: E402
from db import conectar  # noqa: E402
from hl import Hyperliquid  # noqa: E402

NA_NUVEM = bool(os.environ.get("GITHUB_ACTIONS"))
TRAVA = DADOS / "coleta.lock"
MUDANCA_MINIMA = 0.10    # aumento/redução abaixo de 10% do tamanho não vira alerta
ORDENS_A_CADA_H = 6      # ler ordens custa 10x mais na API; não precisa ser toda coleta


def log(msg):
    print(time.strftime("%d/%m %H:%M:%S"), msg, flush=True)


def posicoes_agora(hl, end):
    out = {}
    for ap in hl.estado(end).get("assetPositions", []):
        p = ap["position"]
        tam = float(p["szi"])
        if tam:
            out[p["coin"]] = {"lado": "long" if tam > 0 else "short", "tamanho": abs(tam),
                              "preco_entrada": float(p["entryPx"]), "alavancagem": float(p["leverage"]["value"]),
                              "pnl_aberto": float(p["unrealizedPnl"]),
                              "preco_liquidacao": float(p["liquidationPx"]) if p.get("liquidationPx") else None}
    return out


def comparar(antes, depois):
    """Eventos entre duas fotos de uma carteira: [(moeda, evento, lado, tam_antes, tam_depois)]."""
    ev = []
    for m in set(antes) | set(depois):
        a, d = antes.get(m), depois.get(m)
        if a and not d:
            ev.append((m, "fechou", a["lado"], a["tamanho"], 0.0))
        elif d and not a:
            ev.append((m, "abriu", d["lado"], 0.0, d["tamanho"]))
        elif a["lado"] != d["lado"]:
            ev.append((m, "virou", d["lado"], a["tamanho"], d["tamanho"]))
        else:
            var = d["tamanho"] / a["tamanho"] - 1
            if abs(var) >= MUDANCA_MINIMA:
                ev.append((m, "aumentou" if var > 0 else "reduziu", d["lado"], a["tamanho"], d["tamanho"]))
    return ev


def fechar_sinais(con, end, moeda, agora, preco):
    n = 0
    for s in con.execute("SELECT id, lado, preco_abertura FROM sinais WHERE origem='copia' AND endereco=? "
                         "AND moeda=? AND fechado_em IS NULL", (end, moeda)).fetchall():
        sinal = 1 if s["lado"] == "long" else -1
        ret = sinal * (preco / s["preco_abertura"] - 1) - 2 * TAXA_TAKER if preco else None
        con.execute("UPDATE sinais SET fechado_em=?, preco_fechamento=?, retorno=? WHERE id=?",
                    (agora, preco, ret, s["id"]))
        n += 1
    return n


def foto(hl, con, carteiras, agora, precos):
    def uma(end):
        try:
            return end, posicoes_agora(hl, end)
        except RuntimeError:
            return end, None
    with ThreadPoolExecutor(8) as ex:
        fotos = list(ex.map(uma, carteiras))
    fotografadas = {r["endereco"] for r in con.execute("SELECT endereco FROM fotos")}
    n_alertas = n_abertos = n_fechados = 0
    for end, depois in fotos:
        if depois is None:
            continue
        antes = {r["moeda"]: dict(r) for r in con.execute("SELECT * FROM posicoes WHERE endereco=?", (end,))}
        confiavel = bool(carteiras[end].get("confiavel"))
        if end in fotografadas:   # sem foto anterior não há com o que comparar
            for moeda, evento, lado, t_antes, t_depois in comparar(antes, depois):
                preco = precos.get(moeda)
                alav = (depois.get(moeda) or antes.get(moeda) or {}).get("alavancagem")
                con.execute("INSERT INTO alertas VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                            (agora, end, moeda, evento, lado, t_antes, t_depois, preco, alav, int(confiavel)))
                n_alertas += 1
                if evento in ("fechou", "virou"):
                    n_fechados += fechar_sinais(con, end, moeda, agora, preco)
                if evento in ("abriu", "virou") and confiavel and preco:
                    con.execute("INSERT INTO sinais (origem, endereco, moeda, lado, aberto_em, preco_abertura) "
                                "VALUES ('copia',?,?,?,?,?)", (end, moeda, lado, agora, preco))
                    n_abertos += 1
        con.execute("DELETE FROM posicoes WHERE endereco=?", (end,))
        con.executemany("INSERT INTO posicoes VALUES (?,?,?,?,?,?,?,?,?)", [
            (end, m, p["lado"], p["tamanho"], p["preco_entrada"], p["alavancagem"], p["pnl_aberto"],
             p["preco_liquidacao"], agora) for m, p in depois.items()])
        con.execute("INSERT INTO fotos VALUES (?,?) ON CONFLICT (endereco) DO UPDATE SET tempo=excluded.tempo",
                    (end, agora))
    con.commit()
    log(f"foto: {len(carteiras)} carteiras · {n_alertas} alertas · {n_abertos} cópias abertas · {n_fechados} fechadas")


def coletar(con):
    hl = Hyperliquid()
    rk = con.kv_ler("ranking")
    if not NA_NUVEM and (not rk or time.time() * 1000 - rk["gerado"] > 24 * 3_600_000):
        log("refazendo o ranking diário")
        ranking_diario.executar()
        rk = con.kv_ler("ranking")
    carteiras = {c["endereco"]: c for c in rk["carteiras"]}
    agora = int(time.time() * 1000)
    precos = {k: float(v) for k, v in hl.info({"type": "allMids"}).items()}

    foto(hl, con, carteiras, agora, precos)
    log(f"livro: {fase2.coletar_livro(hl, con, precos, agora)} faixas")
    if fase2.hora_das_ordens(con, ORDENS_A_CADA_H):
        alvo = [r["endereco"] for r in con.execute(
            "SELECT DISTINCT endereco FROM posicoes WHERE moeda IN ('BTC','ETH','SOL','XRP','HYPE','NEAR')")]
        log(f"ordens: {fase2.coletar_ordens(hl, con, alvo, agora)} de {len(alvo)} carteiras")
        con.kv_gravar("ordens_em", agora)
    log(f"painel: {gerar_painel.gerar(hl, con)}")
    con.kv_gravar("ultima_coleta", {"tempo": agora, "origem": "github" if NA_NUVEM else "pc"})


def main():
    local = not NA_NUVEM
    if local and TRAVA.exists() and time.time() - TRAVA.stat().st_mtime < 3 * 3600:
        log("outra coleta ainda está rodando; pulei esta")
        return
    if local:
        TRAVA.write_text(str(os.getpid()))
    try:
        coletar(conectar())
    except Exception:
        log("ERRO\n" + traceback.format_exc() + f"python: {sys.executable}\nsys.path: {sys.path}")
        if NA_NUVEM:
            raise
    finally:
        if local:
            TRAVA.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
