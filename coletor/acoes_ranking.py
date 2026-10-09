"""Ranking diário das carteiras de AÇÕES (grupo xyz da Hyperliquid), separado do de cripto.

Mesma régua do ranking de cripto (operações, mínimo estatístico de Wilson, cópia com 1 h de
atraso, horas por operação, "segura prejuízo"), calculada só com as operações em ações.

Quem entra na lista (acoes_carteiras):
- carteiras vistas com posição em ações na leitura de hora em hora (acoes.py) que operam de
  verdade: conta de US$ 10 mil a 20 milhões e giro de 3x a 150x a conta no mês (abaixo é
  holder; acima, robô ou formador de mercado). Formadores conhecidos ficam de fora;
- carteiras do ranking de cripto que aparecem negociando ações nos fills (ranking_diario.py).
Na primeira vez baixa 90 dias de fills; depois, só os novos. Os fills não são guardados.

  python acoes_ranking.py                 # coleta + ranking
  python acoes_ranking.py --se-velho 24   # só refaz se o último tiver mais de 24 h (laço da nuvem)
  python acoes_ranking.py --so-analise    # refaz só os cálculos
"""
import argparse
import json
import os
import time
from collections import defaultdict

import analise as an
import ranking_diario as rd
from db import conectar
from hl import Hyperliquid

DIAS = 90
ATRASO_MIN = 60
MAX_CARTEIRAS = 900       # teto de carteiras processadas por dia (cada uma custa ~1 chamada pesada)
PARADA_DIAS = 45          # sem negociar ações há 45 dias e sem posição: sai da lista
DIA = 86_400_000
NA_NUVEM = bool(os.environ.get("GITHUB_ACTIONS"))


def eh_acao(moeda):
    return moeda.startswith("xyz:")


def log(msg):
    print(time.strftime("%H:%M:%S"), "[ações]", msg, flush=True)


def agora_ms():
    return int(time.time() * 1000)


# ---------- quem entra ----------

def atualizar_lista(hl, con):
    """Acrescenta quem foi visto com ação e opera de verdade; tira quem parou de operar ações."""
    agora = agora_ms()
    lb = {}
    for r in hl.leaderboard():
        mes = {w: v for w, v in r["windowPerformances"]}["month"]
        lb[r["ethAddress"].lower()] = (float(r["accountValue"]), float(mes["vlm"]))
    formadores = {f["endereco"].lower() for f in (con.kv_ler("formadores") or [])}
    ja = {r["endereco"] for r in con.execute("SELECT endereco FROM acoes_carteiras")}
    novas = []
    for r in con.execute("SELECT endereco FROM acoes_lido WHERE tem_acao=1"):
        e = r["endereco"]
        if e in ja or e.lower() in formadores:
            continue
        conta, vol = lb.get(e.lower(), (0.0, 0.0))
        if 10_000 <= conta <= 20_000_000 and 3 <= vol / conta <= 150:
            novas.append((e, "amostra", agora))
    con.executemany("INSERT INTO acoes_carteiras (endereco, origem, entrou) VALUES (?,?,?) "
                    "ON CONFLICT (endereco) DO NOTHING", novas)
    # parou: sem fill em ações há 45 dias (ou nunca, depois de 45 dias na lista) e sem posição agora
    paradas = [r["endereco"] for r in con.execute(
        "SELECT c.endereco FROM acoes_carteiras c LEFT JOIN acoes_lido l ON l.endereco = c.endereco "
        "WHERE COALESCE(c.ultimo_xyz, c.entrou) < ? AND COALESCE(l.tem_acao, 0) = 0", (agora - PARADA_DIAS * DIA,))]
    for i in range(0, len(paradas), 200):
        lote = paradas[i:i + 200]
        marcas = ",".join("?" * len(lote))
        for tab in ("acoes_carteiras", "acoes_estados"):
            con.execute(f"DELETE FROM {tab} WHERE endereco IN ({marcas})", lote)
    con.commit()
    log(f"lista: {len(novas)} carteiras novas · {len(paradas)} saíram (pararam de operar ações)")


# ---------- fills -> operações ----------

