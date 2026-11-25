// Medição em tempos maiores (1 h, 4 h, diário): BTC, ETH, SOL (Binance spot). Mesmo método do medir.mjs:
// entrada na abertura da vela seguinte ao sinal, uma operação por vez, stop/alvo em ATR(14), empate conta stop,
// custo 0,10% ida e volta, comparação com entrar sem sinal do mesmo lado, metades do período.
// Uso: node medir_tf.mjs 1h | 4h | 1d
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estrutura } from '../../web/grafico/calc.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TF = process.argv[2] || '1h';
const MS = { '1h': 36e5, '4h': 144e5, '1d': 864e5 }[TF];
const ACOES = process.argv[3] === 'acoes';   // node medir_tf.mjs 1d acoes  -> ações dos EUA (Yahoo), diário
const ATIVOS = ACOES ? ['SPY','QQQ','AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','JPM','V','JNJ','WMT','XOM','PG','HD','KO','PEP','COST','AVGO','NFLX','AMD','ORCL','BAC','CVX','MRK','ABBV','CSCO','ADBE','CRM'] : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], CUSTO = 0.001;
const INICIO = ACOES ? Date.UTC(2011, 0, 1) : Date.UTC(2020, 8, 1);   // SOL só existe na Binance desde 08/2020
const CONF = { '1h': [['A) stop 1 ATR, alvo 1,5, até 48 h', 1, 1.5, 48], ['B) stop 2 ATR, alvo 3, até 96 h', 2, 3, 96]],
  '4h': [['A) stop 1 ATR, alvo 1,5, até 8 dias', 1, 1.5, 48], ['B) stop 2 ATR, alvo 3, até 20 dias', 2, 3, 120]],
  '1d': [['A) stop 1 ATR, alvo 1,5, até 20 dias', 1, 1.5, 20], ['B) stop 2 ATR, alvo 3, até 60 dias', 2, 3, 60]] }[TF];
let STOP = 1, ALVO = 1.5, MAXB = 24;

async function baixarYahoo(sim) {
  const f = `${DIR}/${TF}_acao_${sim}.json`;
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const j = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sim}?range=15y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
  const r = j.chart.result[0], q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((t, i) => { if (q.close[i] != null && q.open[i] != null) out.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
  const v = out.filter(x => x.t >= INICIO && x.t + 864e5 <= Date.now()); fs.writeFileSync(f, JSON.stringify(v)); return v;
}
async function baixar(sim) {
  if (ACOES) return baixarYahoo(sim);
  const f = `${DIR}/${TF}_${sim}.json`;
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const out = []; let t = INICIO;
  for (;;) {
    const r = await (await fetch(`https://api.binance.com/api/v3/klines?symbol=${sim}&interval=${TF}&startTime=${t}&limit=1000`)).json();
    if (!Array.isArray(r) || !r.length) break;
    r.forEach(k => out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    if (r.length < 1000) break; t = r[r.length - 1][0] + 1;
  }
  const v = out.filter(x => x.t + MS <= Date.now());
  fs.writeFileSync(f, JSON.stringify(v)); return v;
}
function atrSerie(c) {
  const tr = c.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)) : x.h - x.l), a = Array(c.length).fill(null);
  let s = 0; for (let i = 0; i < c.length; i++) { s += tr[i]; if (i >= 14) s -= tr[i - 14]; if (i >= 13) a[i] = s / 14; }
  return a;
}
function simular(c, i, dir, atr) {
  const e = c[i + 1].o, R = atr * STOP, stop = e - dir * R, alvo = e + dir * ALVO * R, cr = CUSTO * e / R;
  for (let j = i + 1; j <= Math.min(c.length - 1, i + MAXB); j++) {
    const hitS = dir > 0 ? c[j].l <= stop : c[j].h >= stop, hitA = dir > 0 ? c[j].h >= alvo : c[j].l <= alvo;
    if (hitS) return { r: -1 - cr, fim: j };
    if (hitA) return { r: ALVO / STOP - cr, fim: j };
  }
  const fim = Math.min(c.length - 1, i + MAXB); return { r: dir * (c[fim].c - e) / R - cr, fim };
}
// período anterior: dia UTC (1 h), semana (segunda 00:00 UTC) para 4 h e 1 d, mês para 1 d
const diaK = t => Math.floor(t / 864e5), semK = t => Math.floor((t - 4 * 864e5) / (7 * 864e5)), mesK = t => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const PERIODOS = { '1h': [['ontem', diaK]], '4h': [['semana passada', semK], ['ontem', diaK]], '1d': [['semana passada', semK], ['mês passado', mesK]] }[TF];

