# Estudo: níveis do dia e estrutura (25/11/2026)

Mede se os sinais do gráfico da Liquidez ao vivo (`web/grafico/calc.js`) têm vantagem, em velas de 15 min de BTC, ETH e SOL
(Binance spot, jan/2024 a nov/2026, ~100 mil velas por ativo). Rodar: `node estudos/niveis_estrutura/medir.mjs`
(baixa as velas na primeira vez e guarda em `m15_*.json`, ignorado pelo git).

Método: entrada na abertura da vela seguinte ao sinal, uma operação por vez, stop e alvo em múltiplos do ATR(14) de 15 min,
custo de 0,10% ida e volta, empate na mesma vela conta o stop. Cada sinal é comparado com a linha de base (entrar sem sinal, mesmo lado,
mesmo método). Três configurações: 1/1,5 ATR (até 8 h), 3/4,5 ATR (até 1 dia), 6/9 ATR (até 2 dias).

Resultado em `resultado_25-11-2026.txt`. Resumo: nenhum sinal deu ganho líquido consistente. Limites: um só regime de mercado
(alta forte em 2024-25, queda em 2026), três ativos, ações não testadas (a Hyperliquid só guarda ~52 dias de 15 min).

## Tempos maiores (25/11/2026): `medir_tf.mjs 1h|4h|1d`
BTC, ETH e SOL desde 09/2020, mesmo método (entrada na abertura seguinte, stop/alvo em ATR, custo 0,1% ida e volta, comparação com entrar sem sinal).
Resultados em `resultado_1h_*.txt`, `resultado_4h_*.txt`, `resultado_1d_*.txt`.
- 1 h e 4 h: nenhum sinal com vantagem firme; os retestes confirmados ficaram piores que a base.
- Diário: só "fechou abaixo da mínima do mês passado" (venda) se destacou: +0,41R sobre a base (t=2,6; ~69 casos; positivo nas duas metades e nos 3 ativos). Com 32 sinais testados, um t de 2,6 pode ser acaso, e os casos se concentram em poucas quedas. Não é confirmação. Para confirmar, precisa de mais ativos (ações) ou de um período novo.
