"""Ranking diário: descobre carteiras, processa os trades novos de cada uma em
operações, simula a cópia com atraso e grava o ranking.

Os fills não são guardados: cada carteira tem um "estado" com a operação em
andamento, e a próxima coleta continua dali.

  python ranking_diario.py                 # coleta + ranking
  python ranking_diario.py --so-analise    # refaz só os cálculos
"""
import argparse
import json
import time
from collections import defaultdict

import analise as an
import contexto
from db import RAIZ, conectar
from avisos import avisar
from hl import Hyperliquid

ARQUIVO_RANKING = RAIZ / "data" / "ranking.json"
ATIVOS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "NEAR"]
MOEDAS_COM_VELAS = 40
DIA = 86_400_000

# critério de "confiável"
MIN_OPERACOES = 30
MIN_MINIMO = 0.55
MIN_HORAS = 6


def agora_ms():
    return int(time.time() * 1000)


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def janela(r, nome):
    return {w: v for w, v in r["windowPerformances"]}[nome]


def descobrir(hl, con, amostra):
    linhas = hl.leaderboard()
    cands = []
    for r in linhas:
        conta = float(r["accountValue"])
        mes, total = janela(r, "month"), janela(r, "allTime")
        vol = float(mes["vlm"])
        # quem opera de verdade: gira de 3x a 150x a conta no mês. Abaixo disso é holder
        # (poucas operações para medir); acima é robô ou formador de mercado.
        if 10_000 <= conta <= 20_000_000 and vol >= 200_000 and 3 <= vol / conta <= 150:
            cands.append((r["ethAddress"], conta, float(mes["pnl"]), vol, float(total["pnl"]),
                          float(mes["roi"]), float(total["roi"])))
    # metade pelo retorno do mês, metade pelo retorno de sempre
    escolhidas = {c[0]: c for c in sorted(cands, key=lambda c: -c[5])[:amostra // 2]}
    for c in sorted(cands, key=lambda c: -c[6]):
        if len(escolhidas) >= amostra:
            break
        escolhidas.setdefault(c[0], c)
    con.executemany(
        "INSERT INTO carteiras (endereco, valor_conta, pnl_mes, volume_mes, pnl_total, atualizado) VALUES (?,?,?,?,?,?) "
        "ON CONFLICT (endereco) DO UPDATE SET valor_conta=excluded.valor_conta, pnl_mes=excluded.pnl_mes, "
        "volume_mes=excluded.volume_mes, pnl_total=excluded.pnl_total, atualizado=excluded.atualizado",
        [(*c[:5], agora_ms()) for c in escolhidas.values()])
    con.commit()
    formadores = contexto.escolher_formadores(linhas)
    con.kv_gravar("formadores", formadores)
    log(f"leaderboard: {len(linhas)} carteiras, {len(cands)} passam no filtro, {len(escolhidas)} escolhidas, "
        f"{len(formadores)} formadores de mercado acompanhados")
    return list(escolhidas)


def processar_fills(con, end, fills):
    """Fills novos de uma carteira -> operações fechadas, estados e fluxo diário."""
    linhas = [{"moeda": f["coin"], "tempo": f["time"], "lado": f["side"], "preco": float(f["px"]),
               "tamanho": float(f["sz"]), "posicao_antes": float(f["startPosition"]),
               "pnl_fechado": float(f["closedPnl"]), "taxa": float(f["fee"])} for f in fills]
    estados = {r["moeda"]: json.loads(r["estado"]) if r["estado"] else None
               for r in con.execute("SELECT moeda, estado FROM estados WHERE endereco=?", (end,))}
    ops, novos = an.montar_operacoes(linhas, estados)
    con.executemany(
        "INSERT INTO operacoes VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT (endereco, moeda, t0) DO NOTHING",
        [(end, o["moeda"], o["lado"], o["t0"], o["t1"], o["preco_entrada"], o["preco_saida"],
          o["tamanho_max"], o["pnl"], o["retorno"], o["horas"]) for o in ops])
    con.executemany(
        "INSERT INTO estados VALUES (?,?,?) ON CONFLICT (endereco, moeda) DO UPDATE SET estado=excluded.estado",
        [(end, m, json.dumps(e) if e else None) for m, e in novos.items() if m in estados or e])
    fluxo = defaultdict(lambda: [0.0, 0.0])
    for f in linhas:
        if an.eh_perp(f["moeda"]):
            fluxo[(f["tempo"] // DIA * DIA, f["moeda"])][0 if f["lado"] == "B" else 1] += f["preco"] * f["tamanho"]
    con.executemany(
        "INSERT INTO fluxo_diario VALUES (?,?,?,?) ON CONFLICT (dia, moeda) DO UPDATE SET "
        "compra=fluxo_diario.compra+excluded.compra, venda=fluxo_diario.venda+excluded.venda",
        [(d, m, c, v) for (d, m), (c, v) in fluxo.items()])
    return len(ops)


def coletar_fills(hl, con, enderecos, dias):
    inicio = agora_ms() - dias * DIA
    total_ops = 0
    for i, end in enumerate(enderecos, 1):
        row = con.execute("SELECT ultimo_fill, robo FROM carteiras WHERE endereco=?", (end,)).fetchone()
        if row and row["robo"]:
            continue
        desde = max(inicio, (row["ultimo_fill"] or 0) + 1) if row else inicio
        fills, truncado = hl.fills(end, desde)
        if truncado:
            con.execute("UPDATE carteiras SET robo=1 WHERE endereco=?", (end,))
            con.execute("DELETE FROM estados WHERE endereco=?", (end,))
            con.execute("DELETE FROM operacoes WHERE endereco=?", (end,))
        elif fills:
            total_ops += processar_fills(con, end, fills)
            con.execute("UPDATE carteiras SET ultimo_fill=? WHERE endereco=?", (max(f["time"] for f in fills), end))
        con.commit()
        if i % 50 == 0 or i == len(enderecos):
            log(f"fills: {i}/{len(enderecos)} carteiras · {total_ops} operações novas")


def operacoes_recentes(con, dias):
    ops_por = defaultdict(list)
    for o in con.execute("SELECT * FROM operacoes WHERE t1>=?", (agora_ms() - dias * DIA,)):
        ops_por[o["endereco"]].append(dict(o))
    return ops_por


def coletar_velas(hl, con, ops_por, dias, confiaveis):
    contagem = defaultdict(int)
    for ops in ops_por.values():
        for o in ops:
            contagem[o["moeda"]] += 1
    moedas = [m for m, _ in sorted(contagem.items(), key=lambda x: -x[1])[:MOEDAS_COM_VELAS]]
    extras = {o["moeda"] for e in confiaveis for o in ops_por.get(e, [])} | set(ATIVOS)
    moedas += sorted(extras - set(moedas))
    inicio = agora_ms() - (dias + 3) * DIA
    for m in moedas:
        r = con.execute("SELECT MIN(t) AS pri, MAX(t) AS ult FROM velas WHERE moeda=?", (m,)).fetchone()
        pri, ult = r["pri"], r["ult"]
        if pri is None or pri > inicio + 2 * 3_600_000:
            # a API só guarda as 5 mil velas mais recentes: 15 min cobre ~52 dias, 1 h cobre ~208.
            # O período mais antigo fica com velas de 1 h.
            limite = pri or agora_ms()
            antigas = [v for v in hl.velas(m, "1h", inicio, limite) if v["t"] + 3_600_000 <= limite]
            con.executemany("INSERT INTO velas VALUES (?,?,?,?) ON CONFLICT (moeda, t) DO NOTHING",
                            [(m, v["t"], float(v["o"]), float(v["c"])) for v in antigas])
        velas = hl.velas(m, "15m", max(inicio, (ult or 0) + 1), agora_ms())
        con.executemany("INSERT INTO velas VALUES (?,?,?,?) ON CONFLICT (moeda, t) DO UPDATE SET "
                        "abertura=excluded.abertura, fechamento=excluded.fechamento",
                        [(m, v["t"], float(v["o"]), float(v["c"])) for v in velas])
        con.commit()
    con.execute("DELETE FROM velas WHERE t<?", (inicio,))
    con.commit()
    log(f"velas: {len(moedas)} moedas")


def simular_copia(con, atraso_min, dias):
    velas = defaultdict(list)
    for r in con.execute("SELECT moeda, t, abertura, fechamento FROM velas ORDER BY moeda, t"):
        velas[r["moeda"]].append((r["t"], r["abertura"], r["fechamento"]))
    precos = an.Precos(velas)
    pend = [dict(o) for o in con.execute(
        "SELECT * FROM operacoes WHERE retorno_copia IS NULL AND t1>=?", (agora_ms() - (dias + 3) * DIA,))]
    atualizadas = []
    for o in pend:
        r = an.retorno_copiando(o, precos, atraso_min * 60_000)
        if r is not None:
            atualizadas.append((r, o["endereco"], o["moeda"], o["t0"]))
    con.executemany("UPDATE operacoes SET retorno_copia=? WHERE endereco=? AND moeda=? AND t0=?", atualizadas)
    con.commit()
    log(f"cópia simulada: {len(atualizadas)} de {len(pend)} operações pendentes")


def montar_ranking(con, ops_por, atraso_min, dias):
    grupos = an.agrupar(ops_por)
    posicoes = defaultdict(list)
    for r in con.execute("SELECT * FROM posicoes"):
        posicoes[r["endereco"]].append(dict(r))
    linhas = []
    for end, ops in ops_por.items():
        if len(ops) < 10:
            continue
        r = an.resumo_carteira(ops)
        pos = posicoes.get(end, [])
        pnl_aberto = sum(p["pnl_aberto"] for p in pos)
        r.update({
            "endereco": end,
            "grupo": grupos.get(end),
            "pnl_aberto": pnl_aberto,
            # segura prejuízo aberto maior que tudo que realizou no período
            "segura_prejuizo": pnl_aberto < 0 and -pnl_aberto > max(r["pnl_usd"], 0),
        })
        r["confiavel"] = (r["operacoes"] >= MIN_OPERACOES and r["minimo"] >= MIN_MINIMO
                          and (r["copia_mediana"] or 0) > 0 and r["horas_mediana"] >= MIN_HORAS
                          and not r["segura_prejuizo"])
        linhas.append(r)
    linhas.sort(key=lambda x: -x["minimo"])
    saida = {"gerado": agora_ms(), "dias": dias, "atraso_min": atraso_min,
             "criterio": {"operacoes": MIN_OPERACOES, "minimo": MIN_MINIMO, "horas": MIN_HORAS},
             "carteiras": linhas}
    con.kv_gravar("ranking", saida)
    ARQUIVO_RANKING.parent.mkdir(exist_ok=True)
    ARQUIVO_RANKING.write_text(json.dumps(saida, ensure_ascii=False), encoding="utf-8")
    log(f"ranking: {len(linhas)} carteiras com 10+ operações · {sum(r['confiavel'] for r in linhas)} confiáveis")
    return linhas


def limpar(con):
    agora = agora_ms()
    con.execute("DELETE FROM operacoes WHERE t1<?", (agora - 120 * DIA,))
    con.execute("DELETE FROM fluxo_diario WHERE dia<?", (agora - 35 * DIA,))
    con.execute("DELETE FROM alertas WHERE tempo<?", (agora - 30 * DIA,))
    con.execute("DELETE FROM livro WHERE tempo<?", (agora - 3 * DIA,))
    con.commit()


def vigiar_coleta(con):
    """Se a coleta de 2 em 2 h parou sem dar erro (agendamento desligado, por exemplo), avisa."""
    u = con.kv_ler("ultima_coleta")
    if not u:
        return
    horas = (agora_ms() - u["tempo"]) / 3_600_000
    if horas > 6:
        avisar(f"Coleta parada há {horas:.0f} h",
               f"A última coleta do radar foi em {time.strftime('%d/%m %H:%M', time.gmtime(u['tempo'] / 1000))} UTC "
               f"(origem: {u.get('origem')}). Confira a aba Actions do repositório.", rotulo="problema")


def executar(amostra=600, dias=90, atraso_min=60, so_analise=False):
    con = conectar()
    vigiar_coleta(con)
    hl = Hyperliquid()
    anterior = con.kv_ler("ranking") or {"carteiras": []}
    if not so_analise:
        enderecos = descobrir(hl, con, amostra)
        # quem já está no ranking continua sendo atualizado, mesmo se saiu do leaderboard
        enderecos += [r["endereco"] for r in anterior["carteiras"] if r["endereco"] not in set(enderecos)]
        coletar_fills(hl, con, enderecos, dias)
    ops_por = operacoes_recentes(con, dias)
    if not so_analise:
        confiaveis = [r["endereco"] for r in anterior["carteiras"] if r["confiavel"]]
        coletar_velas(hl, con, ops_por, dias, confiaveis)
    simular_copia(con, atraso_min, dias)
    ops_por = operacoes_recentes(con, dias)
    linhas = montar_ranking(con, ops_por, atraso_min, dias)
    if not so_analise:
        feitas, faltavam = contexto.preencher_idades(hl, con, [x["endereco"] for x in linhas])
        log(f"idade das carteiras: {feitas} de {faltavam} que faltavam")
    limpar(con)
    return linhas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--amostra", type=int, default=600)
    ap.add_argument("--dias", type=int, default=90)
    ap.add_argument("--atraso-min", type=int, default=60)
    ap.add_argument("--so-analise", action="store_true")
    a = ap.parse_args()
    executar(a.amostra, a.dias, a.atraso_min, a.so_analise)


if __name__ == "__main__":
    main()
