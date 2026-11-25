import test from 'node:test';
import assert from 'node:assert/strict';
import { rsiWilder, agrupar, faixa, resumo } from '../web/rsi/calc.js';

test('RSI de Wilder: série só subindo = 100, só caindo = 0, plana = 50, curta = null', () => {
  assert.equal(rsiWilder(Array.from({ length: 30 }, (_, i) => 100 + i)), 100);
  assert.equal(rsiWilder(Array.from({ length: 30 }, (_, i) => 100 - i)), 0);
  assert.equal(rsiWilder(Array(30).fill(5)), 50);
  assert.equal(rsiWilder([1, 2, 3]), null);
});

test('RSI de Wilder bate com o exemplo clássico (≈ 70,5 no 15º fechamento)', () => {
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  assert.ok(Math.abs(rsiWilder(c) - 70.46) < 0.1);
});

test('agrupar: 4H fecha com o último 1H do bloco UTC', () => {
  const H = 36e5, v = Array.from({ length: 9 }, (_, i) => ({ t: i * H, c: i }));
  assert.deepEqual(agrupar(v, 4 * H), [{ t: 0, c: 3 }, { t: 4 * H, c: 7 }, { t: 8 * H, c: 8 }]);
});

test('faixa e resumo', () => {
  assert.equal(faixa(18).nivel, 2); assert.equal(faixa(25).lado, -1); assert.equal(faixa(75).lado, 1); assert.equal(faixa(50).nivel, 0);
  const r = resumo([18, 28, 45, 60, null]);
  assert.equal(r.n, 2); assert.equal(r.lado, -1); assert.ok(r.txt.includes('sobrevenda') && r.txt.includes('1 extremo'));
  assert.equal(resumo([25, 75]).lado, 0);
});
