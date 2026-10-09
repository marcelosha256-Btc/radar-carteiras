"""Cliente da API pública da Hyperliquid com controle de peso por minuto.

Regras de limite (por IP): 1200 de peso por minuto. clearinghouseState, l2Book,
allMids e afins pesam 2; o resto pesa 20. userFills* cobram +1 a cada 20 itens
devolvidos e candleSnapshot +1 a cada 60. Usamos um orçamento abaixo do teto
para sobrar folga.
"""
import threading
import time
import requests

API = "https://api.hyperliquid.xyz/info"
LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"

LEVES = {"clearinghouseState", "l2Book", "allMids", "orderStatus", "spotClearinghouseState", "exchangeStatus"}
POR_20 = {"userFills", "userFillsByTime", "recentTrades", "historicalOrders", "fundingHistory", "userFunding"}
FILLS_POR_PAGINA = 2000
FILLS_MAXIMO = 10000  # a API só guarda os 10 mil fills mais recentes de cada carteira


class Hyperliquid:
    def __init__(self, orcamento_por_minuto=1000):
        self.orcamento = orcamento_por_minuto
        self.gasto = []  # (timestamp, peso)
        self.trava = threading.Lock()   # várias threads dividem o mesmo orçamento
        self.s = requests.Session()
        self.s.mount("https://", requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=16))

    def _reservar(self, peso):
        while True:
            with self.trava:
                agora = time.time()
                self.gasto = [(t, p) for t, p in self.gasto if agora - t < 60]
                if sum(p for _, p in self.gasto) + peso <= self.orcamento:
                    self.gasto.append((agora, peso))
                    return
            time.sleep(0.5)

    def info(self, corpo):
        tipo = corpo["type"]
        self._reservar(2 if tipo in LEVES else 20)
        for tentativa in range(6):
            try:
                r = self.s.post(API, json=corpo, timeout=40)
                if r.status_code == 429:
                    time.sleep(10 * (tentativa + 1))
                    continue
                r.raise_for_status()
                dados = r.json()
                break
            except (requests.RequestException, ValueError):
                time.sleep(3 * (tentativa + 1))
        else:
            raise RuntimeError(f"Hyperliquid não respondeu a {tipo} depois de 6 tentativas")
        if isinstance(dados, list):
            extra = len(dados) // 20 if tipo in POR_20 else len(dados) // 60 if tipo == "candleSnapshot" else 0
            if extra:
                with self.trava:
                    self.gasto.append((time.time(), extra))
        return dados

    def leaderboard(self):
        r = self.s.get(LEADERBOARD, timeout=120)
        r.raise_for_status()
        return r.json()["leaderboardRows"]

    def fills(self, carteira, desde_ms):
        """Fills desde `desde_ms`, em ordem crescente. Devolve (fills, truncado).

        truncado=True quando a carteira tem mais fills do que a API guarda para o
        período: é robô de alta frequência e não serve para copiar.
        """
        saida, cursor = [], desde_ms
        janela_ms = time.time() * 1000 - desde_ms
        while True:
            pagina = self.info({"type": "userFillsByTime", "user": carteira,
                                "startTime": cursor, "aggregateByTime": True})
            if not pagina:
                break
            # 2000 fills em menos de 1/5 da janela: passaria de 10 mil no período, é robô
            if not saida and len(pagina) >= FILLS_POR_PAGINA and pagina[-1]["time"] - pagina[0]["time"] < janela_ms / 5:
                return [], True
            saida += pagina
            if len(pagina) < FILLS_POR_PAGINA:
                break
            if len(saida) >= FILLS_MAXIMO:
                return [], True
            cursor = max(f["time"] for f in pagina) + 1
        return saida, False

    def velas(self, moeda, intervalo, inicio_ms, fim_ms):
        """Velas paginadas (a API devolve no máximo ~5000 por chamada)."""
        saida, cursor = [], inicio_ms
        while cursor < fim_ms:
            pagina = self.info({"type": "candleSnapshot", "req": {
                "coin": moeda, "interval": intervalo, "startTime": cursor, "endTime": fim_ms}})
            if not pagina:
                break
            saida += pagina
            ultimo = max(v["t"] for v in pagina)
            if ultimo <= cursor:
                break
            cursor = ultimo + 1
        return saida

    def estado(self, carteira, dex=None):
        """dex=None é o grupo principal (cripto); dex="xyz" traz as posições em ações e commodities."""
        corpo = {"type": "clearinghouseState", "user": carteira}
        if dex:
            corpo["dex"] = dex
        return self.info(corpo)

    def ordens(self, carteira, dex=None):
        corpo = {"type": "frontendOpenOrders", "user": carteira}
        if dex:
            corpo["dex"] = dex
        return self.info(corpo)

    def livro(self, moeda, sig=None):
        corpo = {"type": "l2Book", "coin": moeda}
        if sig:
            corpo["nSigFigs"] = sig
        return self.info(corpo)["levels"]
