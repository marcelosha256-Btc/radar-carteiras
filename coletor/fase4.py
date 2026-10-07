"""Fase 4: setups de swing trade testados no histórico diário, sem olhar o futuro.

Regras fixadas antes de ver os resultados (o mesmo conjunto para os 6 ativos):
sinal no fechamento do dia, entrada na abertura seguinte, stop a 3 ATR, alvo 1,5R,
saída por tempo em 20 dias, custo de 0,1% ida e volta; stop e alvo no mesmo dia
contam como stop; um setup não abre duas operações juntas no mesmo ativo.
Passa no filtro com 30+ operações, acerto ≥ 55%, mediana ≥ +0,15R E média
positiva nos 30% finais do histórico (fora da amostra).
"""
import math
import statistics as st
import time
from datetime import datetime, timezone

import requests

from analise import wilson

ATIVOS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "NEAR"]
DIA_S = 86400
STOP_ATR = 3.0
ALVO_R = 1.5
MAX_DIAS = 20
CUSTO = 0.001
AQUECIMENTO = 210            # barras para as médias de 200 estabilizarem
CRITERIO = {"n": 30, "acerto": 0.55, "mediana": 0.15}
FORA_DA_AMOSTRA = 0.30
UA = {"User-Agent": "radar-carteiras"}


# ---------- dados ----------

def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def velas_coinbase(moeda):
    fim = int(time.time()) // DIA_S * DIA_S
    barras = {}
    while True:
        ini = fim - 300 * DIA_S
        for tentativa in range(4):
            r = requests.get(f"https://api.exchange.coinbase.com/products/{moeda}-USD/candles",
                             params={"granularity": DIA_S, "start": _iso(ini), "end": _iso(fim)}, timeout=30, headers=UA)
            if r.status_code != 429:
                break
            time.sleep(2 * (tentativa + 1))
        d = r.json() if r.status_code == 200 else []
        if not d:
            break
        for t, lo, hi, op, cl, _ in d:
            barras[t] = (float(op), float(hi), float(lo), float(cl))
        fim = ini
        time.sleep(0.12)
    return barras


def velas_hyperliquid(hl, moeda):
    agora = int(time.time() * 1000)
    return {v["t"] // 1000: (float(v["o"]), float(v["h"]), float(v["l"]), float(v["c"]))
            for v in hl.velas(moeda, "1d", agora - 2000 * DIA_S * 1000, agora)}


def historico(hl, moeda):
    """Velas diárias fechadas (sem a de hoje), da fonte com mais história."""
    cb = velas_coinbase(moeda)
    hlv = velas_hyperliquid(hl, moeda)
    barras, fonte = (cb, "Coinbase") if len(cb) >= len(hlv) else (hlv, "Hyperliquid")
    hoje = int(time.time()) // DIA_S * DIA_S
    ts = sorted(t for t in barras if t < hoje)
    o, h, l, c = (list(x) for x in zip(*(barras[t] for t in ts))) if ts else ([], [], [], [])
    return {"ts": ts, "o": o, "h": h, "l": l, "c": c, "fonte": fonte}


# ---------- indicadores ----------

def sma(xs, n):
    out, soma = [None] * len(xs), 0.0
    for i, x in enumerate(xs):
        soma += x
        if i >= n:
            soma -= xs[i - n]
        if i >= n - 1:
            out[i] = soma / n
    return out


def rsi(xs, n):
    out = [None] * len(xs)
    ganho = perda = 0.0
    for i in range(1, len(xs)):
        d = xs[i] - xs[i - 1]
        g, p = max(d, 0.0), max(-d, 0.0)
        if i <= n:
            ganho += g / n
            perda += p / n
            if i < n:
                continue
        else:
            ganho = (ganho * (n - 1) + g) / n
            perda = (perda * (n - 1) + p) / n
        out[i] = 100.0 if perda == 0 else 100 - 100 / (1 + ganho / perda)
    return out


def atr(h, l, c, n=14):
    out = [None] * len(c)
    v = None
    for i in range(1, len(c)):
        tr = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        v = tr if v is None else (v * (n - 1) + tr) / n
        if i >= n:
            out[i] = v
    return out


