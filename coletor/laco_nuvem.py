"""Laço da nuvem: roda a coleta de hora em hora (minuto :07) por ~5h30 dentro de uma única
execução do GitHub Actions e, no fim, dispara a próxima execução.

Por quê: o agendador do GitHub atrasa e pula execuções deste repositório (em 07–08/10/2026
rodou 3 vezes em 20 h). Uma execução longa que se renova não depende dele; o agendamento
fica só como rede de segurança. Repositório público = minutos ilimitados.
"""
import os
import subprocess
import sys
import time

import requests

DURACAO_S = 5.5 * 3600
AQUI = os.path.dirname(os.path.abspath(__file__))


def rodar(script, *args):
    r = subprocess.run([sys.executable, os.path.join(AQUI, script), *args])
    return r.returncode == 0


def disparar_proxima():
    repo, token = os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GITHUB_TOKEN")
    if not (repo and token):
        print("fora do GitHub Actions: não disparo a próxima execução")
        return
    r = requests.post(f"https://api.github.com/repos/{repo}/actions/workflows/coleta.yml/dispatches",
                      headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
                      json={"ref": os.environ.get("GITHUB_REF_NAME", "main")}, timeout=30)
    print("próxima execução disparada" if r.status_code == 204 else f"falha ao disparar a próxima: {r.status_code} {r.text[:200]}")


def main():
    inicio = time.time()
    falhas = 0
    while True:
        # ranking diário: só trabalha se o último tiver mais de 24 h
        if not rodar("ranking_diario.py", "--se-velho", "24"):
            falhas += 1
        if not rodar("acoes_ranking.py", "--se-velho", "24"):   # ranking das carteiras de ações
            falhas += 1
        if not rodar("coleta_hora.py"):
            falhas += 1
        proxima = (time.time() // 3600 + 1) * 3600 + 7 * 60
        if proxima - inicio > DURACAO_S:
            break
        print(time.strftime("%H:%M:%S"), f"próxima coleta às {time.strftime('%H:%M', time.gmtime(proxima))} UTC", flush=True)
        time.sleep(max(0, proxima - time.time()))
    disparar_proxima()
    if falhas:
        print(f"{falhas} etapa(s) falharam nesta execução")
        sys.exit(1)   # o GitHub manda e-mail de falha


if __name__ == "__main__":
    main()
