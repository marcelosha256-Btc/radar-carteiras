"""Transforma fills em operações, simula a cópia com atraso e monta o ranking."""
import bisect
import math
import statistics as st
from collections import defaultdict

EPS = 1e-9
TAXA_TAKER = 0.00045      # quem copia entra e sai a mercado
VELA_MS = 15 * 60 * 1000
VELA_1H_MS = 60 * 60 * 1000


def eh_perp(moeda):
    # "@123" e "PURR/USDC" são spot; "dex:ATIVO" são perps HIP-3 de outros dex;
    # "#123" são mercados de previsão que liquidam em 0 ou 1
    return not any(c in moeda for c in "@/:#")


# ---------- fills -> operações ----------

def _nova(moeda, f, pos):
    return {"moeda": moeda, "lado": "long" if pos > 0 else "short", "t0": f["tempo"], "pos": pos,
            "ent_val": abs(pos) * f["preco"], "ent_qtd": abs(pos), "sai_val": 0.0, "sai_qtd": 0.0,
            "max": abs(pos), "pnl": 0.0, "taxa": 0.0}


def _fechar(op, t1):
    entrada = op["ent_val"] / op["ent_qtd"]
    saida = op["sai_val"] / op["sai_qtd"]
    sinal = 1 if op["lado"] == "long" else -1
    retorno = sinal * (saida / entrada - 1) - op["taxa"] / (entrada * op["ent_qtd"])
    return {"moeda": op["moeda"], "lado": op["lado"], "t0": op["t0"], "t1": t1,
            "preco_entrada": entrada, "preco_saida": saida, "tamanho_max": op["max"],
            "pnl": op["pnl"] - op["taxa"], "retorno": retorno, "horas": (t1 - op["t0"]) / 3.6e6}


def montar_operacoes(fills, estados=None):
    """Uma operação vai de posição zerada até zerar (ou virar de lado) de novo.

    `estados` traz as operações que ficaram em andamento na coleta anterior
    ({moeda: dict ou None}); a função devolve (operações fechadas, estados novos),
    o que permite processar os fills aos poucos sem guardá-los.

    Posições que já estavam abertas antes da primeira coleta são ignoradas, porque
    não sabemos a entrada. Se faltar fill no meio (posição não bate), a operação
    em andamento é descartada.
    """
    estados = dict(estados or {})
    por_moeda = defaultdict(list)
    for f in fills:
        if eh_perp(f["moeda"]):
            por_moeda[f["moeda"]].append(f)
    ops = []
    for moeda, fs in por_moeda.items():
        fs.sort(key=lambda f: f["tempo"])
        atual = estados.get(moeda)
        for f in fs:
            antes = f["posicao_antes"]
            depois = antes + (f["tamanho"] if f["lado"] == "B" else -f["tamanho"])
            if atual and abs(antes - atual["pos"]) > 1e-6 * max(1.0, abs(antes)):
                atual = None
            if atual is None:
                if abs(antes) <= EPS and abs(depois) > EPS:
                    atual = _nova(moeda, f, depois)
                    atual["taxa"] += f["taxa"]
                elif abs(antes) > EPS and abs(depois) > EPS and antes * depois < 0:
                    atual = _nova(moeda, f, depois)
                    atual["taxa"] += f["taxa"] * abs(depois) / f["tamanho"]
                continue
            if antes * depois > 0 and abs(depois) > abs(antes):          # aumentou a posição
                q = abs(depois) - abs(antes)
                atual["ent_val"] += q * f["preco"]
                atual["ent_qtd"] += q
                atual["max"] = max(atual["max"], abs(depois))
                atual["taxa"] += f["taxa"]
                atual["pos"] = depois
                continue
            fechou = min(abs(antes), f["tamanho"])                        # reduziu, zerou ou virou
            fracao = fechou / f["tamanho"]
            atual["sai_val"] += fechou * f["preco"]
            atual["sai_qtd"] += fechou
            atual["pnl"] += f["pnl_fechado"]
            atual["taxa"] += f["taxa"] * fracao
            if abs(depois) <= EPS:
                ops.append(_fechar(atual, f["tempo"]))
                atual = None
            elif antes * depois < 0:
                ops.append(_fechar(atual, f["tempo"]))
                atual = _nova(moeda, f, depois)
                atual["taxa"] += f["taxa"] * (1 - fracao)
            else:
                atual["pos"] = depois
        estados[moeda] = atual
    return ops, estados


