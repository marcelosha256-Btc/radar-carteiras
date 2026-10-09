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

import acoes  # noqa: E402
import acoes_eventos  # noqa: E402
import acoes_ranking  # noqa: E402
import contexto  # noqa: E402
import fase2  # noqa: E402
import fase4  # noqa: E402
import varejo  # noqa: E402
from avisos import avisar  # noqa: E402
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


def foto(hl, con, carteiras, agora, precos):
    """Tira a foto das posições e compara com a anterior. Lê e grava o banco em lote:
    na nuvem o banco fica longe (EUA → São Paulo) e cada ida e volta custa ~0,15 s."""
    def uma(end):
        try:
            return end, posicoes_agora(hl, end)
        except RuntimeError:
            return end, None
    with ThreadPoolExecutor(8) as ex:
        fotos = [(e, d) for e, d in ex.map(uma, carteiras) if d is not None]
    fotografadas = {r["endereco"] for r in con.execute("SELECT endereco FROM fotos")}
    antes_todas = {}
    for r in con.execute("SELECT * FROM posicoes"):
        antes_todas.setdefault(r["endereco"], {})[r["moeda"]] = dict(r)
    abertos = {}
    for s in con.execute("SELECT id, endereco, moeda, lado, preco_abertura FROM sinais "
                         "WHERE origem='copia' AND fechado_em IS NULL"):
        abertos.setdefault((s["endereco"], s["moeda"]), []).append(dict(s))

    alertas, novos_sinais, fechamentos, posicoes = [], [], [], []
    for end, depois in fotos:
        antes = antes_todas.get(end, {})
        confiavel = bool(carteiras[end].get("confiavel"))
        if end in fotografadas:   # sem foto anterior não há com o que comparar
            for moeda, evento, lado, t_antes, t_depois in comparar(antes, depois):
                preco = precos.get(moeda)
                alav = (depois.get(moeda) or antes.get(moeda) or {}).get("alavancagem")
                rot = contexto.rotulos(hl, con, end, moeda, lado, t_depois or t_antes, depois.get(moeda), agora)                     if confiavel and evento in ("abriu", "aumentou", "virou") else []
                alertas.append((agora, end, moeda, evento, lado, t_antes, t_depois, preco, alav, int(confiavel),
                                ";".join(rot) or None))
                if evento in ("fechou", "virou"):
                    for s in abertos.pop((end, moeda), []):
                        sinal = 1 if s["lado"] == "long" else -1
                        ret = sinal * (preco / s["preco_abertura"] - 1) - 2 * TAXA_TAKER if preco else None
                        fechamentos.append((agora, preco, ret, s["id"]))
                if evento in ("abriu", "virou") and confiavel and preco:
                    novos_sinais.append((end, moeda, lado, agora, preco))
        posicoes += [(end, m, p["lado"], p["tamanho"], p["preco_entrada"], p["alavancagem"], p["pnl_aberto"],
                      p["preco_liquidacao"], agora) for m, p in depois.items()]

    ends = [e for e, _ in fotos]
    for i in range(0, len(ends), 200):
        lote = ends[i:i + 200]
        con.execute(f"DELETE FROM posicoes WHERE endereco IN ({','.join('?' * len(lote))})", lote)
    con.executemany("INSERT INTO posicoes VALUES (?,?,?,?,?,?,?,?,?)", posicoes)
    con.executemany("INSERT INTO alertas VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING", alertas)
    con.executemany("UPDATE sinais SET fechado_em=?, preco_fechamento=?, retorno=? WHERE id=?", fechamentos)
    con.executemany("INSERT INTO sinais (origem, endereco, moeda, lado, aberto_em, preco_abertura) "
                    "VALUES ('copia',?,?,?,?,?)", novos_sinais)
    con.executemany("INSERT INTO fotos VALUES (?,?) ON CONFLICT (endereco) DO UPDATE SET tempo=excluded.tempo",
                    [(e, agora) for e in ends])
    con.commit()
    log(f"foto: {len(fotos)} carteiras · {len(alertas)} alertas · {len(novos_sinais)} cópias abertas · "
        f"{len(fechamentos)} fechadas")


def _px(v):
    return f"{v:,.0f}".replace(",", ".") if v >= 1000 else f"{v:.4g}".replace(".", ",")


def avisar_swing(novos, fechados):
    pct = lambda v: "—" if v is None else f"{v * 100:.0f}%"
    rr = lambda v: "—" if v is None else f"{v:+.2f}R".replace(".", ",")
    for s in novos:
        corpo = chr(10).join([
            f"O setup **{s['nome']}** disparou no fechamento diário de **{s['moeda']}** e foi registrado no Diário.",
            "",
            "| | Preço |",
            "|---|---|",
            f"| Entrada (preço agora) | {_px(s['entrada'])} |",
            f"| Stop (3 ATR) | {_px(s['stop'])} |",
            f"| Alvo (1,5R) | {_px(s['alvo'])} |",
            "",
            f"No histórico: {s['n']} operações, acerto {pct(s['acerto'])}, mediana {rr(s['mediana'])}, "
            f"fora da amostra {rr(s['media_fora'])}. Isto não é recomendação: o Diário existe para medir "
            "se o setup funciona daqui para a frente.",
        ])
        avisar(f"Sinal de swing: {s['moeda']} {s['lado'].upper()} · {s['nome']}", corpo, rotulo="sinal")
    for s in fechados:
        avisar(f"Sinal encerrado: {s['moeda']} {s['lado'].upper()} por {s['motivo']} ({rr(s['r'])})",
               f"Entrada {_px(s['entrada'])} · saída {_px(s['saida'])} · resultado {rr(s['r'])} "
               f"({s['retorno'] * 100:+.1f}%".replace(".", ",") + " sem alavancagem, com custos).", rotulo="sinal")