def crsi(c):
    """Connors RSI: média de RSI(3) do preço, RSI(2) da sequência de altas/quedas e
    percentil do retorno de 1 dia nos últimos 100."""
    seq = [0]
    for i in range(1, len(c)):
        s = seq[-1]
        seq.append((s + 1 if s > 0 else 1) if c[i] > c[i - 1] else (s - 1 if s < 0 else -1) if c[i] < c[i - 1] else 0)
    r3, rs = rsi(c, 3), rsi([float(x) for x in seq], 2)
    roc = [None] + [c[i] / c[i - 1] - 1 for i in range(1, len(c))]
    out = [None] * len(c)
    for i in range(101, len(c)):
        janela = roc[i - 100:i]
        pr = 100 * sum(1 for x in janela if x < roc[i]) / 100
        if r3[i] is not None and rs[i] is not None:
            out[i] = (r3[i] + rs[i] + pr) / 3
    return out


def indicadores(d):
    c, h, l = d["c"], d["h"], d["l"]
    n = len(c)
    ind = {"c": c, "h": h, "l": l, "o": d["o"], "sma20": sma(c, 20), "sma50": sma(c, 50), "sma200": sma(c, 200),
           "rsi2": rsi(c, 2), "rsi14": rsi(c, 14), "atr": atr(h, l, c)}
    max20 = [None] * n
    min20 = [None] * n
    largura = [None] * n
    for i in range(20, n):
        max20[i] = max(h[i - 20:i])
        min20[i] = min(l[i - 20:i])
        largura[i] = (max20[i] - min20[i]) / c[i - 1]
    # compressão: largura dos 20 dias anteriores entre as 25% menores do último ano
    comp = [False] * n
    for i in range(270, n):
        janela = [x for x in largura[i - 250:i] if x is not None]
        comp[i] = sum(1 for x in janela if x < largura[i]) / len(janela) <= 0.25
    ind.update({"max20": max20, "min20": min20, "comp": comp})
    return ind


def _tend(ind, i, lado):
    s50, s200, c = ind["sma50"], ind["sma200"], ind["c"]
    if i < 10 or s200[i] is None or s50[i - 10] is None:
        return False
    if lado == "alta":
        return c[i] > s200[i] and s50[i] > s200[i] and s50[i] > s50[i - 10]
    return c[i] < s200[i] and s50[i] < s200[i] and s50[i] < s50[i - 10]


SETUPS = [
    {"id": "correcao_alta", "nome": "Correção em tendência de alta", "lado": "long", "sentido": -1,
     "cond": lambda k, i: _tend(k, i, "alta") and k["rsi2"][i] is not None and k["rsi2"][i] < 10},
    {"id": "repique_baixa", "nome": "Repique em tendência de baixa", "lado": "short", "sentido": 1,
     "cond": lambda k, i: _tend(k, i, "baixa") and k["rsi2"][i] is not None and k["rsi2"][i] > 90},
    {"id": "rompimento_alta", "nome": "Rompimento depois de lateralidade", "lado": "long", "sentido": 1,
     "cond": lambda k, i: k["comp"][i] and k["max20"][i] is not None and k["sma200"][i] is not None
     and k["c"][i] > k["max20"][i] and k["c"][i] > k["sma200"][i]},
    {"id": "perda_suporte", "nome": "Perda de suporte depois de lateralidade", "lado": "short", "sentido": -1,
     "cond": lambda k, i: k["comp"][i] and k["min20"][i] is not None and k["sma200"][i] is not None
     and k["c"][i] < k["min20"][i] and k["c"][i] < k["sma200"][i]},
    {"id": "euforia", "nome": "Euforia: preço esticado", "lado": "short", "sentido": 1,
     "cond": lambda k, i: k["sma20"][i] is not None and k["atr"][i] is not None and k["rsi14"][i] is not None
     and k["c"][i] > k["sma20"][i] + 3 * k["atr"][i] and k["rsi14"][i] > 80},
]


# ---------- teste ----------

def testar(setup, ind, ts):
    o, h, l, c, a = ind["o"], ind["h"], ind["l"], ind["c"], ind["atr"]
    n = len(c)
    long = setup["lado"] == "long"
    ops, i = [], AQUECIMENTO
    while i < n - 1:
        if a[i] and setup["cond"](ind, i):
            e = o[i + 1]
            risco = STOP_ATR * a[i]
            stop = e - risco if long else e + risco
            alvo = e + ALVO_R * risco if long else e - ALVO_R * risco
            curto = l[i] if long else h[i]          # o stop "comum", logo depois da barra do sinal
            r = None
            curto_pego = False
            for j in range(i + 1, min(i + 1 + MAX_DIAS, n)):
                if (long and l[j] <= curto) or (not long and h[j] >= curto):
                    curto_pego = True
                if (long and l[j] <= stop) or (not long and h[j] >= stop):
                    r = -1.0
                    break
                if (long and h[j] >= alvo) or (not long and l[j] <= alvo):
                    r = ALVO_R
                    break
            else:
                if i + MAX_DIAS < n:
                    j = i + MAX_DIAS
                    r = (c[j] - e) / risco * (1 if long else -1)
            if r is None:          # ainda não terminou: fica de fora do teste
                break
            ops.append({"t": ts[i], "r": r - CUSTO * e / risco, "curto": curto_pego, "dias": j - i})
            i = j + 1
            continue
        i += 1
    return ops


