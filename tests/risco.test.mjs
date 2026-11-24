// Núcleo de risco: consolidação das execuções, trava do dia e checklist.  Rodar: node --test tests/risco.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consolidarFills, travaDoDia, checklist, inicioDiaBRT, REGRAS_PADRAO, pregaoNY } from '../web/risco/regras.js';
import { zonasMapa, checarMapa, construir } from '../web/risco/zonas.js';

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

test('checklist: ordem mínima da Hyperliquid e posição no teto', () => {
  const agora = 20000 * D + 14 * H;
  const base = { rr: 2.5, risco: 5, notional: 8, custoStop: 0.001, cap: 1000, carrega: 0 };
  assert.ok(checklist({ calc: base, agora }).some(([n, t]) => n === 'bloqueia' && t.includes('ordem mínima')));
  const it = checklist({ calc: { ...base, notional: 1000, cortado: true, posMax: 1000, risco: 3 }, agora });
  assert.ok(it.some(([n, t]) => n === 'aviso' && t.includes('teto')));
  assert.ok(!it.some(([n, t]) => t.includes('ordem mínima')));
});

test('zonas do mapa: o mesmo critério da Trava, medido da entrada planejada', () => {
  // comprados liquidam em 595 (abaixo), vendidos em 661 (acima); faixas de 10
  const d = { bw: 10, L: [[595, 500e3], [610, 20e3]], S: [[661, 120e3], [700, 30e3]] };
  const z = zonasMapa(d, 627);
  assert.deepEqual([z.comprados.lo, z.comprados.hi, z.vendidos.lo, z.vendidos.hi], [590, 600, 656, 666]);
  // venda a 627: stop 666×1,0015 = 667, alvo 600 → R:R 0,67 → bloqueia e diz o preço mínimo
  const ruim = checarMapa({ lado: 'venda', e: 627, s: 672, d });
  assert.ok(ruim.some(([n, t]) => n === 'bloqueia' && t.includes('só vale vendendo em')));
  // venda a 650 com stop 672: R:R (650−600)/(667−650) ≈ 2,9 → ok
  assert.ok(checarMapa({ lado: 'venda', e: 650, s: 672, d }).some(([n]) => n === 'ok'));
  // stop 660 fica dentro da zona dos vendidos → aviso
  assert.ok(checarMapa({ lado: 'venda', e: 640, s: 660, d }).some(([n, t]) => n === 'aviso' && t.includes('dentro da zona')));
  assert.deepEqual(checarMapa({ lado: 'venda', e: 1, s: 2, d: null }), []);
});

test('checklist: vender colado no fundo recente e janela das ações pelo pregão de NY', () => {
  const calc = { rr: 2.5, risco: 5, notional: 100, custoStop: 0.001, cap: 1000, carrega: 0, e: 627, s: 674, side: -1, oposto: 622.85 };
  const fora = Date.parse('2026-11-24T21:40:00Z');   // 18h40 de Brasília: bolsa fechada
  const it = checklist({ calc, mercado: 'acoes', agora: fora });
  assert.ok(it.some(([n, t]) => n === 'aviso' && t.includes('vendendo no fundo')));
  assert.ok(it.some(([n, t]) => n === 'aviso' && t.includes('Fora do pregão de Nova York')));
  const abertura = Date.parse('2026-11-25T15:00:00Z');   // 12h de Brasília: 30 min após a abertura
  assert.ok(checklist({ calc: { ...calc, oposto: null }, mercado: 'acoes', agora: abertura }).some(([n, t]) => n === 'ok' && t.includes('janela das ações')));
  const feriado = checklist({ calc, mercado: 'acoes', agora: Date.parse('2026-11-26T15:00:00Z') });
  assert.ok(feriado.some(([, t]) => t.includes('Ação de Graças')));
  assert.equal(pregaoNY(Date.parse('2026-11-27T17:30:00Z')).meio, 'dia seguinte à Ação de Graças');
});