function sinais(c) {
  const out = [], atr = atrSerie(c), per = PERIODOS.map(([nome, k]) => ({ nome, k, chave: null, mx: -Infinity, mn: Infinity, ph: null, pl: null, rH: false, rL: false }));
  const visto = new Set();
  for (let i = 0; i < c.length - 1; i++) {
    for (const p of per) {
      const k = p.k(c[i].t);
      if (k !== p.chave) { if (p.chave !== null) { p.ph = p.mx; p.pl = p.mn; } p.chave = k; p.mx = -Infinity; p.mn = Infinity; p.rH = false; p.rL = false; }
      p.mx = Math.max(p.mx, c[i].h); p.mn = Math.min(p.mn, c[i].l);
    }
    if (i < 250 || atr[i] == null) continue;
    const px = c[i].c, push = (dir, sig) => out.push({ i, dir, sig });
    for (const p of per) {
      if (p.ph == null) continue;
      if (!p.rH && px > p.ph) { p.rH = true; push(1, `Rompeu máx. da ${p.nome} (fechou acima)`); }
      if (!p.rL && px < p.pl) { p.rL = true; push(-1, `Rompeu mín. da ${p.nome} (fechou abaixo)`); }
      if (c[i].h > p.ph && px < p.ph && c[i - 1].c <= p.ph * 1.0005 && !p.rH) push(-1, `Varreu máx. da ${p.nome} e voltou (vende)`);
      if (c[i].l < p.pl && px > p.pl && c[i - 1].c >= p.pl * 0.9995 && !p.rL) push(1, `Varreu mín. da ${p.nome} e voltou (compra)`);
    }
    const jan = c.slice(i - 199, i + 1), e = estrutura(jan), q = e.quebra;
    if (q && q.j === jan.length - 1) push(q.sobe ? 1 : -1, `${q.tipo} ${q.sobe ? 'p/ cima' : 'p/ baixo'}`);
    if (q && e.reteste && e.reteste.estado === 'confirmado') {
      const chave = q.t + '|' + q.nivel;
      if (!visto.has(chave)) { visto.add(chave); push(q.sobe ? 1 : -1, `Reteste confirmado depois de ${q.tipo} ${q.sobe ? 'p/ cima' : 'p/ baixo'}`); }
    }
    // tendência de alta/baixa + toque no fundo/topo anterior (continuação) — só pela estrutura
    if (e.tendencia !== 'indefinida' && e.ultimoFundo && e.ultimoTopo) {
      const tx = e.tendencia, k = tx + '|' + (tx === 'alta' ? e.ultimoFundo.t : e.ultimoTopo.t);
      if (!visto.has(k)) { visto.add(k); push(tx === 'alta' ? 1 : -1, `Estrutura nova de ${tx} (entra a favor)`); }
    }
  }
  return { out, atr };
}
function operar(c, atr, lista) {
  const rs = []; let livre = 0;
  for (const s of lista) { if (s.i < livre) continue; const r = simular(c, s.i, s.dir, atr[s.i]); rs.push({ r: r.r, i: s.i, t: c[s.i].t, cr: CUSTO * c[s.i + 1].o / (atr[s.i] * STOP) }); livre = r.fim + 1; }
  return rs;
}
const stat = rs => { const n = rs.length; if (!n) return { n: 0, m: 0, se: 0 }; const m = rs.reduce((t, x) => t + x.r, 0) / n, w = rs.filter(x => x.r > 0).length / n;
  const sd = Math.sqrt(rs.reduce((t, x) => t + (x.r - m) ** 2, 0) / Math.max(1, n - 1)); return { n, m, w, se: sd / Math.sqrt(n) }; };
