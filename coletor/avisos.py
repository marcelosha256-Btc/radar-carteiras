"""Avisos por e-mail sem senha de e-mail: o workflow abre uma issue no próprio
repositório mencionando o dono, e o GitHub manda o e-mail da notificação.

Só funciona dentro do GitHub Actions (usa o GITHUB_TOKEN do próprio workflow).
Fora dele, o aviso só vai para o log.
"""
import os

import requests

DONO = "marcelosha256-Btc"
SITE = "https://radar-carteiras.vercel.app"


def avisar(titulo, corpo, rotulo="radar"):
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    texto = f"{corpo}\n\nPainel: {SITE}\n\n@{DONO}"
    if not (token and repo):
        print(f"[aviso, só no log] {titulo}\n{corpo}", flush=True)
        return False
    url = f"https://api.github.com/repos/{repo}/issues"
    cab = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    try:
        r = requests.post(url, timeout=30, headers=cab, json={"title": titulo, "body": texto, "labels": [rotulo]})
        if r.status_code in (403, 422):   # sem permissão para criar o rótulo: manda sem ele
            r = requests.post(url, timeout=30, headers=cab, json={"title": titulo, "body": texto})
        r.raise_for_status()
        return True
    except requests.RequestException as e:
        print(f"aviso não enviado ({e}): {titulo}", flush=True)
        return False
