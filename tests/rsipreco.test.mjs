import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graficoSvg } from '../web/grafico/desenho.js';

const c = Array.from({ length: 60 }, (_, i) => { const x = 100 + Math.sin(i / 4) * 3; return { t: i * 36e5, o: x - 0.5, c: x, h: x + 1, l: x - 1, v: 1 }; });
test('linhas do RSI no preço: desenha as que caem na tela, ignora as de fora', () => {
  const { svg } = graficoSvg({ candles: c, ms: 36e5, preco: 100, rsiPreco: [{ v: 70, p: 102.5 }, { v: 50, p: 100.2 }, { v: 30, p: 60 }] });
  assert.match(svg, /RSI 70 · /); assert.match(svg, /RSI 50 · /); assert.doesNotMatch(svg, /RSI 30 · /);
});
test('sem a camada, nada de RSI no preço', () => {
  assert.doesNotMatch(graficoSvg({ candles: c, ms: 36e5, preco: 100 }).svg, /RSI 70 · /);
});
