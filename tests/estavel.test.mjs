import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estavel } from '../web/aovivo/estavel.js';

const R = { liberado: 70, folga: 5, confirmaMs: 120e3 };
const seq = (pts) => { const mem = {}; return pts.map(([t, sc, b = false]) => estavel(mem, 'k', sc, b, t * 1000, R)); };

test('pico de segundos não libera', () => {
  const r = seq([[0, 73], [20, 63], [40, 72]]);
  assert.equal(r[0].lib, false); assert.ok(r[0].espera > 0);
  assert.equal(r[1].espera, 0);          // caiu abaixo de 65: zera
  assert.equal(r[2].lib, false); assert.ok(Math.abs(r[2].espera - 120e3) < 1);
});
test('2 min seguidos acima do limite libera', () => {
  const r = seq([[0, 71], [60, 74], [119, 72], [120, 71]]);
  assert.deepEqual(r.map(x => x.lib), [false, false, false, true]);
});
test('queda pequena (dentro da folga) não zera a contagem', () => {
  const r = seq([[0, 71], [60, 67], [120, 70]]);
  assert.equal(r[1].lib, false); assert.ok(r[1].espera > 0);
  assert.equal(r[2].lib, true);
});
test('liberado só cai abaixo de liberado − folga', () => {
  const r = seq([[0, 75], [130, 75], [140, 66], [150, 64]]);
  assert.deepEqual(r.map(x => x.lib), [false, true, true, false]);
});
test('bloqueio derruba na hora e zera', () => {
  const r = seq([[0, 80], [130, 80], [131, 80, true], [140, 80]]);
  assert.deepEqual(r.map(x => x.lib), [false, true, false, false]);
  assert.ok(r[3].espera > 0);
});
test('chaves independentes', () => {
  const mem = {};
  estavel(mem, 'BTC|day|venda', 80, false, 0, R);
  assert.equal(estavel(mem, 'BTC|day|venda', 80, false, 130e3, R).lib, true);
  assert.equal(estavel(mem, 'ETH|day|venda', 80, false, 130e3, R).lib, false);
});