def resumo(ops, corte_ts):
    rs = [x["r"] for x in ops]
    fora = [x["r"] for x in ops if x["t"] >= corte_ts]
    n = len(rs)
    ganhos = sum(1 for r in rs if r > 0)
    out = {"n": n, "acerto": ganhos / n if n else None, "minimo": wilson(ganhos, n) if n else None,
           "mediana": st.median(rs) if rs else None, "media": st.fmean(rs) if rs else None,
           "n_fora": len(fora), "media_fora": st.fmean(fora) if fora else None,
           "stopado": sum(1 for r in rs if r <= -0.99) / n if n else None,
           "curto_pego": sum(1 for x in ops if x["curto"]) / n if n else None}
    out["passa"] = bool(n >= CRITERIO["n"] and out["acerto"] >= CRITERIO["acerto"]
                        and out["mediana"] >= CRITERIO["mediana"] and fora and out["media_fora"] > 0)
    return out


def gatilho(setup, d, px):
    """Preço de fechamento de hoje que dispararia o setup (busca numa grade de ±25%)."""
    base = {k: d[k][-400:] for k in ("o", "h", "l", "c")}
    ult = base["c"][-1]
    melhor = None
    passos = [k * 0.0025 for k in range(0, 101)]
    for p in passos:
        preco = px * (1 + setup["sentido"] * p)
        teste = {"o": base["o"] + [ult], "h": base["h"] + [max(ult, preco)],
                 "l": base["l"] + [min(ult, preco)], "c": base["c"] + [preco]}
        ind = indicadores_rapidos(teste)
        if setup["cond"](ind, len(teste["c"]) - 1):
            melhor = preco
            break
    return melhor


def indicadores_rapidos(d):
    """Mesmos indicadores, mas a compressão só é calculada para a última barra."""
    c, h, l = d["c"], d["h"], d["l"]
    n = len(c)
    ind = {"c": c, "h": h, "l": l, "o": d["o"], "sma20": sma(c, 20), "sma50": sma(c, 50), "sma200": sma(c, 200),
           "rsi2": rsi(c, 2), "rsi14": rsi(c, 14), "atr": atr(h, l, c)}
    max20 = [None] * n
    min20 = [None] * n
    comp = [False] * n
    i = n - 1
    max20[i], min20[i] = max(h[i - 20:i]), min(l[i - 20:i])
    larg = lambda k: (max(h[k - 20:k]) - min(l[k - 20:k])) / c[k - 1]
    janela = [larg(k) for k in range(max(20, i - 250), i)]
    comp[i] = bool(janela) and sum(1 for x in janela if x < larg(i)) / len(janela) <= 0.25
    ind.update({"max20": max20, "min20": min20, "comp": comp})
    return ind


def contexto(d, ind):
    c, ts = d["c"], d["ts"]
    n = len(c)
    estado = lambda i: "alta" if _tend(ind, i, "alta") else "baixa" if _tend(ind, i, "baixa") else "lateral"
    atual = estado(n - 1)
    dias = 0
    while dias < n - 1 and estado(n - 1 - dias) == atual:
        dias += 1
    # semanas fechando acima da média de 20 semanas
    semanas = {}
    for t, x in zip(ts, c):
        ano, sem, _ = datetime.fromtimestamp(t, timezone.utc).isocalendar()
        semanas[(ano, sem)] = x
    fech = [semanas[k] for k in sorted(semanas)][:-1]   # a semana atual ainda não fechou
    m20 = sma(fech, 20)
    seguidas = 0
    for k in range(len(fech) - 1, -1, -1):
        if m20[k] is None or fech[k] <= m20[k]:
            break
        seguidas += 1
    topo = max(d["h"][-120:])
    cr = crsi(c)
    return {"estado": atual, "dias": dias, "semanas_acima": seguidas, "dist_topo": c[-1] / topo - 1,
            "crsi": cr[-1], "atr": ind["atr"][-1], "atr_pct": ind["atr"][-1] / c[-1]}


