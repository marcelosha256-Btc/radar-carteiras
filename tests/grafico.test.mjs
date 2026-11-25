import test from 'node:test';
import assert from 'node:assert/strict';
import { graficoSvg } from '../web/grafico/desenho.js';
import { grupos, niveisDia, niveisPeriodo, pivos, rotular, estrutura, leitura, atrAbs, diaUTC, nyHora } from '../web/grafico/calc.js';

const M15 = 9e5;
const vela = (t, o, h, l, c, v = 10) => ({ t, o, h, l, c, v });

test('cripto: grupos por dia UTC e níveis (ontem, abertura, VWAP, máx/mín)', () => {
  const d0 = Date.UTC(2026, 10, 24), d1 = Date.UTC(2026, 10, 25);   // 24/11 e 25/11 00:00 UTC
  const c = [vela(d0, 100, 110, 95, 105), vela(d0 + M15, 105, 120, 100, 118), vela(d1, 118, 119, 112, 114, 10), vela(d1 + M15, 114, 117, 113, 116, 30)];
  const g = grupos(c, 'cripto'); assert.equal(g.length, 2); assert.equal(g[0].h, 120); assert.equal(g[0].l, 95);
  const n = niveisDia(c, 'cripto', d1 + 2 * M15), por = Object.fromEntries(n.niveis.map(x => [x.id, x.preco]));
  assert.equal(por.PDH, 120); assert.equal(por.PDL, 95); assert.equal(por.PDC, 118); assert.equal(por.AB, 118);
  assert.equal(por.MXD, 119); assert.equal(por.MND, 112);
  // VWAP = (tp1*10 + tp2*30) / 40 ; tp1 = (119+112+114)/3 = 115 ; tp2 = (117+113+116)/3 = 115,333…
  assert.ok(Math.abs(por.VWAP - (115 * 10 + (346 / 3) * 30) / 40) < 1e-9);
});

test('ações: só conta o pregão de NY; fechado vira "ontem"', () => {
  // 24/11/2026 (terça): NY está em EST (UTC-5): 9:30 NY = 14:30 UTC
  const ab = Date.UTC(2026, 10, 24, 14, 30);
  const c = [vela(ab - 2 * M15, 50, 51, 49, 50), vela(ab, 100, 104, 99, 103), vela(ab + M15, 103, 108, 102, 107), vela(Date.UTC(2026, 10, 24, 21, 15), 107, 108, 106, 107.5)];  // 16:15 NY: fora do pregão
  const g = grupos(c, 'acoes'); assert.equal(g.length, 1); assert.equal(g[0].h, 108); assert.equal(g[0].l, 99);   // pré-mercado e pós-mercado ficam de fora
  const fechado = niveisDia(c, 'acoes', Date.UTC(2026, 10, 24, 23, 0)), ids = fechado.niveis.map(x => x.id);
  assert.ok(ids.includes('PDH') && !ids.includes('VWAP'));
  const aberto = niveisDia(c, 'acoes', ab + 2 * M15), por = Object.fromEntries(aberto.niveis.map(x => [x.id, x.preco]));
  assert.equal(por.AB, 100); assert.ok(por.VWAP > 100 && por.VWAP < 108); assert.ok(!('PDH' in por));   // sem sessão anterior nos dados
});

test('nyHora: horário de verão e inverno', () => {
  assert.equal(nyHora(Date.UTC(2026, 6, 1, 13, 30)).min, 9 * 60 + 30);    // julho: EDT (UTC-4)
  assert.equal(nyHora(Date.UTC(2026, 10, 24, 14, 30)).min, 9 * 60 + 30);  // novembro: EST (UTC-5)
  assert.equal(nyHora(Date.UTC(2026, 10, 27, 15, 0)).util, true);   // sexta
  assert.equal(nyHora(Date.UTC(2026, 10, 28, 15, 0)).util, false);  // sábado
});

