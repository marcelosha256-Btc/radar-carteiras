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

test('leituras: execução, fluxo com preço e posicionamento', async () => {
  const { leituraExecucao, leituraFluxo, leituraPosicao, fluxo } = await import('../web/mercado/tela.js');
  assert.equal(leituraExecucao(0.3, true)[0], 'ok'); assert.equal(leituraExecucao(8, true)[0], 'aviso'); assert.equal(leituraExecucao(1, false)[0], 'ruim');
  assert.match(leituraFluxo(0.25, 0.02)[1], /absorção/);        // muita venda, preço parado
  assert.equal(leituraFluxo(0.25, -0.5)[0], 'venda');
  assert.match(leituraFluxo(0.8, 0)[1], /exaustão/);
  assert.equal(leituraFluxo(0.8, 0.4)[0], 'compra');
  assert.equal(leituraFluxo(0.5, 0)[1], 'equilibrado');
  const p = leituraPosicao({ fundPerc: 0.03, fundAno: -8, dOI: -1.2, dPx: -2.5 });
  assert.match(p[0][1], /vendidos estão pagando/); assert.match(p[1][1], /comprados saindo/);
  assert.match(leituraPosicao({ fundPerc: 0.5, fundAno: 5, dOI: 1, dPx: -1 })[0][1], /vendidos novos/);
  assert.match(leituraPosicao({ fundPerc: 0.5, fundAno: 5, dOI: -1, dPx: 1 })[0][1], /frágil/);
  assert.equal(leituraPosicao({ fundPerc: 0.5, fundAno: 5, dOI: 0.1, dPx: 1 })[0][1], 'sem desequilíbrio');
  const f = fluxo([{ t: 0, usd: 100, lado: 'A', px: 100 }, { t: 1000, usd: 100, lado: 'A', px: 101 }], 2000);
  perto(f.dPx, 1);
});
