"""Para onde vai o dinheiro: rotação entre setores do mercado americano e detalhamento das ações.

Mapa de rotação (ideia do RRG, numa conta que dá para explicar):
  eixo X = quanto o ETF rendeu acima do S&P 500 nas últimas 13 semanas (força);
  eixo Y = se essa força está aumentando: o que rendeu acima do S&P nas últimas 4 semanas menos o
           ritmo médio de 4 semanas do trimestre (aceleração).
  Cada ponto é a média dos últimos 5 pregões (sem isso a cauda vira um zigue-zague de ruído diário).
  Liderando (X>0, Y>0) · Enfraquecendo (X>0, Y<0) · Atrasado (X<0, Y<0) · Melhorando (X<0, Y>0).
  A "cauda" é o mesmo ponto calculado nas 6 semanas anteriores.
Volume é só uma pista de fluxo (os dados de fluxo dos ETFs são pagos).

Detalhamento: as maiores ações de cada setor, com força relativa (1–99), tendência, distância do topo e
o setup "correção em tendência de alta" do swing (gatilho e resultado no histórico de 10 anos da ação,
contra comprar em qualquer dia). Calculado uma vez por dia (dados de fechamento do Yahoo).

  python rotacao.py                 # recalcula e grava kv 'rotacao' e a tabela rotacao_hist
  python rotacao.py --se-velho 20   # só se o último tiver mais de 20 h (laço da nuvem)
"""
import argparse
import os
import re
import statistics as st
import time
from concurrent.futures import ThreadPoolExecutor

import requests

import acoes
import acoes_swing
import fase4
from db import conectar
from hl import Hyperliquid

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}
NA_NUVEM = bool(os.environ.get("GITHUB_ACTIONS"))

# (nome, tipo, maiores ações) — listas fixas, revisar de vez em quando (empresas entram e saem dos índices)
ETFS = {
    "XLK": ("Tecnologia", "setor", "AAPL MSFT NVDA AVGO ORCL CRM AMD ADBE CSCO ACN IBM NOW INTU QCOM TXN"),
    "XLC": ("Comunicação", "setor", "META GOOGL NFLX TMUS DIS VZ T CMCSA EA TTWO CHTR LYV OMC"),
    "XLY": ("Consumo discricionário", "setor", "AMZN TSLA HD MCD BKNG TJX LOW SBUX NKE CMG ORLY MAR GM ABNB ROST"),
    "XLP": ("Consumo básico", "setor", "WMT COST PG KO PEP PM MO MDLZ CL TGT KMB GIS KR STZ"),
    "XLF": ("Financeiro", "setor", "JPM BRK-B V MA BAC WFC GS MS AXP SPGI BLK C SCHW PGR CB"),
    "XLV": ("Saúde", "setor", "LLY UNH JNJ ABBV MRK TMO ABT ISRG AMGN DHR PFE BSX SYK GILD VRTX MDT BMY ELV CI HCA MCK CVS REGN BDX HUM CNC BIIB CAH"),
    "XLI": ("Indústria", "setor", "GE CAT RTX UBER UNP HON ETN BA DE LMT ADP GD WM NOC UPS"),
    "XLE": ("Energia", "setor", "XOM CVX COP EOG WMB SLB KMI MPC PSX OKE VLO OXY FANG BKR"),
    "XLB": ("Materiais", "setor", "LIN SHW ECL APD FCX NEM CTVA DD DOW NUE VMC MLM PPG"),
    "XLU": ("Utilities (energia elétrica)", "setor", "NEE SO DUK CEG SRE AEP D VST EXC XEL PEG ED PCG"),
    "XLRE": ("Imobiliário", "setor", "PLD AMT EQIX WELL SPG PSA O CCI DLR VICI AVB EQR"),
    "SMH": ("Semicondutores", "segmento", "NVDA TSM AVGO AMD ASML QCOM TXN MU AMAT LRCX KLAC ADI INTC MRVL ARM"),
    "IGV": ("Software", "segmento", "MSFT ORCL CRM ADBE NOW INTU PLTR PANW SNOW CRWD WDAY ADSK DDOG"),
    "CIBR": ("Cibersegurança", "segmento", "PANW CRWD FTNT ZS NET OKTA CHKP CYBR"),
    "ITB": ("Construtoras", "segmento", "DHI LEN PHM NVR TOL KBH MTH"),
    "KRE": ("Bancos regionais", "segmento", "CFG FITB RF KEY HBAN MTB ZION WAL EWBC"),
    "XBI": ("Biotecnologia", "segmento", "VRTX REGN ALNY MRNA BIIB INCY EXEL NBIX SRPT"),
    "ITA": ("Defesa e aeroespacial", "segmento", "GE RTX BA LMT NOC GD HWM TDG LHX"),
    "GDX": ("Mineradoras de ouro", "segmento", "NEM AEM WPM FNV KGC AU"),
    "XOP": ("Petróleo (exploração)", "segmento", "COP EOG OXY FANG DVN APA"),
    "XRT": ("Varejo", "segmento", "AMZN WMT COST TJX ROST BBY DG DLTR ULTA"),
    "IYT": ("Transporte", "segmento", "UBER UNP UPS FDX CSX NSC ODFL DAL"),
    "URA": ("Urânio", "segmento", "CCJ NXE UEC"),
    "TAN": ("Energia solar", "segmento", "FSLR ENPH RUN SEDG"),
    "IWM": ("Small caps (Russell 2000)", "referencia", ""),
}
CONTEXTO = {"SPY": "S&P 500", "RSP": "S&P 500 com pesos iguais", "TLT": "Títulos longos dos EUA", "GLD": "Ouro", "UUP": "Dólar"}
CAUDA = 6          # semanas de cauda no mapa
DIA_S = 86400