// série em zigue-zague de alta: topos e fundos cada vez mais altos
function zigue(precos, t0 = 0) {
  const c = []; let ant = precos[0];
  precos.forEach((p, i) => { c.push(vela(t0 + i * M15, ant, Math.max(ant, p) + 0.2, Math.min(ant, p) - 0.2, p)); ant = p; });
  return c;
}

test('pivôs e rótulos: alta = HH + HL', () => {
  const c = zigue([10, 12, 14, 12, 11, 13, 16, 14, 12.5, 15, 18, 16, 15, 17, 19]);
  const pv = rotular(pivos(c, 2)), r = pv.map(x => x.r);
  assert.ok(r.includes('HH') && r.includes('HL')); assert.ok(!r.includes('LL'));
  assert.equal(estrutura(c).tendencia, 'alta');
});

test('estrutura de baixa: LH + LL', () => {
  const c = zigue([20, 18, 16, 18, 19, 17, 14, 16, 17.5, 15, 12, 14, 15, 13, 11]);
  assert.equal(estrutura(c).tendencia, 'baixa');
});

test('rompimento de topo (BOS) e reteste confirmado', () => {
  // alta, rompe o topo 16 com fechamento acima, volta até o nível (reteste) e segue
  const c = zigue([10, 12, 14, 12, 11, 13, 16, 14, 12.5, 15, 18, 16.1, 17, 19, 21, 22]);
  const e = estrutura(c);
  assert.equal(e.tendencia, 'alta'); assert.ok(e.quebra, 'achou quebra'); assert.equal(e.quebra.sobe, true);
  assert.equal(e.quebra.tipo, 'BOS');
});

test('mudança de caráter (CHoCH): em baixa, rompe topo para cima', () => {
  const c = zigue([20, 18, 16, 18, 19, 17, 14, 16, 17.5, 15, 12, 14, 15, 13, 11, 14, 17, 20, 22]);
  const e = estrutura(c);
  assert.ok(e.quebra && e.quebra.sobe === true); assert.equal(e.quebra.tipo, 'CHoCH');
});

test('rompimento falso: fecha abaixo do nível depois de romper', () => {
  const c = zigue([10, 12, 14, 12, 11, 13, 16, 14, 12.5, 15, 18, 14, 12, 11]);
  const e = estrutura(c);
  assert.ok(e.quebra); assert.ok(['falhou', 'aguardando', 'em curso'].includes(e.reteste.estado));
});

test('leitura em português', () => {
  const niv = { niveis: [{ id: 'VWAP', rot: 'VWAP', preco: 100 }, { id: 'AB', rot: 'abertura do dia', preco: 98 }, { id: 'PDH', rot: 'máx. ontem', preco: 105 }, { id: 'PDL', rot: 'mín. ontem', preco: 90 }] };
  const est = { tendencia: 'alta', quebra: { tipo: 'BOS', sobe: true, nivel: 101 }, reteste: { estado: 'em curso' } };
  const t = leitura(est, niv, 103, v => String(v));
  assert.match(t, /acima da VWAP/); assert.match(t, /dentro da faixa de ontem/); assert.match(t, /Estrutura de alta/); assert.match(t, /reteste em curso/);
  assert.equal(leitura(null, { niveis: [] }, 1), '');
});

test('atrAbs: precisa de histórico', () => {
  assert.equal(atrAbs([vela(0, 1, 2, 1, 2)]), null);
  assert.ok(atrAbs(Array.from({ length: 20 }, (_, i) => vela(i, 10, 11, 9, 10))) === 2);
});

// série exata: topo em 16 (pivô), rompimento fechando 17, e depois três finais diferentes
function base() {
  const c = zigue([10, 12, 14, 12, 11, 13, 16, 14, 12.5, 15, 17.5]);
  return c;
}
const prox = (c, ...ps) => { let t = c[c.length - 1].t, ant = c[c.length - 1].c; for (const p of ps) { t += M15; c.push(vela(t, ant, Math.max(ant, p) + 0.1, Math.min(ant, p) - 0.1, p)); ant = p; } return c; };