test('construir: formato da /api/liquidez vira [preço, US$] como na Liquidez ao vivo', () => {
  // preço 100, faixa ±10% em 4 colunas de 5: comprados nas 2 de baixo (92,5 e 97,5), vendidos nas 2 de cima (102,5 e 107,5)
  const d = construir({ p: 100, R: 10, nb: 4, L: [1, 0.5], S: [0.2, 2] });
  perto(d.bw, 5); assert.deepEqual(d.L.map(a => a[0]), [92.5, 97.5]); assert.deepEqual(d.S.map(a => a[0]), [102.5, 107.5]);
  assert.equal(d.L[0][1], 1e6);
  assert.equal(construir(null), null);
});

test('zonas pelo preço atual: comprar dentro da zona de apoio não empurra o stop para a zona seguinte', () => {
  // BTC: apoio 58.611–59.209, zona mais funda 57.415–58.013; venda 60.405–61.003; preço atual 59.842
  const d = { p: 59842, bw: 598, L: [[57714, 400e3], [58910, 19e6]], S: [[60704, 18e6], [62498, 9e6]] };
  // a Trava diz: comprar em 59.150 ou abaixo. Comprando em 59.150 com stop 58.520 → R:R ≈ 2 (passa)
  const it = checarMapa({ lado: 'compra', e: 59150, s: 58520, d, ref: 59842 });
  assert.ok(it.some(([n]) => n === 'ok'), JSON.stringify(it));
  assert.ok(!it.some(([n]) => n === 'bloqueia'));
  // no meio (59.842) continua bloqueado, com o mesmo preço da Trava
  const meio = checarMapa({ lado: 'compra', e: 59842, s: 58520, d, ref: 59842 });
  assert.ok(meio.some(([n, t]) => n === 'bloqueia' && t.includes('59.150')), JSON.stringify(meio));
});

test('zonas do mapa no 15 min: só valem se estiverem ao alcance do ATR; longe viram informação', () => {
  const d = { bw: 10, L: [[595, 500e3], [610, 20e3]], S: [[661, 120e3], [700, 30e3]] };
  // venda a 627 (R:R 0,67 pelo mapa): no 4H bloqueia; no 15 min com ATR de 0,3% as zonas estão a >6 ATR → só informa
  assert.ok(checarMapa({ lado: 'venda', e: 627, s: 672, d, tf: '4h', atr: 0.02 }).some(([n]) => n === 'bloqueia'));
  const curto = checarMapa({ lado: 'venda', e: 627, s: 672, d, tf: '15m', atr: 0.003 });
  assert.ok(!curto.some(([n]) => n === 'bloqueia' || n === 'aviso'));
  assert.ok(curto.some(([n, t]) => n === 'info' && t.includes('longe')));
  // no 15 min com ATR grande (zonas ao alcance) volta a bloquear
  assert.ok(checarMapa({ lado: 'venda', e: 627, s: 672, d, tf: '15m', atr: 0.02 }).some(([n]) => n === 'bloqueia'));
  // sem ATR do tempo gráfico ainda: não julga
  assert.deepEqual(checarMapa({ lado: 'venda', e: 627, s: 672, d, tf: '15m', atr: null }), []);
});

test('zonas no 15 min: a mensagem lista só a zona que está longe', () => {
  const d = { bw: 10, L: [[595, 500e3], [610, 20e3]], S: [[661, 120e3], [700, 30e3]] };
  // venda a 640: vendidos (stop) a 656–666 ≈ 2,5% (perto com ATR 1%); comprados (alvo) a 590–600 ≈ 6,3% (longe)
  const it = checarMapa({ lado: 'venda', e: 640, s: 650, d, tf: '15m', atr: 0.01 });
  const info = it.find(([n]) => n === 'info');
  assert.ok(info && info[1].includes('590') && !info[1].includes('656'));
});