def log(msg):
    print(time.strftime("%H:%M:%S"), "[rotação]", msg, flush=True)


def diario(tk, faixa="2y"):
    """Fechamentos e volume em dólar do Yahoo (sem o pregão em andamento)."""
    j = requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{tk}?range={faixa}&interval=1d", headers=UA, timeout=30).json()
    r = j["chart"]["result"][0]; q = r["indicators"]["quote"][0]; meta = r["meta"]
    tss = r.get("timestamp") or []
    col = lambda k: q.get(k) or [None] * len(tss)
    pts = [(t, c, (v or 0) * c) for t, c, v in zip(tss, col("close"), col("volume")) if c]
    reg = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    if pts and reg.get("start") and reg.get("end") and time.time() < reg["end"] and pts[-1][0] >= reg["start"]:
        pts.pop()                                  # pregão de hoje ainda aberto
    off = meta.get("gmtoffset", 0)
    dia = lambda t: (t + off) // DIA_S * DIA_S     # mesmo carimbo de data do acoes_swing.velas_bolsa
    return [dia(p[0]) for p in pts], [p[1] for p in pts], [p[2] for p in pts], meta.get("shortName") or meta.get("longName")


def ret(c, i, n):
    return c[i] / c[i - n] - 1 if i - n >= 0 else None


def ponto(c, s, i):
    """(x, y) do mapa no índice i: força em 13 semanas e aceleração nas últimas 4."""
    r13, r4 = ret(c, i, 63), ret(c, i, 21)
    s13, s4 = ret(s, i, 63), ret(s, i, 21)
    if None in (r13, r4, s13, s4):
        return None
    rel13, rel4 = r13 - s13, r4 - s4
    return [round(rel13 * 100, 2), round((rel4 - rel13 * 21 / 63) * 100, 2)]


def ponto_suave(c, s, i, n=5):
    """Média do ponto nos últimos 5 pregões: tira o vaivém diário e deixa a cauda legível."""
    pts = [p for p in (ponto(c, s, i - k) for k in range(n)) if p]
    return [round(st.fmean(p[0] for p in pts), 2), round(st.fmean(p[1] for p in pts), 2)] if pts else None


def quadrante(x, y):
    return ("liderando" if y >= 0 else "enfraquecendo") if x >= 0 else ("melhorando" if y >= 0 else "atrasado")


def alinhar(ts_a, c_a, ts_b, c_b):
    """Fechamentos de A e B nos mesmos dias."""
    mb = dict(zip(ts_b, c_b))
    pares = [(t, ca, mb[t]) for t, ca in zip(ts_a, c_a) if t in mb]
    return [p[1] for p in pares], [p[2] for p in pares]


