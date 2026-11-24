// Testes das métricas do diário em R, com números calculados à mão.  Rodar: node --test tests/diario.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricas, porGrupo, rAberto, confianca } from '../web/diario/metricas.js';

const perto = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `esperado ${b}, veio ${a}`);
const T = (id, r, extra = {}) => ({ id, status: 'fechado', r, fechamento: id * 1000, lado: 'compra', entrada: 100, stop: 90, setup: 'A', ativo: 'BTC', ...extra });

test('métricas básicas: +2, -1, -1, +3, -1', () => {
  const m = metricas([T(1, 2), T(2, -1), T(3, -1), T(4, 3), T(5, -1)]);
  assert.equal(m.n, 5);
  perto(m.totalR, 2); perto(m.expectancia, 0.4); perto(m.acerto, 0.4);
  perto(m.mediaGanho, 2.5); perto(m.mediaPerda, -1); perto(m.payoff, 2.5);
  perto(m.fatorLucro, 5 / 3);
  assert.equal(m.maiorSequenciaPerdas, 2);
  perto(m.drawdownR, 2);   // pico 2 → 0 depois de duas perdas seguidas
  assert.deepEqual(m.curva, [2, 1, 0, 3, 2]);
});

test('ignora abertas e ordena pelo fechamento, não pelo id', () => {
  const m = metricas([T(1, -1, { fechamento: 3000 }), T(2, 2, { fechamento: 1000 }), { id: 3, status: 'aberto', r: null }]);
  assert.equal(m.n, 2);
  assert.deepEqual(m.curva, [2, 1]);
});

test('sem operações e só ganhos', () => {
  assert.equal(metricas([]).n, 0);
  const m = metricas([T(1, 1), T(2, 2)]);
  assert.equal(m.fatorLucro, Infinity);
  assert.equal(m.payoff, null);
  assert.equal(m.maiorSequenciaPerdas, 0);
});

test('agrupar por setup', () => {
  const g = porGrupo([T(1, 2, { setup: 'A' }), T(2, -1, { setup: 'B' }), T(3, 1, { setup: 'A' }), T(4, 1, { setup: null })], 'setup');
  assert.equal(g[0].chave, 'A'); perto(g[0].totalR, 3); assert.equal(g[0].n, 2);
  assert.ok(g.some(x => x.chave === '(sem)'));
});

test('R aberto em compra e venda', () => {
  perto(rAberto({ lado: 'compra', entrada: 100, stop: 90 }, 115), 1.5);
  perto(rAberto({ lado: 'venda', entrada: 100, stop: 110 }, 85), 1.5);
  perto(rAberto({ lado: 'venda', entrada: 100, stop: 110 }, 105), -0.5);
  assert.equal(rAberto({ lado: 'compra', entrada: 100, stop: 100 }, 99), null);
});

test('confiança honesta pela amostra', () => {
  assert.equal(confianca(metricas([])).nivel, 'nenhuma');
  assert.equal(confianca(metricas([T(1, 1)])).nivel, 'baixa');
  assert.equal(confianca(metricas(Array.from({ length: 40 }, (_, i) => T(i + 1, i % 2 ? -1 : 1.5)))).nivel, 'media');
});

// ---- cálculo de R no servidor (web/diario/calculo.js) ----
import { calcR, limpar } from '../web/diario/calculo.js';

test('calcR: compra, venda, taxas e aberta', () => {
  const c = calcR({ lado: 'compra', entrada: 100, stop: 90, saida: 120 });
  perto(c.r, 2); assert.equal(c.status, 'fechado'); assert.equal(c.resultado_usd, null);
  perto(calcR({ lado: 'venda', entrada: 100, stop: 110, saida: 95 }).r, 0.5);
  perto(calcR({ lado: 'compra', entrada: 100, stop: 90, saida: 90 }).r, -1);
  const t = calcR({ lado: 'compra', entrada: 100, stop: 90, saida: 120, risco_usd: 100, taxas_usd: 10 });
  perto(t.r, 1.9); perto(t.resultado_usd, 190);   // 2R menos 10% do risco em taxas
  assert.equal(calcR({ lado: 'compra', entrada: 100, stop: 90, saida: null }).status, 'aberto');
});

test('limpar: vírgula decimal, valores inválidos e texto longo', () => {
  const o = limpar({ ativo: 'BTC', lado: 'compra', entrada: '68,5', stop: 'abc', nota: 'x'.repeat(3000), campo_estranho: 1 });
  assert.equal(o.entrada, 68.5); assert.equal(o.stop, null); assert.equal(o.nota.length, 2000); assert.ok(!('campo_estranho' in o));
  assert.throws(() => limpar({ lado: 'lado errado' }), /lado/);
  assert.throws(() => limpar({ tipo: 'x' }), /tipo/);
});
