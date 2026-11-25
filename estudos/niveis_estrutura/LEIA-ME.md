# Estudo: níveis do dia e estrutura (25/11/2026)

Mede se os sinais do gráfico da Liquidez ao vivo (`web/grafico/calc.js`) têm vantagem, em velas de 15 min de BTC, ETH e SOL
(Binance spot, jan/2024 a nov/2026, ~100 mil velas por ativo). Rodar: `node estudos/niveis_estrutura/medir.mjs`
(baixa as velas na primeira vez e guarda em `m15_*.json`, ignorado pelo git).

Método: entrada na abertura da vela seguinte ao sinal, uma operação por vez, stop e alvo em múltiplos do ATR(14) de 15 min,
custo de 0,10% ida e volta, empate na mesma vela conta o stop. Cada sinal é comparado com a linha de base (entrar sem sinal, mesmo lado,
mesmo método). Três configurações: 1/1,5 ATR (até 8 h), 3/4,5 ATR (até 1 dia), 6/9 ATR (até 2 dias).

Resultado em `resultado_25-11-2026.txt`. Resumo: nenhum sinal deu ganho líquido consistente. Limites: um só regime de mercado
(alta forte em 2024-25, queda em 2026), três ativos, ações não testadas (a Hyperliquid só guarda ~52 dias de 15 min).