def dados_acao(tk, xyz):
    """Força, tendência e o setup 'correção em alta' da ação (10 anos)."""
    d = acoes_swing.velas_bolsa(tk)
    if not d or len(d["c"]) < 260:
        return None
    c = d["c"]; n = len(c) - 1
    out = {"px": c[-1], "r1m": ret(c, n, 21), "r3m": ret(c, n, 63), "r12m": ret(c, n, 251),
           "topo": c[-1] / max(d["h"][-252:]) - 1, "a50": c[-1] > st.fmean(c[-50:]), "a200": c[-1] > st.fmean(c[-200:]),
           "xyz": tk in xyz, "dias": len(c), "ts": d["ts"], "c": c}
    if len(c) >= fase4.AQUECIMENTO + 60:
        ind = fase4.indicadores(d)
        s = next(x for x in fase4.SETUPS if x["id"] == "correcao_alta")
        corte = d["ts"][fase4.AQUECIMENTO] + (d["ts"][-1] - d["ts"][fase4.AQUECIMENTO]) * (1 - fase4.FORA_DA_AMOSTRA)
        r = fase4.resumo(fase4.testar(s, ind, d["ts"]), corte)
        ref = fase4.resumo(fase4.testar(fase4.QUALQUER_DIA, ind, d["ts"]), corte)
        tend = fase4._tend(ind, n, "alta")
        ativo = bool(ind["atr"][n] and s["cond"](ind, n))
        gat = None if (ativo or not tend) else fase4.gatilho(s, d, c[-1])
        out.update({"tend": tend, "rsi2": ind["rsi2"][n], "setup_ativo": ativo, "gatilho": gat,
                    "setup": {"n": r["n"], "acerto": r["acerto"], "media": r["media"], "media_fora": r["media_fora"],
                              "n_fora": r["n_fora"], "ref": ref["media"], "ref_fora": ref["media_fora"],
                              "ganha": bool(r["n"] >= 20 and r["media"] is not None and r["media_fora"] is not None
                                            and r["media"] > ref["media"] and r["media_fora"] > ref["media_fora"])}})
    return out


def balanco(tk):
    try:
        t = requests.get(f"https://api.nasdaq.com/api/analyst/{tk}/earnings-date", headers=UA, timeout=20).json()["data"]["reportText"]
        m = re.search(r"(\d\d)/(\d\d)/(\d{4})", t)
        return f"{m.group(3)}-{m.group(1)}-{m.group(2)}" if m else None
    except Exception:
        return None


def calcular_etfs(spy_ts, spy):
    etfs = []
    for tk, (nome, tipo, _) in ETFS.items():
        try:
            ts, c, vol, _ = diario(tk)
        except Exception:
            continue
        c, s = alinhar(ts, c, spy_ts, spy)
        if len(c) < 130:
            continue
        i = len(c) - 1
        cauda = [ponto_suave(c, s, i - 5 * k) for k in range(CAUDA, -1, -1)]
        cauda = [p for p in cauda if p]
        x, y = cauda[-1]
        rel4 = lambda j: ret(c, j, 21) - ret(s, j, 21)
        etfs.append({"tk": tk, "nome": nome, "tipo": tipo, "x": x, "y": y, "quadrante": quadrante(x, y), "cauda": cauda,
                     "r1": ret(c, i, 5), "r4": ret(c, i, 21), "r13": ret(c, i, 63), "rel4": rel4(i), "rel4_antes": rel4(i - 5),
                     "rel13": ret(c, i, 63) - ret(s, i, 63),
                     "vol": st.fmean(vol[-20:]) / st.fmean(vol[-120:-20]) if st.fmean(vol[-120:-20]) else None,
                     "a50": c[-1] > st.fmean(c[-50:]), "a200": c[-1] > st.fmean(c[-200:]) if len(c) >= 200 else None,
                     "topo": c[-1] / max(c[-252:]) - 1})
        time.sleep(0.12)
    for campo, chave in (("rel4", "rank"), ("rel4_antes", "rank_antes")):
        for k, e in enumerate(sorted([e for e in etfs if e["tipo"] != "referencia"], key=lambda e: -e[campo])):
            e[chave] = k + 1
    contexto = {}
    for tk, nome in CONTEXTO.items():
        try:
            ts, c, _, _ = diario(tk)
            contexto[tk] = {"nome": nome, "r4": ret(c, len(c) - 1, 21), "r13": ret(c, len(c) - 1, 63),
                            "a200": c[-1] > st.fmean(c[-200:])}
        except Exception:
            pass
        time.sleep(0.12)
    return etfs, contexto