def processar_fills(con, end, fills):
    linhas = [{"moeda": f["coin"], "tempo": f["time"], "lado": f["side"], "preco": float(f["px"]),
               "tamanho": float(f["sz"]), "posicao_antes": float(f["startPosition"]),
               "pnl_fechado": float(f["closedPnl"]), "taxa": float(f["fee"])} for f in fills if eh_acao(f["coin"])]
    if not linhas:
        return 0, None
    estados = {r["moeda"]: json.loads(r["estado"]) if r["estado"] else None
               for r in con.execute("SELECT moeda, estado FROM acoes_estados WHERE endereco=?", (end,))}
    ops, novos = an.montar_operacoes(linhas, estados, aceitar=eh_acao)
    con.executemany(
        "INSERT INTO acoes_operacoes VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT (endereco, moeda, t0) DO NOTHING",
        [(end, o["moeda"], o["lado"], o["t0"], o["t1"], o["preco_entrada"], o["preco_saida"],
          o["tamanho_max"], o["pnl"], o["retorno"], o["horas"]) for o in ops])
    con.executemany(
        "INSERT INTO acoes_estados VALUES (?,?,?) ON CONFLICT (endereco, moeda) DO UPDATE SET estado=excluded.estado",
        [(end, m, json.dumps(e) if e else None) for m, e in novos.items() if m in estados or e])
    fluxo = defaultdict(lambda: [0.0, 0.0])
    for f in linhas:
        fluxo[(f["tempo"] // DIA * DIA, f["moeda"])][0 if f["lado"] == "B" else 1] += f["preco"] * f["tamanho"]
    con.executemany(
        "INSERT INTO acoes_fluxo VALUES (?,?,?,?) ON CONFLICT (dia, moeda) DO UPDATE SET "
        "compra=acoes_fluxo.compra+excluded.compra, venda=acoes_fluxo.venda+excluded.venda",
        [(d, m, c, v) for (d, m), (c, v) in fluxo.items()])
    return len(ops), max(f["tempo"] for f in linhas)


def coletar_fills(hl, con):
    inicio = agora_ms() - DIAS * DIA
    # quem tem posição em ação agora e quem nunca foi processado vêm primeiro
    lista = [dict(r) for r in con.execute(
        "SELECT c.endereco, c.ultimo_fill FROM acoes_carteiras c LEFT JOIN acoes_lido l ON l.endereco = c.endereco "
        "WHERE COALESCE(c.robo, 0) = 0 ORDER BY COALESCE(l.tem_acao, 0) DESC, c.ultimo_fill IS NOT NULL, "
        "COALESCE(c.ultimo_xyz, 0) DESC LIMIT ?", (MAX_CARTEIRAS,))]
    total_ops = robos = 0
    for i, r in enumerate(lista, 1):
        end = r["endereco"]
        desde = max(inicio, (r["ultimo_fill"] or 0) + 1)
        try:
            fills, truncado = hl.fills(end, desde)
        except RuntimeError:
            continue
        if truncado:
            robos += 1
            con.execute("UPDATE acoes_carteiras SET robo=1 WHERE endereco=?", (end,))
            con.execute("DELETE FROM acoes_estados WHERE endereco=?", (end,))
            con.execute("DELETE FROM acoes_operacoes WHERE endereco=?", (end,))
        elif fills:
            n, ult_xyz = processar_fills(con, end, fills)
            total_ops += n
            con.execute("UPDATE acoes_carteiras SET ultimo_fill=?, ultimo_xyz=COALESCE(?, ultimo_xyz) WHERE endereco=?",
                        (max(f["time"] for f in fills), ult_xyz, end))
        con.commit()
        if i % 50 == 0 or i == len(lista):
            log(f"fills: {i}/{len(lista)} carteiras · {total_ops} operações novas · {robos} robôs")
    return len(lista)


# ---------- ranking ----------

def operacoes_recentes(con):
    ops_por = defaultdict(list)
    for o in con.execute("SELECT * FROM acoes_operacoes WHERE t1>=?", (agora_ms() - DIAS * DIA,)):
        ops_por[o["endereco"]].append(dict(o))
    return ops_por


def montar_ranking(con, ops_por, candidatas):
    grupos = an.agrupar(ops_por)
    pnl_aberto = defaultdict(float)
    for r in con.execute("SELECT endereco, pnl_aberto FROM acoes_posicoes WHERE coletado >= ?", (agora_ms() - DIA,)):
        pnl_aberto[r["endereco"]] += r["pnl_aberto"] or 0.0
    linhas = []
    for end, ops in ops_por.items():
        if len(ops) < 10:
            continue
        r = an.resumo_carteira(ops)
        pa = pnl_aberto.get(end, 0.0)
        r.update({"endereco": end, "grupo": grupos.get(end), "pnl_aberto": pa,
                  "segura_prejuizo": pa < 0 and -pa > max(r["pnl_usd"], 0)})
        r["moedas"] = [m.split(":", 1)[1] for m in r["moedas"]]
        r["confiavel"] = (r["operacoes"] >= rd.MIN_OPERACOES and r["minimo"] >= rd.MIN_MINIMO
                          and (r["copia_mediana"] or 0) > 0 and r["horas_mediana"] >= rd.MIN_HORAS
                          and not r["segura_prejuizo"])
        linhas.append(r)
    linhas.sort(key=lambda x: -x["minimo"])
    saida = {"gerado": agora_ms(), "dias": DIAS, "atraso_min": ATRASO_MIN,
             "criterio": {"operacoes": rd.MIN_OPERACOES, "minimo": rd.MIN_MINIMO, "horas": rd.MIN_HORAS},
             "candidatas": candidatas, "com_ops": len(ops_por), "carteiras": linhas}
    con.kv_gravar("acoes_ranking", saida)
    log(f"ranking: {len(ops_por)} carteiras com operações em ações · {len(linhas)} com 10+ · "
        f"{sum(r['confiavel'] for r in linhas)} confiáveis")
    return linhas


def limpar(con):
    agora = agora_ms()
    con.execute("DELETE FROM acoes_operacoes WHERE t1<?", (agora - 120 * DIA,))
    con.execute("DELETE FROM acoes_fluxo WHERE dia<?", (agora - 35 * DIA,))
    con.execute("DELETE FROM acoes_alertas WHERE tempo<?", (agora - 30 * DIA,))
    con.commit()


def executar(so_analise=False):
    con = conectar()
    hl = Hyperliquid()
    candidatas = con.execute("SELECT COUNT(*) FROM acoes_carteiras WHERE COALESCE(robo, 0) = 0").fetchone()[0]
    if not so_analise:
        atualizar_lista(hl, con)
        candidatas = coletar_fills(hl, con)
        ops_por = operacoes_recentes(con)
        anterior = con.kv_ler("acoes_ranking") or {"carteiras": []}
        # velas de 15 min / 1 h das ações operadas (mesma tabela e mesma rotina do cripto)
        rd.coletar_velas(hl, con, ops_por, DIAS, [r["endereco"] for r in anterior["carteiras"] if r["confiavel"]])
    rd.simular_copia(con, ATRASO_MIN, DIAS, tabela="acoes_operacoes")
    linhas = montar_ranking(con, operacoes_recentes(con), candidatas)
    limpar(con)
    return linhas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--so-analise", action="store_true")
    ap.add_argument("--se-velho", type=float, default=None)
    a = ap.parse_args()
    con = conectar()
    rk = con.kv_ler("acoes_ranking")
    if a.se_velho is not None and rk and agora_ms() - rk["gerado"] < a.se_velho * 3_600_000:
        return
    inicio = agora_ms()
    ok, det = True, ""
    try:
        executar(a.so_analise)
        det = f"{(agora_ms() - inicio) / 60_000:.0f} min"
    except Exception as e:
        ok, det = False, repr(e)
        raise
    finally:
        try:
            lista = (con.kv_ler("execucoes") or [])[-199:]
            lista.append({"tempo": agora_ms(), "tipo": "ranking_acoes", "origem": "github" if NA_NUVEM else "pc",
                          "ok": ok, "detalhe": det[:200]})
            con.kv_gravar("execucoes", lista)
        except Exception:
            pass


if __name__ == "__main__":
    main()
