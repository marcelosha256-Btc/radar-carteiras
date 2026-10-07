"""Monta os dados do painel: mercado dos 6 ativos, ranking de carteiras, fluxo, alertas,
Diário de sinais e a fase 2 (stops/liquidações, suportes/resistências, regime).
Grava no banco (o site na Vercel lê de lá) e gera o painel.html local.

  python gerar_painel.py      # gera na hora, sem esperar a coleta
"""
import json
import statistics as st
import time
from collections import defaultdict
from pathlib import Path

import analise as an
import fase2
from db import RAIZ, conectar
from hl import Hyperliquid

MODELO = RAIZ / "web" / "index.html"
SAIDA_HTML = RAIZ / "painel.html"
ATIVOS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "NEAR"]
DIA = 86_400_000


def mm(xs, n):
    return sum(xs[-n:]) / n if len(xs) >= n else None


def tendencia_diaria(velas):
    c = [float(v["c"]) for v in velas]
    m50, m200 = mm(c, 50), mm(c, 200)
    m50_antes = sum(c[-60:-10]) / 50 if len(c) >= 60 else None
    if m50 is None:
        return "flat", "histórico curto"
    sobe = m50_antes is not None and m50 > m50_antes
    if c[-1] > m50 and (m200 is None or m50 > m200) and sobe:
        return "up", f"preço acima da média de 50{' e de 200' if m200 else ''} dias, média de 50 subindo"
    if c[-1] < m50 and (m200 is None or m50 < m200) and not sobe:
        return "down", "preço abaixo da média de 50 dias, média caindo"
    return "flat", "preço e médias sem direção clara"


def leitura_4h(velas):
    """Regime do 4h, faixa dos últimos 3 dias e percentil do volume da última vela fechada."""
    h = [float(v["h"]) for v in velas]
    l = [float(v["l"]) for v in velas]
    c = [float(v["c"]) for v in velas]
    vol = [float(v["v"]) * float(v["c"]) for v in velas[:-1]]  # a última vela ainda está aberta
    jan = 18  # 3 dias de velas de 4 h
    amps = [(max(h[i - jan:i]) - min(l[i - jan:i])) / c[i - 1] for i in range(jan, len(c) + 1)]
    amp_rel = amps[-1] / st.median(amps) if amps else 1
    m50 = mm(c, 50)
    m50_antes = sum(c[-56:-6]) / 50 if len(c) >= 56 else None
    if amp_rel < 0.8 or m50 is None or m50_antes is None:
        regime = "flat"
    elif c[-1] > m50 and m50 > m50_antes:
        regime = "up"
    elif c[-1] < m50 and m50 < m50_antes:
        regime = "down"
    else:
        regime = "flat"
    pct_vol = round(100 * sum(1 for v in vol if v <= vol[-1]) / len(vol)) if vol else None
    return regime, min(l[-jan:]), max(h[-jan:]), pct_vol, amp_rel


FRASES = {
    ("up", "flat"): "Alta no diário, pausa no 4h. Espere o fundo da faixa para comprar.",
    ("up", "up"): "Alta no diário e no 4h. Tendência a favor: compre recuos.",
    ("up", "down"): "Alta no diário, correção no 4h. Espere o 4h parar de cair.",
    ("flat", "flat"): "Sem tendência no diário nem no 4h. Opere só os extremos da faixa.",
    ("flat", "up"): "Diário sem direção, 4h subindo. Movimento curto, alvo no topo da faixa.",
    ("flat", "down"): "Diário sem direção, 4h caindo. Espere suporte antes de comprar.",
    ("down", "up"): "Baixa no diário, repique no 4h. Cuidado com compras.",
    ("down", "flat"): "Baixa no diário, pausa no 4h. Vendas no topo da faixa.",
    ("down", "down"): "Baixa no diário e no 4h. Fique de fora ou vendido.",
}


def tendencias_diarias(hl, con, agora):
    """Tendência do diário muda uma vez por dia: guarda no banco e só recalcula na virada do dia."""
    hoje = time.strftime("%Y-%m-%d", time.gmtime(agora / 1000))
    salvo = con.kv_ler("tendencia_diaria")
    if salvo and salvo.get("dia") == hoje:
        return salvo["ativos"]
    ativos = {t: list(tendencia_diaria(hl.velas(t, "1d", agora - 320 * DIA, agora))) for t in ATIVOS}
    con.kv_gravar("tendencia_diaria", {"dia": hoje, "ativos": ativos})
    return ativos


def mercado(hl, consenso, con):
    meta, ctxs = hl.info({"type": "metaAndAssetCtxs"})
    ctx = {u["name"]: c for u, c in zip(meta["universe"], ctxs)}
    agora = int(time.time() * 1000)
    out = []
    diarias = tendencias_diarias(hl, con, agora)
    for t in ATIVOS:
        c = ctx[t]
        px, ontem = float(c["markPx"]), float(c["prevDayPx"])
        d, d_por_que = diarias[t]
        h, lo, hi, vol, amp = leitura_4h(hl.velas(t, "4h", agora - 90 * DIA, agora))
        frase = FRASES[(d, h)]
        if vol is not None and vol < 10:
            frase += " Volume seco: espere o rompimento."
        cons = consenso.get(t, {"long": 0, "short": 0})
        out.append({"t": t, "px": px, "ch": (px / ontem - 1) * 100, "D": d, "D_por_que": d_por_que, "H": h,
                    "lo": lo, "hi": hi, "vol": vol, "amp": amp,
                    "funding": float(c["funding"]) * 24 * 365 * 100,
                    "oi": float(c["openInterest"]) * px, "L": cons["long"], "S": cons["short"], "frase": frase})
    return out