def calcular_base(hl, precos):
    """Parte diária (pesada): histórico, indicadores, testes, gatilhos e contexto."""
    saida = {"dia": time.strftime("%Y-%m-%d", time.gmtime()), "criterio": CRITERIO,
             "regras": {"stop_atr": STOP_ATR, "alvo_r": ALVO_R, "max_dias": MAX_DIAS, "custo": CUSTO,
                        "fora_da_amostra": FORA_DA_AMOSTRA},
             "ativos": {}}
    for m in ATIVOS:
        d = historico(hl, m)
        if len(d["c"]) < AQUECIMENTO + 60:
            saida["ativos"][m] = {"erro": f"histórico curto ({len(d['c'])} dias)", "fonte": d["fonte"]}
            continue
        ind = indicadores(d)
        ts = d["ts"]
        corte = ts[AQUECIMENTO] + (ts[-1] - ts[AQUECIMENTO]) * (1 - FORA_DA_AMOSTRA)
        px = precos.get(m) or d["c"][-1]
        setups = []
        for s in SETUPS:
            ops = testar(s, ind, ts)
            r = resumo(ops, corte)
            ativo = bool(ind["atr"][-1] and s["cond"](ind, len(d["c"]) - 1))
            r.update({"id": s["id"], "nome": s["nome"], "lado": s["lado"], "ativo_ontem": ativo,
                      "gatilho": None if ativo else gatilho(s, d, px),
                      "ultimas": [{"t": x["t"], "r": round(x["r"], 2)} for x in ops[-5:]]})
            setups.append(r)
        saida["ativos"][m] = {"fonte": d["fonte"], "desde": time.strftime("%Y-%m-%d", time.gmtime(ts[0])),
                              "dias": len(ts), "ultimo_fechamento": d["c"][-1], "baixa_ontem": d["l"][-1],
                              "alta_ontem": d["h"][-1], "sinal_ts": ts[-1],
                              "contexto": contexto(d, ind), "setups": setups}
    saida["testes"] = sum(len(a.get("setups", [])) for a in saida["ativos"].values())
    saida["passam"] = sum(1 for a in saida["ativos"].values() for s in a.get("setups", []) if s["passa"])
    return saida


def base_do_dia(hl, con, precos):
    hoje = time.strftime("%Y-%m-%d", time.gmtime())
    salvo = con.kv_ler("swing_base")
    if salvo and salvo.get("dia") == hoje:
        return salvo
    base = calcular_base(hl, precos)
    con.kv_gravar("swing_base", base)
    return base


# ---------- Diário: registra e acompanha os sinais dos setups que passam ----------

def registrar_e_acompanhar(hl, con, precos, agora):
    """Registra no Diário os setups aprovados que dispararam e fecha os que bateram
    stop, alvo ou tempo. Devolve (novos, fechados) como listas, para os avisos."""
    base = base_do_dia(hl, con, precos)
    novos = []
    for m, a in base["ativos"].items():
        for s in a.get("setups", []):
            if not (s["passa"] and s["ativo_ontem"]):
                continue
            chave = f"swing:{a['sinal_ts']}"
            ja = con.execute("SELECT 1 FROM sinais WHERE origem=? AND moeda=? AND endereco=?",
                             (s["id"], m, chave)).fetchone()
            px = precos.get(m)
            if ja or not px:
                continue
            risco = STOP_ATR * a["contexto"]["atr"]
            long = s["lado"] == "long"
            stop = px - risco if long else px + risco
            alvo = px + ALVO_R * risco if long else px - ALVO_R * risco
            con.execute("INSERT INTO sinais (origem, endereco, moeda, lado, aberto_em, preco_abertura, stop, alvo) "
                        "VALUES (?,?,?,?,?,?,?,?)", (s["id"], chave, m, s["lado"], agora, px, stop, alvo))
            novos.append({"moeda": m, "lado": s["lado"], "nome": s["nome"], "entrada": px, "stop": stop, "alvo": alvo,
                          "n": s["n"], "acerto": s["acerto"], "mediana": s["mediana"], "media_fora": s["media_fora"]})
    fechados = []
    for s in con.execute("SELECT * FROM sinais WHERE origem<>'copia' AND fechado_em IS NULL").fetchall():
        long = s["lado"] == "long"
        risco = abs(s["preco_abertura"] - s["stop"])
        saida = None
        for v in hl.velas(s["moeda"], "1h", s["aberto_em"], agora):
            hi, lo = float(v["h"]), float(v["l"])
            if (long and lo <= s["stop"]) or (not long and hi >= s["stop"]):
                saida = s["stop"]
                break
            if (long and hi >= s["alvo"]) or (not long and lo <= s["alvo"]):
                saida = s["alvo"]
                break
        if saida is None and agora - s["aberto_em"] >= MAX_DIAS * DIA_S * 1000:
            saida = precos.get(s["moeda"])
        if saida is None:
            continue
        sinal = 1 if long else -1
        r = sinal * (saida - s["preco_abertura"]) / risco - CUSTO * s["preco_abertura"] / risco
        ret = sinal * (saida / s["preco_abertura"] - 1) - CUSTO
        con.execute("UPDATE sinais SET fechado_em=?, preco_fechamento=?, retorno=?, r=? WHERE id=?",
                    (agora, saida, ret, r, s["id"]))
        motivo = "alvo" if saida == s["alvo"] else "stop" if saida == s["stop"] else "tempo (20 dias)"
        fechados.append({"moeda": s["moeda"], "lado": s["lado"], "origem": s["origem"], "entrada": s["preco_abertura"],
                         "saida": saida, "r": r, "retorno": ret, "motivo": motivo})
    con.commit()
    return novos, fechados