test('checklist: estrutura (máxima/mínima recente) antes do alvo 1 bloqueia quando o espaço real é menor que o R:R mínimo', () => {
  const agora = Date.UTC(2026, 10, 24, 14, 0);   // 11h de Brasília, dentro da janela
  // compra a 353,9, stop 346,9 (R = 7), topo a 354,2 (0,04R), alvo 1 a 365,5 (1,66R)
  const calc = { rr: 2.25, risco: 5, notional: 235, custoStop: 0.001, cap: 1000, carrega: 0, e: 353.9, s: 346.9, side: 1, oposto: 354.2, alvos: [{ p: 365.5 }, { p: 376.8 }] };
  const it = checklist({ calc, agora });
  assert.ok(it.some(([n, t]) => n === 'bloqueia' && t.includes('Estrutura no caminho') && t.includes('só vale comprando em')));
  // XRP vendido: mínima a 1,1R antes do alvo 1 (1,66R) → bloqueia com rrMin 2
  const x = { ...calc, e: 0.9236, s: 0.9374, side: -1, oposto: 0.9084, alvos: [{ p: 0.8999 }] };
  assert.ok(checklist({ calc: x, agora }).some(([n, t]) => n === 'bloqueia' && t.includes('mínima recente')));
  // estrutura além do alvo 1: nada
  const livre = { ...calc, oposto: 380 };
  assert.ok(!checklist({ calc: livre, agora }).some(([, t]) => t.includes('Estrutura no caminho') || t.includes('antes do alvo 1')));
  // estrutura a 2,3R com alvo 1 a 3R e mínimo 2 → só aviso
  const media = { ...calc, oposto: 353.9 + 2.3 * 7, alvos: [{ p: 353.9 + 3 * 7 }] };
  const m = checklist({ calc: media, agora });
  assert.ok(m.some(([n, t]) => n === 'aviso' && t.includes('antes do alvo 1')) && !m.some(([n, t]) => n === 'bloqueia' && t.includes('Estrutura')));
});

test('checklist: uma entrada mínima só; sem entrada válida quando passa do stop; alvo 2 e stop largo avisam', () => {
  const agora = Date.UTC(2026, 10, 24, 14, 0);
  // SOL vendido: estrutura pede ≥ 70,28 (válido), mapa pede ≥ 71,78 (acima do stop 71,15) → nenhuma entrada válida
  const calc = { rr: 2.25, risco: 5, notional: 266, custoStop: 0.001, cap: 1000, carrega: 0, e: 69.94, s: 71.15, side: -1, oposto: 68.534, alvos: [{ p: 67.9 }, { p: 65.93 }] };
  const mapa = [['bloqueia', 'Pelo mapa...: só vale vendendo em 71,78 ou acima', { eMin: 71.78, ref: 67.05, stop: 74.15, base: 'Pelo mapa de liquidações, R:R 0,7, abaixo do seu mínimo.' }]];
  const it = checklist({ calc, agora, extras: mapa });
  const bl = it.filter(([n]) => n === 'bloqueia');
  assert.ok(bl.some(([, t]) => t.includes('Plano de espera') && t.includes('72,278') && t.includes('74,15')));   // stop além da zona; entrada que passa nas duas
  assert.ok(!bl.some(([, t]) => t.includes('só vale')));
  // mapa menos restritivo que o stop: uma linha de entrada mínima, a maior (venda) entre as duas
  const ok = checklist({ calc: { ...calc, s: 74 }, agora, extras: mapa }).filter(([n]) => n === 'bloqueia');
  assert.ok(ok.some(([, t]) => t.includes('Espere um repique até 72,178')));
  // alvo 2 além de 8 ATR e stop largo com posição pequena
  const nvda = { ...calc, e: 154.29, s: 172.89, side: -1, oposto: 124.71, alvos: [{ p: 125.9 }, { p: 97.66 }], atr: 0.037, stopATR: 3.3, notional: 41, cap: 1000 };
  const n = checklist({ calc: nvda, agora });
  assert.ok(n.some(([k, t]) => k === 'aviso' && t.startsWith('Alvo 2') && t.includes('passa da mínima')));
  assert.ok(n.some(([k, t]) => k === 'aviso' && t.includes('Stop largo') && t.includes('swing')));
});
