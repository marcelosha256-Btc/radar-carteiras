// Cálculos do "Mercado agora" com números feitos à mão.  Rodar: node --test tests/mercado.test.mjs
// O módulo da tela usa APIs do navegador só em funções chamadas depois; importar para testar as funções puras exige stubs mínimos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.document = { getElementById: () => ({ dataset: {} }), hidden: true, querySelector: () => null };
globalThis.setInterval = () => 0; globalThis.setTimeout = () => 0;
const { derrapagem, profundidade, fluxo, percentil } = await import('../web/mercado/tela.js');
const perto = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `esperado ${b}, veio ${a}`);

test('derrapagem: compra anda nas vendas e vendendo anda nas compras', () => {
  const asks = [{ px: '100', sz: '10' }, { px: '101', sz: '10' }];   // 1.000 e 1.010 em dólares
  const r = derrapagem(asks, 99.5, 1500, 'compra');
  // 1.000 a 100 (10 un) + 500 a 101 (4,950495 un) → preço médio 1500/14,950495 = 100,33
  perto(r.medio, 1500 / (10 + 500 / 101)); assert.ok(r.completo);
  perto(r.bps, (r.medio - 99.5) / 99.5 * 1e4);
  const bids = [{ px: '99', sz: '5' }];
  const v = derrapagem(bids, 99.5, 1000, 'venda');   // só há 495 de liquidez
  assert.equal(v.completo, false);
  perto(v.bps, (99.5 - 99) / 99.5 * 1e4);
});

test('profundidade dentro de 1% e se o livro cobre a faixa', () => {
  const bids = [{ px: '99.5', sz: '2' }, { px: '98.9', sz: '1' }, { px: '98', sz: '5' }];
  const asks = [{ px: '100.5', sz: '2' }, { px: '101.2', sz: '3' }];
  const d = profundidade(bids, asks, 100);
  perto(d.bid, 99.5 * 2); perto(d.ask, 100.5 * 2);   // 98,9 e 101,2 ficam fora de ±1%
  assert.equal(d.cobreBid, true); assert.equal(d.cobreAsk, true);
  assert.equal(profundidade([{ px: '99.6', sz: '1' }], [{ px: '100.2', sz: '1' }], 100).cobreBid, false);
});

test('fluxo: só os últimos 5 minutos; B = compra agressiva', () => {
  const agora = 1_000_000;
  const buf = [{ t: agora - 400000, usd: 999, lado: 'B' }, { t: agora - 100000, usd: 300, lado: 'B' }, { t: agora - 1000, usd: 100, lado: 'A' }];
  const f = fluxo(buf, agora);
  perto(f.compra, 300); perto(f.venda, 100); perto(f.pctCompra, 0.75);
  assert.equal(fluxo([], agora).pctCompra, null);
});

test('percentil do funding atual na própria história', () => {
  perto(percentil([1, 2, 3, 4], 3), 0.75); assert.equal(percentil([], 1), null);
});

test('variação do OI: usa a leitura mais antiga da janela e ignora leituras muito recentes', async () => {
  const { variacaoOI } = await import('../web/mercado/tela.js');
  const agora = 10 * 864e5, h = [{ t: agora - 5 * 36e5, oi: 100 }, { t: agora - 36e5, oi: 120 }, { t: agora - 60000, oi: 130 }];
  const v = variacaoOI(h, agora, 150);
  perto(v.pct, 50); perto(v.horas, 5);
  assert.equal(variacaoOI([{ t: agora - 60000, oi: 100 }], agora, 150), null);
  assert.equal(variacaoOI([{ t: agora - 4 * 864e5, oi: 100 }], agora, 150), null);
});
