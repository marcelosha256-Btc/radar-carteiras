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

### Ações dos EUA, diário (`node medir_tf.mjs 1d acoes`, 30 ações e ETFs, 15 anos, Yahoo)
A pista do diário em cripto NÃO se repetiu: "fechou abaixo da mínima do mês passado" deu +0,005R sobre a base (n=1585, t=0,2). Na ação, o melhor sinal (BOS p/ baixo) deu +0,07R sobre a base e ainda -0,11R líquido. Nenhum sinal tem ganho líquido. Viés: ações atuais são as que subiram (a base de compra já embute isso). Resultado em `resultado_1d_acoes_*.txt`.

## Suporte/resistência por confluência (25/11/2026): `medir_sr.mjs 1h|4h` (rodado com SEM_FILTRO=1)
Fontes só de preço: máx./mín. de ontem, semana e mês passados + pivôs de 2 velas. Evento: o preço vem de cima (>0,5 ATR) e encosta na faixa.
"Segurou" = afasta 1,5 ATR antes de fechar 0,5 ATR além, em até 24 velas. Controle = faixa falsa deslocada 0,7–1,5 ATR.
- Na soma, os níveis verdadeiros pareciam segurar MENOS (47% vs 58–60%), mas era viés de distância: o controle tende a ser tocado por movimentos maiores.
- Comparando na MESMA distância percorrida até o toque, nível verdadeiro ≈ preço qualquer (1 h: 45,0% vs 47,0% a 0,5–1 ATR; 57,5% vs 57,3% a 1–1,5 ATR; 4 h igual).
- Confluência (2–3 ou 4+ níveis juntos) não melhora; no grupo mais comum, 4+ ficou até um pouco pior.
Conclusão: a camada S/R do gráfico é referência visual (onde estão os níveis), sem "força" e sem uso como gatilho.