def registrar_execucao(con, tipo, ok, detalhe=""):
    """Histórico das últimas execuções (para a revisão medir se o agendamento está confiável)."""
    lista = (con.kv_ler("execucoes") or [])[-199:]
    lista.append({"tempo": int(time.time() * 1000), "tipo": tipo, "origem": "github" if NA_NUVEM else "pc",
                  "ok": ok, "detalhe": detalhe[:200]})
    con.kv_gravar("execucoes", lista)


def coletar(con):
    # o GitHub atrasa e pula execuções agendadas: a nuvem roda de hora em hora e o PC fica de
    # reserva; quem chegar depois de uma coleta recente só registra e sai
    if not NA_NUVEM:   # reserva: se a nuvem não conseguir o calendário (Nasdaq às vezes barra a nuvem), o PC faz
        ev = con.kv_ler("acoes_eventos")
        if not ev or time.time() * 1000 - ev["gerado"] > 30 * 3_600_000:
            try:
                log("balanços e eventos das ações atrasados; refazendo aqui no PC")
                acoes_eventos.executar(con)
            except Exception:
                log("ERRO em balanços e eventos (o resto segue normal)\n" + traceback.format_exc())
    u = con.kv_ler("ultima_coleta")
    janela = (50 if NA_NUVEM else 100) * 60_000
    if u and time.time() * 1000 - u["tempo"] < janela:
        log(f"coleta recente ({u['origem']}, há {(time.time() * 1000 - u['tempo']) / 60_000:.0f} min); pulei")
        registrar_execucao(con, "coleta", True, "pulada: coleta recente")
        return
    hl = Hyperliquid()
    rk = con.kv_ler("ranking")
    if not NA_NUVEM and (not rk or time.time() * 1000 - rk["gerado"] > 26 * 3_600_000):
        log("ranking da nuvem atrasado; refazendo aqui no PC")
        ranking_diario.executar()
        rk = con.kv_ler("ranking")
    ra = con.kv_ler("acoes_ranking")
    if not NA_NUVEM and (not ra or time.time() * 1000 - ra["gerado"] > 26 * 3_600_000):
        try:
            log("ranking de ações atrasado; refazendo aqui no PC")
            acoes_ranking.executar()
        except Exception:
            log("ERRO no ranking de ações (cripto segue normal)\n" + traceback.format_exc())
    carteiras = {c["endereco"]: c for c in rk["carteiras"]}
    agora = int(time.time() * 1000)
    precos = {k: float(v) for k, v in hl.info({"type": "allMids"}).items()}

    foto(hl, con, carteiras, agora, precos)
    log(f"livro: {fase2.coletar_livro(hl, con, precos, agora)} faixas")
    log(f"mercado: {contexto.gravar_mercado(hl, con, agora)} ativos · "
        f"formadores: {contexto.gravar_formadores(hl, con, agora)} ativos com posição")
    vp = varejo.ler_posicoes(hl, con, agora)
    vo = varejo.ler_ordens(hl, con, agora)
    varejo.limpar(con, agora)
    log(f"varejo: {vp[0]} carteiras lidas ({vp[1]} posições) · ordens de {vo[0]} ({vo[1]} ordens)")
    if fase2.hora_das_ordens(con, ORDENS_A_CADA_H):
        alvo = [r["endereco"] for r in con.execute(
            "SELECT DISTINCT endereco FROM posicoes WHERE moeda IN ('BTC','ETH','SOL','XRP','HYPE','NEAR')")]
        log(f"ordens: {fase2.coletar_ordens(hl, con, alvo, agora)} de {len(alvo)} carteiras")
        con.kv_gravar("ordens_em", agora)
    try:   # ações (grupo xyz): um erro aqui não pode parar a coleta de cripto
        log(f"ações: {acoes.coletar(hl, con, agora)}")
    except Exception:
        log("ERRO na coleta das ações (cripto segue normal)\n" + traceback.format_exc())
    novos, fechados = fase4.registrar_e_acompanhar(hl, con, precos, agora)
    log(f"swing: {len(novos)} sinais novos no Diário · {len(fechados)} fechados")
    avisar_swing(novos, fechados)
    log(f"painel: {gerar_painel.gerar(hl, con)}")
    con.kv_gravar("ultima_coleta", {"tempo": agora, "origem": "github" if NA_NUVEM else "pc"})
    registrar_execucao(con, "coleta", True, f"{(time.time() * 1000 - agora) / 1000:.0f} s")


def main():
    local = not NA_NUVEM
    if local and TRAVA.exists() and time.time() - TRAVA.stat().st_mtime < 3 * 3600:
        log("outra coleta ainda está rodando; pulei esta")
        return
    if local:
        TRAVA.write_text(str(os.getpid()))
    con = None
    try:
        con = conectar()
        coletar(con)
    except Exception as e:
        log("ERRO\n" + traceback.format_exc() + f"python: {sys.executable}\nsys.path: {sys.path}")
        try:
            if con:
                con.con.rollback()
                registrar_execucao(con, "coleta", False, repr(e))
        except Exception:
            pass
        if NA_NUVEM:
            raise
    finally:
        if local:
            TRAVA.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
