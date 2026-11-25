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

import { mediaSimples, regime, rsiSerie, fraseRsi } from '../web/rsi/calc.js';
import { faixaMedo, frase as fraseMedo } from '../web/contexto/medo.js';

test('mediaSimples: últimos n fechamentos; null sem histórico', () => {
  assert.equal(mediaSimples([1, 2, 3, 4], 2), 3.5);
  assert.equal(mediaSimples([1, 2], 3), null);
});
test('regime pelo RSI do dia', () => {
  assert.equal(regime(20).t, 'CAPITULAÇÃO'); assert.equal(regime(30).t, 'CAPITULAÇÃO');
  assert.equal(regime(34.3).t, 'QUEDA FORTE'); assert.equal(regime(37).t, 'QUEDA');
  assert.equal(regime(50).t, 'NEUTRO'); assert.equal(regime(72).t, 'EUFORIA'); assert.equal(regime(null).t, '—');
});
test('rsiSerie termina igual ao rsiWilder', () => {
  const c = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1);
  assert.ok(Math.abs(rsiSerie(c).at(-1) - rsiWilder(c)) < 1e-9);
  assert.equal(rsiSerie(c)[5], null);
});
test('fraseRsi: foi a sobrevenda e saiu / segue', () => {
  const cai = Array.from({ length: 30 }, (_, i) => 200 - i * 3);          // queda contínua: RSI muito baixo
  assert.match(fraseRsi(cai), /sobrevenda/);
  const volta = cai.concat([cai.at(-1) + 12, cai.at(-1) + 24, cai.at(-1) + 36, cai.at(-1) + 48]);
  assert.match(fraseRsi(volta), /saiu da sobrevenda/);
  assert.match(fraseRsi(volta), /Sozinho não prevê direção/);
  assert.equal(fraseRsi(Array.from({ length: 30 }, (_, i) => 100 + (i % 2))), '');
});
test('medo e ganância: faixa e frase', () => {
  assert.equal(faixaMedo(8).txt, 'medo extremo (≤10)'); assert.equal(faixaMedo(50).txt, 'neutro');
  assert.match(fraseMedo({ v: 13, sem: 11 }), /subiu de 11/);
  assert.match(fraseMedo({ v: 8, sem: 8 }), /contexto, não gatilho/);
  assert.equal(fraseMedo(null), '');
});

import { faixaVix, fraseVix } from '../web/contexto/vix.js';
test('VIX: faixas e frase', () => {
  assert.equal(faixaVix(12).txt, 'calmo (<15)'); assert.equal(faixaVix(26.4).txt, 'estresse (25 a 35)'); assert.equal(faixaVix(40).txt, 'pânico (≥35)');
  assert.match(fraseVix({ v: 26.4, ont: 26.6, sem: 20 }), /26,4 · estresse.*-0,2 no dia.*era 20,0 há 5 pregões.*não gatilho/);
  assert.equal(fraseVix(null), '');
});