test('reteste: aguardando, em curso, confirmado e falhou', () => {
  const nivel = estrutura(base()).quebra && estrutura(base()).quebra.nivel;
  assert.ok(nivel > 15 && nivel < 17, 'nível rompido é o topo de ~16: ' + nivel);
  assert.equal(estrutura(prox(base(), 18, 19)).reteste.estado, 'aguardando');                          // não voltou ao nível
  assert.equal(estrutura(prox(base(), 18, 16.3, 16.4)).reteste.estado, 'em curso');                    // voltou ao nível e segura
  assert.equal(estrutura(prox(base(), 18, 16.3, 19.5, 20)).reteste.estado, 'confirmado');             // voltou e subiu >0,5 ATR
  assert.equal(estrutura(prox(base(), 18, 16.3, 14.5)).reteste.estado, 'falhou');                     // fechou abaixo do nível
});

test('leitura: primeira letra maiúscula mesmo sem VWAP', () => {
  const niv = { niveis: [{ id: 'PDH', rot: 'máx. ontem', preco: 105 }, { id: 'PDL', rot: 'mín. ontem', preco: 90 }] };
  assert.match(leitura(null, niv, 100), /^Dentro da faixa de ontem\./);
});

test('níveis da semana e do mês passados (velas diárias)', () => {
  const D = 864e5, dia = (y, m, d) => Date.UTC(y, m, d), v = (t, h, l) => ({ t, o: l, h, l, c: h, v: 1 });
  // semana de seg 16/11 a dom 22/11/2026; hoje é qui 26/11 (semana atual: 23/11 em diante); mês passado = outubro
  const c = [v(dia(2026, 9, 10), 200, 150), v(dia(2026, 10, 16), 130, 110), v(dia(2026, 10, 18), 140, 105), v(dia(2026, 10, 22), 125, 100), v(dia(2026, 10, 24), 160, 120)];
  const n = Object.fromEntries(niveisPeriodo(c, dia(2026, 10, 26) + 3600e3).map(x => [x.id, x.preco]));
  assert.equal(n.PWH, 140); assert.equal(n.PWL, 100);   // 16 a 22/11
  assert.equal(n.PMH, 200); assert.equal(n.PML, 150);   // outubro
  assert.deepEqual(niveisPeriodo([]), []);
});

test('gráfico: bolhas de liquidação e perfil da liquidez em risco', () => {
  const c = Array.from({ length: 30 }, (_, i) => vela(i * M15, 100, 102, 98, 101));
  const perfil = { bw: 1, L: [[99.5, 2e6, 4e6], [97.5, 1e6, 1e6]], S: [[101.5, 3e6, null], [150, 9e6, null]], hora: '12:00' };
  const bolhas = [{ t: 5 * M15 + 1000, px: 99, usd: 50000, side: 'long' }, { t: 6 * M15, px: 101, usd: 5000, side: 'short' }, { t: -M15, px: 100, usd: 1e6, side: 'long' }];
  const { svg } = graficoSvg({ candles: c, niv: null, est: null, preco: 100.5, ms: M15, perfil, bolhas });
  assert.equal((svg.match(/<circle/g) || []).length, 2);              // a bolha anterior às velas fica de fora
  assert.match(svg, /Longs liquidados · US\$ 50\.000 em 1 evento \(0 com preço e lado exatos\)/);
  assert.match(svg, /liquidez em risco · foto 12:00/);
  assert.equal((svg.match(/stroke-dasharray:2 2/g) || []).length, 1);  // contorno só onde a faixa mudou (99,5: 4 mi → 2 mi)
  assert.ok(!graficoSvg({ candles: c, ms: M15 }).svg.includes('liquidez em risco'));
});