def situacao(r, crit):
    if r["confiavel"]:
        return "confiavel"
    if r["segura_prejuizo"]:
        return "segura"
    if r["operacoes"] < crit["operacoes"]:
        return "poucas"
    if (r["copia_mediana"] or 0) <= 0:
        return "copia_perde"
    if r["horas_mediana"] < crit["horas"]:
        return "giro"
    return "observar"


def gerar(hl=None, con=None):
    hl = hl or Hyperliquid()
    con = con or conectar()
    agora = int(time.time() * 1000)
    rk = con.kv_ler("ranking")
    crit = rk["criterio"]

    # posições atuais vêm da última foto de hora em hora, não do ranking
    pos = defaultdict(list)
    for p in con.execute("SELECT * FROM posicoes"):
        pos[p["endereco"]].append({"moeda": p["moeda"], "lado": p["lado"], "alav": p["alavancagem"],
                                   "entrada": p["preco_entrada"], "pnl": p["pnl_aberto"]})

    carteiras = []
    for r in rk["carteiras"]:
        if not (r["confiavel"] or len(carteiras) < 80):
            continue
        carteiras.append({k: r[k] for k in ("endereco", "grupo", "operacoes", "acerto", "minimo", "mediana",
                                            "copia_mediana", "copia_n", "horas_mediana", "pior_queda", "pnl_usd",
                                            "moedas", "confiavel")}
                         | {"situacao": situacao(r, crit), "posicoes": pos.get(r["endereco"], [])})

    # consenso atual das confiáveis (um voto por grupo), a partir da foto mais recente
    vistos, consenso = set(), defaultdict(lambda: {"long": 0, "short": 0})
    for r in rk["carteiras"]:
        if not r["confiavel"]:
            continue
        chave = r["grupo"] or r["endereco"]
        if chave in vistos:
            continue
        vistos.add(chave)
        for p in pos.get(r["endereco"], []):
            consenso[p["moeda"]][p["lado"]] += 1

    fluxo = {r["moeda"]: [(r["c"] or 0) / 1e6, (r["v"] or 0) / 1e6] for r in con.execute(
        "SELECT moeda, SUM(compra) c, SUM(venda) v FROM fluxo_diario WHERE dia>=? GROUP BY moeda", (agora - 7 * DIA,))}
    fluxo_top = sorted(fluxo.items(), key=lambda x: -(x[1][0] + x[1][1]))[:8]

    alertas = [dict(r) for r in con.execute(
        "SELECT * FROM alertas WHERE confiavel=1 AND tempo>=? ORDER BY tempo DESC LIMIT 40", (agora - 2 * DIA,))]
    n_alertas_24h = con.execute("SELECT COUNT(*) FROM alertas WHERE tempo>=?", (agora - DIA,)).fetchone()[0]

    mids = {k: float(v) for k, v in hl.info({"type": "allMids"}).items()}
    sinais = []
    for s in con.execute("SELECT * FROM sinais ORDER BY aberto_em DESC"):
        s = dict(s)
        if s["fechado_em"] is None and mids.get(s["moeda"]):
            sinal = 1 if s["lado"] == "long" else -1
            s["agora"] = sinal * (mids[s["moeda"]] / s["preco_abertura"] - 1) - 2 * an.TAXA_TAKER
        sinais.append(s)

    ultima_foto = con.execute("SELECT MAX(tempo) FROM fotos").fetchone()[0]
    ativos = mercado(hl, consenso, con)
    dados = {
        "gerado": agora,
        "coleta": {"ultima_foto": ultima_foto, "ranking": rk["gerado"], "dias": rk["dias"],
                   "atraso_min": rk["atraso_min"], "criterio": crit,
                   "rastreadas": con.execute("SELECT COUNT(*) FROM fotos").fetchone()[0],
                   "com_operacoes": len(rk["carteiras"]),
                   "confiaveis": sum(1 for r in rk["carteiras"] if r["confiavel"]),
                   "alertas_24h": n_alertas_24h, "ordens_em": con.kv_ler("ordens_em")},
        "ativos": ativos,
        "fase2": fase2.calcular(hl, con, ativos, consenso, agora),
        "carteiras": carteiras,
        "consenso": sorted(([m, v["long"], v["short"]] for m, v in consenso.items()),
                           key=lambda x: -(x[1] + x[2]))[:10],
        "fluxo": [[m, round(b, 2), round(s, 2)] for m, (b, s) in fluxo_top],
        "alertas": alertas,
        "sinais": sinais,
    }
    con.kv_gravar("painel", dados)
    html = MODELO.read_text(encoding="utf-8").replace("/*DADOS*/null", json.dumps(dados, ensure_ascii=False))
    SAIDA_HTML.write_text(html, encoding="utf-8")
    return SAIDA_HTML


if __name__ == "__main__":
    print("painel gerado em", gerar())