const f2 = v => (v >= 0 ? '+' : '') + v.toFixed(3);

const dados = {}; for (const a of ATIVOS) dados[a] = await baixar(a);
console.log(`TEMPO GRÁFICO ${TF} · velas:`, Object.fromEntries(Object.entries(dados).map(([k, v]) => [k.replace('USDT', ''), v.length + ' (' + new Date(v[0].t).toISOString().slice(0, 10) + ' a ' + new Date(v[v.length - 1].t).toISOString().slice(0, 10) + ')'])));
const meio = (INICIO + Date.now()) / 2, pre = {};
for (const a of ATIVOS) { const c = dados[a], { out, atr } = sinais(c); pre[a] = { c, out, atr }; }
const curta = sig => /p\/ baixo|abaixo|vende|de baixa/.test(sig) ? -1 : 1;
function rodar(rot, stop, alvo, maxb) {
  STOP = stop; ALVO = alvo; MAXB = maxb;
  const base = { 1: [], '-1': [] }, todos = {};
  for (const a of ATIVOS) {
    const { c, out, atr } = pre[a];
    for (const dir of [1, -1]) { const l = []; for (let i = 300; i < c.length - maxb - 8; i += 8) if (atr[i]) l.push({ i, dir }); base[dir].push(...operar(c, atr, l)); }
    const por = {}; out.forEach(x => (por[x.sig] || (por[x.sig] = [])).push(x));
    for (const [sig, l] of Object.entries(por)) (todos[sig] || (todos[sig] = [])).push(...operar(c, atr, l).map(x => ({ ...x, a })));
  }
  const B = { 1: stat(base[1]), '-1': stat(base[-1]) }, cm = base[1].reduce((t, x) => t + x.cr, 0) / base[1].length;
  console.log(`\n=== ${TF} ${rot} · custo ${CUSTO * 100}% ida e volta (≈ ${cm.toFixed(3)}R por operação) ===`);
  console.log(`base sem sinal: compra n=${B[1].n} líq. ${f2(B[1].m)}R · venda n=${B[-1].n} líq. ${f2(B[-1].m)}R`);
  console.log('SINAL'.padEnd(54), 'n'.padStart(5), 'acerto'.padStart(7), 'líq.R'.padStart(7), 'vs base'.padStart(8), 't'.padStart(5), '| 1ªmet'.padEnd(9), '2ªmet'.padEnd(9), '| por ativo (líq.R)');
  const L = [];
  for (const [sig, all] of Object.entries(todos)) {
    const s2 = stat(all); if (s2.n < 40) continue; const d = curta(sig), b = B[d], diff = s2.m - b.m, t = diff / Math.sqrt(s2.se ** 2 + b.se ** 2 || 1);
    const half = f => { const x = stat(all.filter(f)), y = stat(base[d].filter(f)); return x.n ? x.m - y.m : 0; };
    const pa = (ACOES ? [] : ATIVOS).map(a => { const x = stat(all.filter(z => z.a === a)); return `${a.slice(0, 3)} ${x.n ? f2(x.m) : '—'}(${x.n})`; }).join(' ');
    L.push({ sig, n: s2.n, w: s2.w, m: s2.m, diff, t, h1: half(x => x.t < meio), h2: half(x => x.t >= meio), pa });
  }
  L.sort((x, y) => y.diff - x.diff);
  for (const x of L) console.log(x.sig.padEnd(54), String(x.n).padStart(5), `${(x.w * 100).toFixed(0)}%`.padStart(7), f2(x.m).padStart(7), f2(x.diff).padStart(8), x.t.toFixed(1).padStart(5), '|', f2(x.h1).padEnd(8), f2(x.h2).padEnd(8), '|', x.pa);
}
for (const [r, s, a, m] of CONF) rodar(r, s, a, m);
