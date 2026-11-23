"""Diário: setup de tendência "Donchian 20 com saída na mínima de 10 dias" (cripto, só compra, fechamento diário).

Regras (as mesmas do Backtest, modelo "Tendência: Donchian 20, saída na mínima de 10 dias"):
  entrada  fecha acima da máxima dos 20 dias anteriores, ADX(14) > 20 e preço acima da MME 50
  stop     3 ATR(14) abaixo da entrada (fixo, não sobe)
  saída    fechamento diário abaixo da mínima dos 10 dias anteriores (sem alvo) ou o stop, o que vier antes;
           no máximo 400 dias
Teste no diário desde 2020 (6 moedas, com custos): média +0,83R por operação, 134 operações, acerto 34%; metade antiga
+1,64R e metade recente +0,06R, e a referência "qualquer dia de tendência" deu +0,66R: a entrada pesa pouco, o que segura
o resultado é a saída. Por isso entra no Diário como "em observação": só mede daqui para a frente, sem dinheiro.
Os sinais vão para a tabela `sinais` (origem = ORIGEM) sem alvo; fase4.registrar_e_acompanhar ignora esta origem.
"""
import time

import fase4
from fase4 import ATIVOS, CUSTO, DIA_S, atr, historico

ORIGEM = "tendencia_donchian"
NOME = "Tendência: Donchian 20, saída na mínima de 10 dias (em observação)"
STOP_ATR = 3.0
MAX_DIAS = 400
ADX_MIN = 20


def mme(xs, n):
    out, k, v = [None] * len(xs), 2 / (n + 1), None
    for i, x in enumerate(xs):
        v = x if v is None else v + k * (x - v)
        if i >= n - 1:
            out[i] = v
    return out


def adx(h, l, c, n=14):
    """ADX de Wilder."""
    N = len(c)
    out = [None] * N
    tr = [0.0] * N; pdm = [0.0] * N; mdm = [0.0] * N
    for i in range(1, N):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        up, dn = h[i] - h[i - 1], l[i - 1] - l[i]
        pdm[i] = up if up > dn and up > 0 else 0.0
        mdm[i] = dn if dn > up and dn > 0 else 0.0
    if N <= 2 * n:
        return out
    s_tr, s_p, s_m = sum(tr[1:n + 1]), sum(pdm[1:n + 1]), sum(mdm[1:n + 1])
    dx = []
    for i in range(n, N):
        if i > n:
            s_tr = s_tr - s_tr / n + tr[i]; s_p = s_p - s_p / n + pdm[i]; s_m = s_m - s_m / n + mdm[i]
        pdi, mdi = (100 * s_p / s_tr, 100 * s_m / s_tr) if s_tr else (0.0, 0.0)
        dx.append(100 * abs(pdi - mdi) / (pdi + mdi) if pdi + mdi else 0.0)
        if len(dx) == n:
            out[i] = sum(dx) / n
        elif len(dx) > n:
            out[i] = (out[i - 1] * (n - 1) + dx[-1]) / n
    return out


def sinais_historicos(d):
    """Índices dos dias de fechamento que disparam o setup."""
    c, h, l = d["c"], d["h"], d["l"]
    n = len(c)
    m50, a = mme(c, 50), adx(h, l, c)
    res = []
    for i in range(21, n):
        topo, topo_ant = max(h[i - 20:i]), max(h[i - 21:i - 1])
        if m50[i] is not None and a[i] is not None and c[i] > topo and c[i - 1] <= topo_ant and a[i] > ADX_MIN and c[i] > m50[i]:
            res.append(i)
    return res


def saida_por_minima(d, desde_ts):
    """Primeiro dia fechado depois de `desde_ts` que fecha abaixo da mínima dos 10 dias anteriores -> (instante_ms, preço)."""
    c, l, ts = d["c"], d["l"], d["ts"]
    for j in range(10, len(c)):
        if ts[j] > desde_ts and c[j] < min(l[j - 10:j]):
            return (ts[j] + DIA_S) * 1000, c[j]
    return None


def acompanhar(sig, d, velas_1h, agora):
    """Decide se um sinal aberto fechou. `velas_1h`: [(t_ms, máx, mín)] desde a abertura. -> (t_ms, preço, motivo) ou None."""
    candidatos = []
    for t, hi, lo in velas_1h:
        if lo <= sig["stop"]:
            candidatos.append((t, sig["stop"], "stop")); break
    sd = saida_por_minima(d, int(sig["endereco"].split(":")[1]))
    if sd:
        candidatos.append((sd[0], sd[1], "mínima de 10 dias"))
    if candidatos:
        return min(candidatos, key=lambda x: x[0])
    return None


def registrar_e_acompanhar(hl, con, precos, agora):
    novos, fechados = [], []
    for m in ATIVOS:
        try:
            d = historico(hl, m)
        except Exception:
            continue
        if len(d["c"]) < 260:
            continue
        ts = d["ts"]
        abertos = con.execute("SELECT * FROM sinais WHERE origem=? AND moeda=? AND fechado_em IS NULL", (ORIGEM, m)).fetchall()
        for s in abertos:
            s = dict(s)
            velas = [(int(v["t"]), float(v["h"]), float(v["l"])) for v in hl.velas(m, "1h", s["aberto_em"], agora)]
            r_ = acompanhar(s, d, velas, agora)
            if r_ is None and agora - s["aberto_em"] >= MAX_DIAS * DIA_S * 1000 and precos.get(m):
                r_ = (agora, precos[m], f"tempo ({MAX_DIAS} dias)")
            if r_ is None:
                continue
            t, saida, motivo = r_
            risco = s["preco_abertura"] - s["stop"]
            r = (saida - s["preco_abertura"]) / risco - CUSTO * s["preco_abertura"] / risco
            ret = saida / s["preco_abertura"] - 1 - CUSTO
            con.execute("UPDATE sinais SET fechado_em=?, preco_fechamento=?, retorno=?, r=? WHERE id=?", (t, saida, ret, r, s["id"]))
            fechados.append({"moeda": m, "lado": "long", "origem": ORIGEM, "entrada": s["preco_abertura"], "saida": saida,
                             "r": r, "retorno": ret, "motivo": motivo})
        if ts and sinais_historicos(d)[-1:] == [len(ts) - 1]:   # disparou no último fechamento
            chave = f"tend:{ts[-1]}"
            ja = con.execute("SELECT 1 FROM sinais WHERE origem=? AND moeda=? AND (endereco=? OR fechado_em IS NULL)", (ORIGEM, m, chave)).fetchone()
            px = precos.get(m)
            if ja or not px:
                continue
            risco = STOP_ATR * atr(d["h"], d["l"], d["c"])[-1]
            con.execute("INSERT INTO sinais (origem, endereco, moeda, lado, aberto_em, preco_abertura, stop, alvo) VALUES (?,?,?,?,?,?,?,NULL)",
                        (ORIGEM, chave, m, "long", agora, px, px - risco))
            novos.append({"moeda": m, "lado": "long", "nome": NOME, "entrada": px, "stop": px - risco, "alvo": None})
    con.commit()
    return novos, fechados
