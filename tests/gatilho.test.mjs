import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatilho, entradaLimite, velaDe, proximoFechamento } from '../web/aovivo/gatilho.js';

test('vela de 15 min e próximo fechamento', () => {
  const t = Date.UTC(2026, 10, 25, 18, 7, 30);
  assert.equal(proximoFechamento(t), Date.UTC(2026, 10, 25, 18, 15));
  assert.equal(velaDe(t), velaDe(Date.UTC(2026, 10, 25, 18, 0)));
  assert.notEqual(velaDe(t), velaDe(Date.UTC(2026, 10, 25, 18, 15)));
});
test('entrada-limite dá R:R exato', () => {
  const e = entradaLimite(110, 70, 2);   // venda: stop 110, alvo 70
  assert.ok(Math.abs((e - 70) / (110 - e) - 2) < 1e-9);
});
test('venda: fora da zona, esperando confirmação, liberada', () => {
  const base = { lado: 'venda', stop: 110, alvo: 70, rrMin: 2 };   // eLim ≈ 96,67
  assert.equal(gatilho({ ...base, cur: 90, dir: -1 }).estado, 'fora');
  assert.equal(gatilho({ ...base, cur: 100, dir: 1 }).estado, 'espera');
  assert.equal(gatilho({ ...base, cur: 100, dir: -1 }).estado, 'ok');
  assert.equal(gatilho({ ...base, cur: 100, dir: 0, livro: -0.5 }).estado, 'ok');
  assert.equal(gatilho({ ...base, cur: 100, dir: 0, livro: 0.5 }).estado, 'espera');
});
test('compra: zona abaixo do limite', () => {
  const base = { lado: 'compra', stop: 90, alvo: 130, rrMin: 2 };   // eLim ≈ 103,33
  assert.equal(gatilho({ ...base, cur: 110, dir: 1 }).estado, 'fora');
  assert.equal(gatilho({ ...base, cur: 100, dir: 1 }).estado, 'ok');
});
test('stop e alvo desarmam', () => {
  assert.equal(gatilho({ lado: 'venda', stop: 110, alvo: 70, cur: 111 }).estado, 'stop');
  assert.equal(gatilho({ lado: 'venda', stop: 110, alvo: 70, cur: 69 }).estado, 'alvo');
  assert.equal(gatilho({ lado: 'compra', stop: 90, alvo: 130, cur: 89 }).estado, 'stop');
});