# ---------- cópia com atraso ----------

class Precos:
    def __init__(self, velas_por_moeda):
        # {moeda: [(t, abertura, fechamento), ...] ordenado}
        self.v = velas_por_moeda
        self.t = {m: [x[0] for x in vs] for m, vs in velas_por_moeda.items()}

    def em(self, moeda, t):
        """Preço aproximado no instante t: interpola dentro da vela. As velas são de
        15 min nos últimos ~52 dias e de 1 h antes disso (a API só guarda 5 mil de cada)."""
        ts = self.t.get(moeda)
        if not ts:
            return None
        i = bisect.bisect_right(ts, t) - 1
        if i < 0:
            return None
        dur = min(ts[i + 1] - ts[i], VELA_1H_MS) if i + 1 < len(ts) else VELA_MS
        if t - ts[i] >= dur:
            return None
        _, a, c = self.v[moeda][i]
        return a + (c - a) * (t - ts[i]) / dur


def retorno_copiando(op, precos, atraso_ms):
    p0 = precos.em(op["moeda"], op["t0"] + atraso_ms)
    p1 = precos.em(op["moeda"], op["t1"] + atraso_ms)
    if not p0 or not p1:
        return None
    sinal = 1 if op["lado"] == "long" else -1
    return sinal * (p1 / p0 - 1) - 2 * TAXA_TAKER


# ---------- ranking ----------

def wilson(ganhos, n, z=1.96):
    if n == 0:
        return 0.0
    p = ganhos / n
    d = 1 + z * z / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d


def pior_queda(retornos):
    """Maior queda da soma acumulada dos retornos (em pontos percentuais, sem alavancagem)."""
    pico = acum = queda = 0.0
    for r in retornos:
        acum += r
        pico = max(pico, acum)
        queda = min(queda, acum - pico)
    return queda


def resumo_carteira(ops):
    ops = sorted(ops, key=lambda o: o["t1"])
    n = len(ops)
    ganhos = sum(1 for o in ops if o["retorno"] > 0)
    rets = [o["retorno"] for o in ops]
    copias = [o["retorno_copia"] for o in ops if o.get("retorno_copia") is not None]
    moedas = defaultdict(int)
    for o in ops:
        moedas[o["moeda"]] += 1
    return {
        "operacoes": n,
        "ganhos": ganhos,
        "acerto": ganhos / n if n else 0,
        "minimo": wilson(ganhos, n),
        "mediana": st.median(rets) if rets else 0,
        "media": st.fmean(rets) if rets else 0,
        "copia_n": len(copias),
        "copia_mediana": st.median(copias) if copias else None,
        "copia_media": st.fmean(copias) if copias else None,
        "copia_acerto": sum(1 for c in copias if c > 0) / len(copias) if copias else None,
        "horas_mediana": st.median([o["horas"] for o in ops]) if ops else 0,
        "pnl_usd": sum(o["pnl"] for o in ops),
        "pior_queda": pior_queda(rets),
        "moedas": [m for m, _ in sorted(moedas.items(), key=lambda x: -x[1])[:4]],
    }


def agrupar(ops_por_carteira, minimo_comum=5, jaccard_min=0.3):
    """Carteiras que abrem a mesma moeda, no mesmo lado, no mesmo par de minutos
    repetidas vezes provavelmente pertencem à mesma entidade."""
    chaves = {}
    for end, ops in ops_por_carteira.items():
        s = set()
        for o in ops:
            b = o["t0"] // 120_000
            s.add((o["moeda"], o["lado"], b))
        if len(s) >= minimo_comum:
            chaves[end] = s
    pai = {e: e for e in chaves}

    def raiz(e):
        while pai[e] != e:
            pai[e] = pai[pai[e]]
            e = pai[e]
        return e

    ends = list(chaves)
    for i, a in enumerate(ends):
        for b in ends[i + 1:]:
            comum = len(chaves[a] & chaves[b])
            if comum >= minimo_comum and comum / len(chaves[a] | chaves[b]) >= jaccard_min:
                pai[raiz(a)] = raiz(b)
    grupos = defaultdict(list)
    for e in ends:
        grupos[raiz(e)].append(e)
    rotulo = {}
    for i, membros in enumerate(sorted((g for g in grupos.values() if len(g) > 1), key=len, reverse=True), 1):
        for e in membros:
            rotulo[e] = i
    return rotulo