# ---------- painel ----------

def painel(con, ativos, f2):
    base = con.kv_ler("swing_base")
    if not base:
        return None
    px = {a["t"]: a["px"] for a in ativos}
    hoje = {a["t"]: (a.get("lo_hoje"), a.get("hi_hoje")) for a in ativos}
    out = {"dia": base["dia"], "criterio": base["criterio"], "regras": base["regras"], "testes": base["testes"],
           "passam": base["passam"], "ativos": []}
    for m in ATIVOS:
        a = base["ativos"].get(m)
        if not a:
            continue
        if "erro" in a:
            out["ativos"].append({"t": m, "erro": a["erro"]})
            continue
        p = px.get(m, a["ultimo_fechamento"])
        setups = a["setups"]
        sentido = {x["id"]: x["sentido"] for x in SETUPS}
        for s in setups:
            s["dist"] = (s["gatilho"] / p - 1) if s["gatilho"] else None
            s["sentido"] = sentido[s["id"]]   # -1 dispara na queda, +1 na alta
        # principal: o que passa e está mais perto de disparar; senão, o mais perto entre todos
        candidatos = [s for s in setups if s["passa"]] or setups
        principal = min(candidatos, key=lambda s: 0 if s["ativo_ontem"] else abs(s["dist"]) if s["dist"] is not None else 9)
        ctx = a["contexto"]
        long = principal["lado"] == "long"
        entrada = p if principal["ativo_ontem"] else (principal["gatilho"] or p)
        risco = STOP_ATR * ctx["atr"]
        stop = entrada - risco if long else entrada + risco
        alvo2 = entrada + ALVO_R * risco if long else entrada - ALVO_R * risco
        liq = (f2 or {}).get(m, {}).get("liquidez", {})
        ima = liq.get("ima_acima") if long else liq.get("ima_abaixo")
        r_ima = ((ima - entrada) if long else (entrada - ima)) / risco if ima else None
        alvo1, motivo1 = (ima, "aglomerado de stops e liquidações (ímã de liquidez)") if r_ima and 0.5 <= r_ima < ALVO_R \
            else (entrada + risco if long else entrada - risco, "1R")
        # stop "comum": logo além da barra do sinal, que é a de hoje (fecha no gatilho)
        lo_h, hi_h = hoje.get(m, (None, None))
        curto = min(lo_h or entrada, entrada) if long else max(hi_h or entrada, entrada)
        plano = {"entrada": entrada, "stop": stop, "alvo1": alvo1, "motivo1": motivo1, "alvo2": alvo2,
                 "stop_curto": curto, "curto_pego": principal["curto_pego"], "stopado": principal["stopado"],
                 "atr": ctx["atr"], "atr_pct": ctx["atr_pct"]}
        out["ativos"].append({"t": m, "px": p, "fonte": a["fonte"], "desde": a["desde"], "contexto": ctx,
                              "setups": setups, "principal": principal["id"], "plano": plano})
    return out
