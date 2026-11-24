"""Alertas no Telegram: poucos e úteis. Roda como laço no GitHub Actions (alertas.yml), ~5h30 por execução.

Avisa só quando algo exige ação:
  1. operação aberta do Meu diário tocou o stop, o alvo 1 ou o alvo 2;
  2. posição real chegou perto da liquidação (menos de 8% do preço; só reavisa depois de afastar para 12%).
Preços e posições vêm direto da Hyperliquid a cada minuto (sem banco). O banco (Neon grátis, cota limitada) só é lido
a cada 20 min, para as operações abertas e o endereço da carteira, e só é escrito quando um alerta dispara.
Variáveis: DATABASE_URL, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.
"""
import os
import sys
import time

import requests

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

HL = "https://api.hyperliquid.xyz/info"
DURACAO_S = 5.5 * 3600
PASSO_S = 60
RELER_BANCO_S = 20 * 60
LIQ_AVISA, LIQ_REARMA = 0.08, 0.12


def preco_de(mids, ativo):
    for k in (ativo, "xyz:" + ativo):
        if k in mids:
            try:
                return float(mids[k])
            except (TypeError, ValueError):
                return None
    return None


def avaliar(trades, mids, posicoes, feitos):
    """Devolve (novos_alertas, feitos_atualizado). Puro: sem rede nem banco (testado em tests/test_alertas.py).
    feitos = conjunto de chaves já avisadas; cada alerta dispara uma vez por operação."""
    novos, feitos = [], set(feitos)
    abertos = set()
    for t in trades:
        tid = t["id"]
        abertos.add(tid)
        p = preco_de(mids, t["ativo"])
        if p is None:
            continue
        lado = 1 if t["lado"] == "compra" else -1
        nome = f"{t['ativo']} {t['lado']}"
        regras = [("stop", t.get("stop"), lambda x: lado * (p - x) <= 0, "🛑 Stop tocado"),
                  ("alvo1", t.get("alvo1"), lambda x: lado * (p - x) >= 0, "🎯 Alvo 1 atingido"),
                  ("alvo2", t.get("alvo2"), lambda x: lado * (p - x) >= 0, "🎯 Alvo 2 atingido")]
        for tag, nivel, cond, titulo in regras:
            chave = f"t{tid}:{tag}"
            if nivel and chave not in feitos and cond(float(nivel)):
                feitos.add(chave)
                novos.append(f"{titulo}: {nome}\nPreço agora {p:g} (nível {float(nivel):g}).\nAbra o Meu diário para fechar e registrar.")
    # operações que saíram da lista de abertas deixam de ocupar a memória
    feitos = {k for k in feitos if not k.startswith("t") or int(k[1:].split(":")[0]) in abertos}
    for q in posicoes:
        chave = "liq:" + q["coin"]
        d = q.get("dist")
        if d is None:
            continue
        if d < LIQ_AVISA and chave not in feitos:
            feitos.add(chave)
            novos.append(f"⚠️ Perto da liquidação: {q['coin'].replace('xyz:', '')} {q['lado']}\nFaltam {d * 100:.1f}% até a liquidação ({q['liq']:g}).")
        elif d > LIQ_REARMA and chave in feitos:
            feitos.discard(chave)
    return novos, feitos


def telegram(texto):
    tok, chat = os.environ.get("TELEGRAM_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not (tok and chat):
        print("sem TELEGRAM_TOKEN/TELEGRAM_CHAT_ID: alerta não enviado:", texto.replace("\n", " | "), flush=True)
        return False
    r = requests.post(f"https://api.telegram.org/bot{tok}/sendMessage", json={"chat_id": chat, "text": texto}, timeout=20)
    if r.status_code != 200:
        print("Telegram recusou:", r.status_code, r.text[:200], flush=True)
    return r.status_code == 200


def hl(corpo):
    r = requests.post(HL, json=corpo, timeout=20)
    r.raise_for_status()
    return r.json()


def posicoes_reais(user):
    out = []
    for dex in (None, "xyz"):
        try:
            st = hl({"type": "clearinghouseState", "user": user, **({"dex": dex} if dex else {})})
        except Exception:
            continue
        for x in st.get("assetPositions", []):
            p = x["position"]
            szi = float(p["szi"])
            if not szi or not p.get("liquidationPx"):
                continue
            mark, liq = abs(float(p["positionValue"]) / szi), float(p["liquidationPx"])
            out.append({"coin": p["coin"], "lado": "compra" if szi > 0 else "venda", "liq": liq, "dist": abs(mark - liq) / mark})
    return out


def ler_banco():
    """(trades abertos, endereço, feitos) ou None se o banco não respondeu (cota, rede): segue com o que já tinha."""
    try:
        from db import conectar
        c = conectar()
        try:
            trades = [dict(r) for r in c.execute("SELECT id, ativo, lado, stop, alvo1, alvo2 FROM diario_trades WHERE status = 'aberto'").fetchall()]
        except Exception:
            trades = []   # a tabela só existe depois do primeiro registro no Meu diário
        carteira = c.kv_ler("minha_carteira") or ""
        feitos = set((c.kv_ler("alertas_estado") or {}).get("feitos", []))
        return trades, carteira, feitos
    except Exception as e:
        print("banco indisponível, sigo com o último estado:", str(e)[:120], flush=True)
        return None


def gravar_feitos(feitos):
    try:
        from db import conectar
        conectar().kv_gravar("alertas_estado", {"feitos": sorted(feitos)})
    except Exception as e:
        print("não consegui gravar o estado dos alertas:", str(e)[:120], flush=True)


def disparar_proxima():
    repo, token = os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GITHUB_TOKEN")
    if not (repo and token):
        return
    r = requests.post(f"https://api.github.com/repos/{repo}/actions/workflows/alertas.yml/dispatches",
                      headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
                      json={"ref": os.environ.get("GITHUB_REF_NAME", "main")}, timeout=30)
    print("próxima execução disparada" if r.status_code == 204 else f"falha ao disparar a próxima: {r.status_code}", flush=True)


def main():
    fim = time.time() + DURACAO_S
    trades, carteira, feitos, ultimo_banco = [], "", set(), 0
    while time.time() < fim:
        if time.time() - ultimo_banco > RELER_BANCO_S:
            r = ler_banco()
            ultimo_banco = time.time()
            if r:
                trades, carteira, lidos = r
                feitos |= lidos
        try:
            mids = hl({"type": "allMids"})
            try:
                mids.update(hl({"type": "allMids", "dex": "xyz"}))
            except Exception:
                pass
            antes = set(feitos)
            novos, feitos = avaliar(trades, mids, posicoes_reais(carteira) if carteira else [], feitos)
            for msg in novos:
                print("ALERTA:", msg.replace("\n", " | "), flush=True)
                telegram(msg)
            if feitos != antes:
                gravar_feitos(feitos)
        except Exception as e:
            print("passo falhou:", str(e)[:150], flush=True)
        time.sleep(PASSO_S)
    disparar_proxima()


if __name__ == "__main__":
    if "--teste" in sys.argv:
        ok = telegram("✅ Radar de Carteiras: alertas conectados. Você receberá aqui só stops, alvos e risco de liquidação.")
        print("enviado" if ok else "NÃO enviado")
    else:
        main()
