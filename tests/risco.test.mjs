// Núcleo de risco: consolidação das execuções, trava do dia e checklist.  Rodar: node --test tests/risco.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consolidarFills, travaDoDia, checklist, inicioDiaBRT, REGRAS_PADRAO } from '../web/risco/regras.js';

const H = 36e5, D = 24 * H;
const perto = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `esperado ${b}, veio ${a}`);
let tid = 0;
const F = (coin, side, px, sz, start, time, closedPnl = 0, fee = 0) => ({ coin, side, px: String(px), sz: String(sz), startPosition: String(start), time, tid: ++tid, closedPnl: String(closedPnl), fee: String(fee) });

test('compra em duas vezes, vende em duas: uma operação com preços médios e resultado líquido', () => {
  const o = consolidarFills([
    F('BTC', 'B', 100, 1, 0, 1000, 0, 0.1), F('BTC', 'B', 110, 1, 1, 2000, 0, 0.1),
    F('BTC', 'A', 120, 1, 2, 3000, 15, 0.1), F('BTC', 'A', 130, 1, 1, 4000, 25, 0.1)]);
  assert.equal(o.length, 1);
  const t = o[0];
  assert.equal(t.lado, 'compra'); perto(t.entrada, 105); perto(t.saida, 125); perto(t.qtd, 2);
  perto(t.resultado_usd, 40 - 0.4); assert.equal(t.status, 'fechado'); assert.equal(t.fechamento, 4000);
  assert.equal(t.mercado, 'cripto');
});

test('venda aberta em ação xyz e virada de mão', () => {
  const o = consolidarFills([
    F('xyz:NVDA', 'A', 150, 2, 0, 1000),                 // vende 2
    F('xyz:NVDA', 'B', 140, 5, -2, 2000, 20, 0.5),       // recompra 2 (fecha +20) e compra 3 (vira)
    F('xyz:NVDA', 'A', 145, 3, 3, 3000, 15, 0.2)]);      // fecha a compra
  assert.equal(o.length, 2);
  assert.equal(o[0].ativo, 'NVDA'); assert.equal(o[0].mercado, 'acoes'); assert.equal(o[0].lado, 'venda');
  perto(o[0].entrada, 150); perto(o[0].saida, 140); perto(o[0].resultado_usd, 19.5);
  assert.equal(o[1].lado, 'compra'); perto(o[1].entrada, 140); perto(o[1].qtd, 3); perto(o[1].resultado_usd, 14.8);
});

test('posição que veio de antes da janela é ignorada; posição ainda aberta fica aberta', () => {
  const o = consolidarFills([F('ETH', 'A', 10, 1, 1, 1000, 2), F('ETH', 'B', 9, 1, 0, 2000)]);
  assert.equal(o.length, 1); assert.equal(o[0].status, 'aberto'); assert.equal(o[0].saida, null); assert.equal(o[0].resultado_usd, null);
});

test('trava: perda real, perdas seguidas e operações do dia', () => {
  const agora = 20000 * D + 15 * H, ini = inicioDiaBRT(agora);
  assert.equal(ini, 20000 * D + 3 * H);   // 00h de Brasília = 03h UTC
  const real = [{ abertura: ini + H, fechamento: ini + 2 * H, resultado_usd: -10 }, { abertura: ini + 3 * H, fechamento: ini + 4 * H, resultado_usd: -15 },
    { abertura: ini - 5 * H, fechamento: ini - 4 * H, resultado_usd: -500 }];   // ontem não conta
  const t = travaDoDia({ real, capital: 975, aberto: 0, agora });
  perto(t.realizado, -25); perto(t.base, 1000); perto(t.pctReal, -2.5);
  assert.equal(t.parar, true); assert.equal(t.perdasReal, 2); assert.equal(t.opsReal, 2);
  const ok = travaDoDia({ real: real.slice(0, 1), capital: 990, agora });
  assert.equal(ok.parar, false);
  const papel = [1, 2, 3].map(i => ({ status: 'fechado', r: -1, abertura: ini + i * H, fechamento: ini + i * H + 1 }));
  const p = travaDoDia({ papel, capital: 1000, riscoPct: 0.5, agora });
  assert.equal(p.perdasPapel, 3); assert.equal(p.parar, true); perto(p.pctPapel, -1.5);
});

test('checklist: trava, notícia, R:R e risco total', () => {
  const agora = 20000 * D + 14 * H;   // 11h de Brasília
  const calc = { rr: 1.2, risco: 30, notional: 3000, custoStop: 0.001, cap: 1000, carrega: 5 };
  const it = checklist({ calc, trava: { parar: false, motivos: [], ops: 1 }, eventos: [{ t: agora + 10 * 60000, nome: 'CPI', impacto: 'alto' }], heatAberto: 30, agora });
  const tem = (nivel, txt) => it.some(([n, t]) => n === nivel && t.includes(txt));
  assert.ok(tem('ok', 'janela')); assert.ok(tem('bloqueia', 'CPI')); assert.ok(tem('bloqueia', 'R:R')); assert.ok(tem('bloqueia', 'Risco total'));
  const it2 = checklist({ calc: { ...calc, rr: 2.5 }, trava: { parar: true, motivos: ['3 perdas seguidas'], ops: 3 }, agora: agora + 5 * H });
  assert.ok(it2.some(([n, t]) => n === 'bloqueia' && t.includes('Pare por hoje')));
  assert.ok(it2.some(([n, t]) => n === 'aviso' && t.includes('Fora da sua janela')));
  assert.equal(REGRAS_PADRAO.rrMin, 2);
});