def calcular(hl):
    t0 = time.time()
    spy_ts, spy, _, _ = diario("SPY")
    xyz = {u["name"].split(":", 1)[1] for u in hl.info({"type": "meta", "dex": acoes.DEX})["universe"]}
    etfs, contexto = calcular_etfs(spy_ts, spy)
    log(f"ETFs: {len(etfs)} ({time.time() - t0:.0f} s)")

    # ações: uma vez cada, mesmo que estejam em mais de um setor
    membros = {tk: v[2].split() for tk, v in ETFS.items() if v[2]}
    todas = sorted({a for lst in membros.values() for a in lst})
    acoes_d = {}
    for tk in todas:
        try:
            r = dados_acao(tk, xyz)
        except Exception:
            r = None
        if r:
            acoes_d[tk] = r
        time.sleep(0.1)
    # força relativa 1–99 entre todas (pesos 3/6/9/12 meses = 0,4/0,2/0,2/0,2, contra o S&P)
    for tk, a in acoes_d.items():
        c_al, s_al = alinhar(a["ts"], a["c"], spy_ts, spy)
        j = len(c_al) - 1
        partes = [(ret(c_al, j, n), ret(s_al, j, n), w) for n, w in ((63, .4), (126, .2), (189, .2), (251, .2))]
        a["nota"] = sum(w * (x - y) for x, y, w in partes) if all(x is not None and y is not None for x, y, _ in partes) else None
    com_nota = sorted([a for a in acoes_d.values() if a["nota"] is not None], key=lambda a: a["nota"])
    for k, a in enumerate(com_nota):
        a["forca"] = round(1 + 98 * k / max(1, len(com_nota) - 1))
    # amplitude dos setores: % das ações acima da média de 50 dias
    for e in etfs:
        lst = [acoes_d[a] for a in membros.get(e["tk"], []) if a in acoes_d]
        e["amplitude"] = sum(a["a50"] for a in lst) / len(lst) if lst else None
        e["n_acoes"] = len(lst)
    log(f"ações: {len(acoes_d)} de {len(todas)} ({time.time() - t0:.0f} s)")
    # próximos balanços das 6 mais fortes de cada setor
    alvo = sorted({a for lst in membros.values()
                   for a in sorted([x for x in lst if x in acoes_d], key=lambda x: -(acoes_d[x].get("forca") or 0))[:6]})
    with ThreadPoolExecutor(3) as ex:
        for tk, b in zip(alvo, ex.map(balanco, alvo)):
            acoes_d[tk]["balanco"] = b
    for a in acoes_d.values():
        a.pop("ts", None); a.pop("c", None)
    dia = time.strftime("%Y-%m-%d", time.gmtime(spy_ts[-1]))
    hist = [(dia, e["tk"], e["x"], e["y"], e["rel4"], e["rel13"]) for e in etfs]
    log(f"balanços: {len(alvo)} · total {time.time() - t0:.0f} s")
    return {"gerado": int(time.time() * 1000), "pregao": dia, "etfs": etfs, "contexto": contexto, "membros": membros,
            "acoes": acoes_d, "cauda_semanas": CAUDA}, hist


def executar(con=None, hl=None):
    con = con or conectar(); hl = hl or Hyperliquid()
    dados, hist = calcular(hl)
    con.kv_gravar("rotacao", dados)
    con.executemany("INSERT INTO rotacao_hist VALUES (?,?,?,?,?,?) ON CONFLICT (dia, etf) DO UPDATE SET "
                    "x=excluded.x, y=excluded.y, rel4=excluded.rel4, rel13=excluded.rel13", hist)
    con.commit()
    return dados


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--se-velho", type=float, default=None)
    a = ap.parse_args()
    con = conectar()
    v = con.kv_ler("rotacao")
    if a.se_velho is not None and v and time.time() * 1000 - v["gerado"] < a.se_velho * 3_600_000:
        return
    inicio, ok, det = time.time(), True, ""
    try:
        executar(con)
        det = f"{(time.time() - inicio) / 60:.0f} min"
    except Exception as e:
        ok, det = False, repr(e)
        raise
    finally:
        try:
            lista = (con.kv_ler("execucoes") or [])[-199:]
            lista.append({"tempo": int(time.time() * 1000), "tipo": "rotacao", "origem": "github" if NA_NUVEM else "pc",
                          "ok": ok, "detalhe": det[:200]})
            con.kv_gravar("execucoes", lista)
        except Exception:
            pass


if __name__ == "__main__":
    main()
