# Fluxo agressivo da Binance (compra a mercado − venda a mercado) — 25/11/2026

Dados: velas de 15 min dos futuros da Binance (grátis, sem chave), ~2 anos (72.000 velas por moeda), BTC, ETH, SOL, XRP, NEAR.
Fluxo = (compra agressiva − venda agressiva) ÷ volume, na última vela de 15 min e na última hora.
Resultado medido: qual barreira o preço toca primeiro (+1 ATR ou −1 ATR), sem custo.

| prazo | base (subiu primeiro) | maior diferença de qualquer faixa de fluxo |
|---|---|---|
| 4 h (barreira ~ATR de 1 h) | 48,7% | ±1,0 ponto |
| 1 h (barreira ATR de 15 min) | 49,1% | ±1,5 ponto |

Conclusão: o fluxo agressivo **não antecipa** a direção nem no prazo da nota (4 h) nem no do gatilho (1 h).
Fluxo forte a favor (≥ +10%) dá o mesmo que fluxo neutro. Divergência preço × fluxo também não.
As amostras se sobrepõem (uma por vela), então os "z" exageram; diferenças de 1 ponto ficam abaixo do custo de operar.
Decisão: não entra na nota da Trava. Rodar de novo: `node baixar.mjs && node medir.mjs && node medir_curto.mjs` (dentro desta pasta).
