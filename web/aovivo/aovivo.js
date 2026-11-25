/* Aba "Liquidez ao vivo" do Radar (Cripto e Ações).
 * Mapa de liquidações da Coinversa (via /api/liquidez, com a senha do radar), preço/livro/candles direto da Hyperliquid.
 * Chance de tocar = método do coletor/chance.py (excursão das próximas 4 h/24 h ÷ amplitude média das 24 velas de 1 h
 * anteriores, 5.000 velas da Hyperliquid), calculada aqui no navegador para qualquer ativo, com conferência 70/30.
 * Fora de propósito: "qual lado é capturado primeiro" e "escada/cascata" — testados no radar em 11/11/2026 e rejeitados. */
import { fraseRsi, rsiSerie, regime as regimeRsi, rsiWilder, agrupar, faixa as faixaRsi, resumo as resumoRsi, precoParaRsi } from '../rsi/calc.js';
import { medo, frase as fraseMedo } from '../contexto/medo.js';
import { vix, fraseVix } from '../contexto/vix.js';
import { niveisDia, niveisPeriodo, estrutura as estruturaVelas, leitura as leituraGrafico, zonasSR } from '../grafico/calc.js';
import { graficoSvg } from '../grafico/desenho.js';
const HL = 'https://api.hyperliquid.xyz/info';
const ATIVOS = { cripto: ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'NEAR'],
  acoes: ['xyz:SP500', 'xyz:XYZ100', 'xyz:NVDA', 'xyz:TSLA', 'xyz:MU', 'xyz:SKHX', 'xyz:GOOGL', 'xyz:GOLD'] };
const ROTEIRO = {               // regras do roteiro do Marcelo (ajuste aqui)
  rrMin: 2,                     // R:R mínimo: abaixo disso, BLOQUEADO
  stopBuf: 0.0015,              // stop 0,15% além da zona de liquidação mais próxima
  // as regras do Connors RSI (veto de venda no swing, ETH sem edge, bônus de RSI diário em sobrevenda) saíram em 25/11/2026:
  // o estudo do CRSI não achou vantagem clara contra entrar em qualquer dia do mesmo regime
  liberado: 70, cuidado: 50,
};
const TF = [['Semana', '1w', 7 * 864e5], ['Dia', '1d', 864e5], ['4H', '4h', 144e5], ['15 min', '15m', 9e5]];
const TIER = [['money_printer', 'Top lucro (Apex)'], ['smart_money', 'Lucrativos (Sharps)'], ['grinder', 'Consistentes'], ['humble_earner', 'Pequeno lucro'],
  ['exit_liquidity', 'Multidão'], ['semi_rekt', 'Perdendo'], ['full_rekt', 'Muito no prejuízo'], ['giga_rekt', 'Quebrados']];

/* ---------- formatação ---------- */
const nome = k => k.replace('xyz:', '');
const fm = n => n >= 995000 ? 'US$ ' + (n / 1e6).toFixed(1).replace('.', ',') + ' mi' : 'US$ ' + Math.round(n / 1e3) + ' mil';
const fB = n => Math.abs(n) >= 1e9 ? 'US$ ' + (Math.abs(n) / 1e9).toFixed(2).replace('.', ',') + ' bi' : fm(Math.abs(n));
const sgn = n => (n < 0 ? '-' : '+') + fB(n);
const fpx = n => n >= 1000 ? n.toLocaleString('pt-BR', { maximumFractionDigits: n >= 10000 ? 0 : 1 }) : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 });
const pc = v => (v > 0 ? '+' : '') + v.toFixed(1).replace('.', ',') + '%';
const pc2 = v => (v > 0 ? '+' : '') + v.toFixed(2).replace('.', ',') + '%';
const pp = v => v == null ? '…' : (v < 0.01 ? '<1%' : v > 0.99 ? '>99%' : Math.round(v * 100) + '%');
const f1 = v => v.toFixed(1).replace('.', ',');
const ago = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? 'há ' + s + 's' : 'há ' + Math.round(s / 60) + ' min'; };
const V = n => `var(--${n})`;
const COR = { up: V('up'), dn: V('down'), long: V('lv-long'), short: V('lv-short'), am: V('warn'), mu: V('muted'), fg: V('fg') };

const hlApi = b => fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const senha = () => { try { return localStorage.getItem('radar-senha') || ''; } catch (e) { return ''; } };
async function meuApi(q, coin) {
  if (!senha()) throw new Error('senha');   // sem senha salva não chama a API: evita o 401 no console na primeira visita
  const r = await fetch(`api/liquidez?q=${q}&coin=${encodeURIComponent(coin)}`, { headers: { 'x-senha': senha() } });
  if (r.status === 401) throw new Error('senha');
  const j = await r.json();
  if (!r.ok) throw new Error(j.erro || ('erro ' + r.status));
  return j;
}

/* ---------- estado compartilhado (preços de todos os ativos) ---------- */
const live = {}, hist = {}, flash = {};
let lastMsg = 0;
function apply(mids) {
  const now = Date.now();
  for (const k in mids) {
    const v = +mids[k], old = live[k];
    if (!isFinite(v)) continue;
    if (old != null && v !== old) flash[k] = { col: v > old ? COR.up : COR.dn, until: now + 700 };
    live[k] = v;
    const H = hist[k] || (hist[k] = []);
    if (!H.length || v !== H[H.length - 1][1] || now - H[H.length - 1][0] > 5000) H.push([now, v]);
    while (H.length && H[0][0] < now - 3700e3) H.shift();
  }
  lastMsg = now;
}
async function poll() {
  try { const [a, b] = await Promise.all([hlApi({ type: 'allMids' }), hlApi({ type: 'allMids', dex: 'xyz' })]); apply(Object.assign({}, a, b)); } catch (e) {}
}
function priceAt(k, t) { const H = hist[k] || []; let v = null; for (const [ts, p] of H) { if (ts <= t) v = p; else break; } return v != null ? v : (H[0] ? H[0][1] : null); }

/* ---------- tendência curta ---------- */
function trend(k, cur) {
  const H = hist[k] || [], now = Date.now();
  const at = ms => { let v = null; for (const [t, p] of H) { if (t <= now - ms) v = p; else break; } return v != null ? v : (H[0] ? H[0][1] : cur); };
  const c1 = (cur / at(60e3) - 1) * 100, c5 = (cur / at(300e3) - 1) * 100, c15 = (cur / at(900e3) - 1) * 100, thr = 0.05;
  let label, color, arrow;
  if (c5 > thr && c1 >= -thr / 2) { label = c5 > 3 * thr ? 'Alta forte' : 'Alta'; arrow = c5 > 3 * thr ? '▲▲' : '▲'; color = COR.up; }
  else if (c5 < -thr && c1 <= thr / 2) { label = c5 < -3 * thr ? 'Baixa forte' : 'Baixa'; arrow = c5 < -3 * thr ? '▼▼' : '▼'; color = COR.dn; }
  else if (c5 > thr) { label = 'Alta perdendo força'; arrow = '↘'; color = COR.am; }
  else if (c5 < -thr) { label = 'Baixa perdendo força'; arrow = '↗'; color = COR.am; }
  else { label = 'Lateral'; arrow = '◆'; color = COR.mu; }
  const dir = Math.abs(c1) > 0.01 ? Math.sign(c1) : (Math.abs(c5) > 0.02 ? Math.sign(c5) : 0);
  return { c1, c5, c15, label, color, arrow, dir };
}

/* ---------- chance de tocar (mesmo método do coletor/chance.py) ---------- */
const chance = {};   // k -> {vol, q: {'4':{up,dn}, '24':{up,dn}}, conf, n}
function quantis(arr) { const s = [...arr].sort((a, b) => a - b), q = []; for (let i = 0; i <= 100; i++) q.push(s[Math.min(s.length - 1, Math.round(i / 100 * (s.length - 1)))]); return q; }
function probToque(qs, x) { if (x <= 0) return 1; let lo = 0, hi = qs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (qs[m] < x) lo = m + 1; else hi = m; } return Math.max(0, Math.min(1, 1 - lo / (qs.length - 1))); }
async function carregarChance(k) {
  if (chance[k] && Date.now() - chance[k].t < 6 * 3600e3) return;
  const now = Date.now();
  const c = (await hlApi({ type: 'candleSnapshot', req: { coin: k, interval: '1h', startTime: now - 5000 * 3600e3, endTime: now } }))
    .map(x => ({ h: +x.h, l: +x.l, c: +x.c }));
  if (c.length < 400) { chance[k] = { t: now, erro: 'pouco histórico' }; return; }
  const amp = c.map(x => (x.h - x.l) / x.c), pts = [];
  for (let i = 24; i < c.length; i++) {
    let s = 0; for (let j = i - 24; j < i; j++) s += amp[j];
    const vol = s / 24; if (!(vol > 0)) continue;
    const ex = H => { if (i + H >= c.length) return null; let mx = -Infinity, mn = Infinity; for (let j = i + 1; j <= i + H; j++) { mx = Math.max(mx, c[j].h); mn = Math.min(mn, c[j].l); } return { up: (mx / c[i].c - 1) / vol, dn: (1 - mn / c[i].c) / vol }; };
    pts.push({ e4: ex(4), e24: ex(24) });
  }
  const build = P => ({ '4': { up: quantis(P.filter(p => p.e4).map(p => p.e4.up)), dn: quantis(P.filter(p => p.e4).map(p => p.e4.dn)) },
    '24': { up: quantis(P.filter(p => p.e24).map(p => p.e24.up)), dn: quantis(P.filter(p => p.e24).map(p => p.e24.dn)) } });
  // conferência fora da amostra: quantis com os 70% iniciais, medido nos 30% finais (24 h, os dois lados)
  const cut = Math.floor(pts.length * 0.7), qa = build(pts.slice(0, cut)), teste = pts.slice(cut).filter(p => p.e24);
  const conf = [0.25, 0.5, 0.75].map(alvo => {
    let x = 0, n = 0, hit = 0;
    const qs = qa['24'].up; x = qs[Math.round((1 - alvo) * 100)];
    for (const p of teste) { n += 2; if (p.e24.up >= x) hit++; if (p.e24.dn >= qa['24'].dn[Math.round((1 - alvo) * 100)]) hit++; }
    return { prevista: alvo, tocou: n ? hit / n : null };
  });
  let s = 0; for (let j = amp.length - 24; j < amp.length; j++) s += amp[j];
  chance[k] = { t: now, vol: s / 24, q: build(pts), conf, n: pts.length };
}
function pTouch(k, level, cur, h) {
  const C = chance[k]; if (!C || !C.q) return null;
  const up = level > cur, d = Math.abs(level / cur - 1);
  return probToque(C.q[String(h)][up ? 'up' : 'dn'], d / C.vol);
}

/* ---------- RSI 14 (Wilder) ao vivo ---------- */
const cand = {};
function rsiCalc(cl) {
  if (cl.length < 16) return null;
  let g = 0, l = 0; for (let q = 1; q <= 14; q++) { const ch = cl[q] - cl[q - 1]; if (ch > 0) g += ch; else l -= ch; }
  g /= 14; l /= 14; const out = [], r = () => l === 0 ? 100 : 100 - 100 / (1 + g / l); out.push(r());
  for (let q = 15; q < cl.length; q++) { const ch = cl[q] - cl[q - 1]; g = (g * 13 + Math.max(ch, 0)) / 14; l = (l * 13 + Math.max(-ch, 0)) / 14; out.push(r()); }
  return out;
}
function rsiAt(k, tf, ms, price) {
  const a = cand[k] && cand[k][tf]; if (!a || a.length < 16) return null;
  const cl = a.map(x => x.c), last = a[a.length - 1];
  if (last.t + ms > Date.now()) cl[cl.length - 1] = price; else cl.push(price);
  const r = rsiCalc(cl); return r ? { v: r[r.length - 1], prev: r[r.length - 2] } : null;
}
const rsiCol = v => v <= 30 ? COR.am : v >= 70 ? COR.dn : COR.fg;
async function carregarCandles(k, tfs) {
  const now = Date.now();
  for (const [, tf, ms] of TF) {
    if (!tfs.includes(tf)) continue;
    try { const c = await hlApi({ type: 'candleSnapshot', req: { coin: k, interval: tf, startTime: now - 110 * ms, endTime: now } });
      (cand[k] || (cand[k] = {}))[tf] = c.map(x => ({ t: x.t, c: +x.c, h: +x.h, l: +x.l })); } catch (e) {}
  }
}
/* velas completas (com abertura e volume) para o gráfico de níveis e estrutura: 15 min (~4 dias) e 1 h (~14 dias) */
const graf = {};
async function carregarGrafico(k) {
  const now = Date.now(), conv = c => c.map(x => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v }));
  try {
    const [a, b, d4, d1] = await Promise.all([
      hlApi({ type: 'candleSnapshot', req: { coin: k, interval: '15m', startTime: now - 4 * 864e5, endTime: now } }),
      hlApi({ type: 'candleSnapshot', req: { coin: k, interval: '1h', startTime: now - 14 * 864e5, endTime: now } }),
      hlApi({ type: 'candleSnapshot', req: { coin: k, interval: '4h', startTime: now - 70 * 864e5, endTime: now } }),
      hlApi({ type: 'candleSnapshot', req: { coin: k, interval: '1d', startTime: now - 400 * 864e5, endTime: now } })]);
    graf[k] = { t: now, c15: conv(a), c1h: conv(b), c4h: conv(d4), c1d: conv(d1) };
  } catch (e) {}
}
async function carregarMinuto(k) {
  const now = Date.now();
  try { const c = await hlApi({ type: 'candleSnapshot', req: { coin: k, interval: '1m', startTime: now - 3700e3, endTime: now } });
    const pts = c.map(x => [Math.min(x.T, now - 1000), +x.c]), last = pts.length ? pts[pts.length - 1][0] : 0;
    hist[k] = pts.concat((hist[k] || []).filter(a => a[0] > last)); } catch (e) {}
}

/* ---------- livro de ordens ---------- */
const book = {};
function sigFor(p) { for (const sg of [5, 4, 3, 2]) { const st = Math.pow(10, Math.floor(Math.log10(p)) + 1 - sg); if (st / p >= 0.001) return { sg, st }; } return { sg: 2, st: Math.pow(10, Math.floor(Math.log10(p)) - 1) }; }
async function carregarLivro(k, cur) {
  try { const { sg, st } = sigFor(cur), b = await hlApi({ type: 'l2Book', coin: k, nSigFigs: sg });
    const conv = arr => arr.map(o => ({ px: +o.px, usd: +o.px * +o.sz }));
    book[k] = { t: Date.now(), step: st, bids: conv(b.levels[0]), asks: conv(b.levels[1]) }; } catch (e) {}
}

/* ---------- dados da Coinversa (via /api/liquidez) ---------- */
const mapas = {}, liqs = {}, press = {}, erros = {};
const build = d => { const lo = d.p * (1 - d.R / 100), w = d.p * 2 * d.R / 100 / d.nb, h = d.nb / 2;
  return { ...d, bw: w, L: d.L.map((v, i) => [lo + (i + 0.5) * w, v * 1e6, d.LP ? d.LP[i] : null]), S: d.S.map((v, i) => [lo + (h + i + 0.5) * w, v * 1e6, d.SP ? d.SP[i] : null]) }; };
async function buscar(q, k, alvo, transf = x => x) {
  try { alvo[k] = transf(await meuApi(q, k)); delete erros[q + k]; } catch (e) { erros[q + k] = e.message; if (e.message === 'senha') erros.senha = true; }
}

/* ---------- análise ---------- */
function zones(d, cur) {
  const bw = d.bw, mL = Math.max(1, ...d.L.map(a => a[1])), mS = Math.max(1, ...d.S.map(a => a[1]));
  const Lo = d.L.map((a, j) => ({ a, j })).filter(o => o.a[0] + bw / 2 < cur).sort((x, y) => y.a[0] - x.a[0]);
  const So = d.S.map((a, j) => ({ a, j })).filter(o => o.a[0] - bw / 2 > cur).sort((x, y) => x.a[0] - y.a[0]);
  const ap = Lo.find(o => o.a[1] >= 0.35 * mL), ve = So.find(o => o.a[1] >= 0.35 * mS);
  const vac = (arr, m) => { const runs = []; let r = null; arr.forEach((o, idx) => {
    if (o.a[1] < 0.08 * m) { if (!r) r = { i0: idx, lo: o.a[0] - bw / 2, hi: o.a[0] + bw / 2, n: 0, js: [] }; r.n++; r.lo = Math.min(r.lo, o.a[0] - bw / 2); r.hi = Math.max(r.hi, o.a[0] + bw / 2); r.js.push(o.j); }
    else { if (r) runs.push(r); r = null; } });
    if (r) runs.push(r); return runs.filter(x => x.n >= 2 && x.i0 > 0); };
  return { bw, mL, mS, Lo, So, ap, ve, vL: vac(Lo, mL), vS: vac(So, mS) };
}
function realLiqs(k) {
  return ((liqs[k] && liqs[k].events) || []).map(e => {
    let side = e.side, px = e.px;
    if (px == null) px = priceAt(k, e.t);
    if (!side) { const a = priceAt(k, e.t - 60e3), b = priceAt(k, e.t); if (a != null && b != null && a !== b) side = b < a ? 'long' : 'short'; }
    return { ...e, side, px };
  });
}
function liqSum(ev, ms) { const now = Date.now(), o = { long: 0, short: 0, nl: 0, ns: 0 };
  for (const e of ev) { if (now - e.t > ms) continue; if (e.side === 'long') { o.long += e.usd; o.nl++; } else if (e.side === 'short') { o.short += e.usd; o.ns++; } } return o; }
function squeeze(k, P) {
  if (!P) return null;
  let L = 0, S = 0; const why = [];
  const ann = P.funding != null ? P.funding * 24 * 365 * 100 : null, base = k.startsWith('xyz:') ? 5.475 : 10.95;
  // funding-piso da Hyperliquid (10,95% a.a. no cripto, 5,475% no xyz) é neutro: só conta o que passar bem dele
  if (ann != null && ann > base + 10) { L++; why.push(['L', `longs pagando funding de ${f1(ann)}% a.a.`]); }
  if (ann != null && ann < -10) { S++; why.push(['S', `shorts pagando funding de ${f1(-ann)}% a.a.`]); }
  const ls = P.ls;
  if (ls && ls.longPnl != null) {
    if (ls.longPnl < 0 && ls.shortPnl > 0) { L++; why.push(['L', `longs no prejuízo (${sgn(ls.longPnl)})`]); }
    else if (ls.shortPnl < 0 && ls.longPnl > 0) { S++; why.push(['S', `shorts no prejuízo (${sgn(ls.shortPnl)})`]); } }
  if (ls) { const r = ls.longAcc / Math.max(1, ls.shortAcc), pL = Math.round(100 * ls.longAcc / (ls.longAcc + ls.shortAcc));
    if (r > 1.5) { L++; why.push(['L', `multidão comprada (${pL}% das contas)`]); } else if (r < 0.67) { S++; why.push(['S', `multidão vendida (${100 - pL}% das contas)`]); } }
  const grp = ks => { let l = 0, s = 0; for (const c of P.cohorts) if (ks.includes(c.tier)) { l += c.L; s += c.S; } return l + s ? (l - s) / (l + s) : 0; };
  const smart = grp(['money_printer', 'smart_money']), crowd = grp(['exit_liquidity', 'humble_earner']);
  if (smart < -0.2 && crowd > 0.1) { L++; why.push(['L', 'lucrativos vendidos × multidão comprada']); }
  else if (smart > 0.2 && crowd < -0.1) { S++; why.push(['S', 'lucrativos comprados × multidão vendida']); }
  const c4 = P.oiChg && P.oiChg.h4;
  if (c4 && Math.abs(c4.oi) > 0.005) {
    if (c4.oi > 0 && c4.px < 0) { L++; why.push(['L', `OI ${pc(c4.oi * 100)} com preço caindo (4 h): shorts abrindo`]); }
    else if (c4.oi < 0 && c4.px < 0) { L++; why.push(['L', `OI ${pc(c4.oi * 100)} com preço caindo (4 h): longs saindo`]); }
    else if (c4.oi > 0 && c4.px > 0) { S++; why.push(['S', `OI ${pc(c4.oi * 100)} com preço subindo (4 h): longs abrindo`]); }
    else if (c4.oi < 0 && c4.px > 0) { S++; why.push(['S', `OI ${pc(c4.oi * 100)} com preço subindo (4 h): shorts fechando`]); } }
  const h = liqs[k] && liqs[k].sum1h;
  if (h && h.long > 2 * h.short && h.long > 250e3) { L++; why.push(['L', `${fm(h.long)} de longs liquidados em 1 h`]); }
  if (h && h.short > 2 * h.long && h.short > 250e3) { S++; why.push(['S', `${fm(h.short)} de shorts liquidados em 1 h`]); }
  const v = L - S >= 2 ? { t: 'Longs apertados', c: COR.dn } : S - L >= 2 ? { t: 'Shorts apertados', c: COR.up } : { t: 'Sem lado claramente apertado', c: COR.mu };
  return { ...v, L, S, why, ann };
}
function pivots(arr) {
  if (!arr || arr.length < 8) return null; let hi = null, lo = null;
  for (let i = arr.length - 3; i >= 2 && (hi == null || lo == null); i--) { const x = arr[i];
    if (hi == null && x.h > arr[i - 1].h && x.h > arr[i - 2].h && x.h >= arr[i + 1].h && x.h >= arr[i + 2].h) hi = x.h;
    if (lo == null && x.l < arr[i - 1].l && x.l < arr[i - 2].l && x.l <= arr[i + 1].l && x.l <= arr[i + 2].l) lo = x.l; }
  return { hi, lo };
}
function estrutura(k, tf, cur, n) {
  const p = pivots(cand[k] && cand[k][tf]); if (!p) return null;
  if (p.hi != null && cur > p.hi) return { s: 1, t: `${n} rompeu o último topo (${fpx(p.hi)})` };
  if (p.lo != null && cur < p.lo) return { s: -1, t: `${n} perdeu o último fundo (${fpx(p.lo)})` };
  return null;
}
function avaliar(k, A, modo, lado) {
  const { cur, zn } = A, isBuy = lado === 'compra', bw = zn.bw, H = modo === 'day' ? 4 : 24;
  const blocks = [], pros = [], cons = [], faltam = []; let sc = 50;
  const falta = (v, t) => faltam.push([v, t]);
  const add = (v, t) => { sc += v; (v >= 0 ? pros : cons).push((v >= 0 ? '+' : '') + v + ' ' + t); };
  let stop = null, alvo = null;
  if (isBuy) { if (zn.ap) stop = (zn.ap.a[0] - bw / 2) * (1 - ROTEIRO.stopBuf); if (zn.ve) alvo = zn.ve.a[0] - bw / 2; }
  else { if (zn.ve) stop = (zn.ve.a[0] + bw / 2) * (1 + ROTEIRO.stopBuf); if (zn.ap) alvo = zn.ap.a[0] + bw / 2; }
  const rr = stop && alvo ? Math.abs(alvo - cur) / Math.abs(cur - stop) : null;
  if (rr == null) cons.push('sem alvo/stop claros no mapa — R:R não calculável');
  else if (rr < ROTEIRO.rrMin) { const e = (alvo + ROTEIRO.rrMin * stop) / (1 + ROTEIRO.rrMin);
    blocks.push(`R:R ${f1(rr)} abaixo de ${ROTEIRO.rrMin}:1 — só vale ${isBuy ? 'comprando em' : 'vendendo em'} ${fpx(e)} ou ${isBuy ? 'abaixo' : 'acima'} (${pc((e / cur - 1) * 100)})`); }
  else if (rr >= 3) add(15, `R:R ${f1(rr)}:1`); else add(8, `R:R ${f1(rr)}:1`);
  if (alvo && stop) { const pa = pTouch(k, alvo, cur, H), ps = pTouch(k, stop, cur, H);
    if (pa != null && ps != null) { const df = (pa - ps) * 100;
      if (df >= 10) add(10, `alvo mais provável que o stop em ${H} h (${pp(pa)} × ${pp(ps)})`);
      else if (df <= -10) add(-10, `stop mais provável que o alvo em ${H} h (${pp(ps)} × ${pp(pa)})`);
      if (df < 10 && Math.max(pa, ps) >= 0.05) falta(df <= -10 ? 20 : 10, `alvo ficar mais provável que o stop em ${H} h (hoje ${pp(pa)} × ${pp(ps)})`); } }
  const sL = isBuy ? 1 : -1;
  if (modo === 'day') {
    const e4 = estrutura(k, '4h', cur, '4H'); if (e4) add(10 * e4.s * sL, e4.t);
    if (!e4 || e4.s !== sL) { const pv = pivots(cand[k] && cand[k]['4h']), nv = pv && (isBuy ? pv.hi : pv.lo);
      if (nv != null) falta(e4 ? 20 : 10, `4H ${isBuy ? 'romper o último topo' : 'perder o último fundo'} (${fpx(nv)}, ${pc((nv / cur - 1) * 100)})`); }
    if (A.tr.dir) add(5 * A.tr.dir * sL, `último minuto ${A.tr.dir > 0 ? 'subindo' : 'caindo'}`);
    if (A.tr.dir !== sL) falta(A.tr.dir ? 10 : 5, `último minuto ${isBuy ? 'subindo' : 'caindo'}`);
    if (Math.abs(A.tr.c15) >= 0.3) add((A.tr.c15 > 0 ? 5 : -5) * sL, `15 min ${pc2(A.tr.c15)}`);
    if (!(A.tr.c15 * sL >= 0.3)) falta(A.tr.c15 * sL <= -0.3 ? 10 : 5, `15 min ${isBuy ? 'subindo' : 'caindo'} 0,3% ou mais (hoje ${pc2(A.tr.c15)})`);
    const r15 = rsiAt(k, '15m', 9e5, cur);
    if (r15 && r15.v <= 30) add(isBuy ? 5 : -5, `RSI 15 min em sobrevenda (${f1(r15.v)})`);
    if (r15 && r15.v >= 70) add(isBuy ? -5 : 5, `RSI 15 min em sobrecompra (${f1(r15.v)})`);
    if (r15 && (isBuy ? r15.v > 30 : r15.v < 70)) falta(5, `RSI 15 min ${isBuy ? 'em sobrevenda (≤30)' : 'em sobrecompra (≥70)'} (hoje ${f1(r15.v)})`);
    const bk = book[k]; if (bk && Date.now() - bk.t < 30000) {
      const near = arr => arr.filter(o => Math.abs(o.px / cur - 1) < 0.005).reduce((t, o) => t + o.usd, 0), b = near(bk.bids), a = near(bk.asks);
      const im = b + a > 0 ? (b - a) / (b + a) : 0;
      if (Math.abs(im) > 0.3) add((im > 0 ? 5 : -5) * sL, `livro perto do preço com mais ${im > 0 ? 'compra' : 'venda'} (${Math.round(Math.abs(im) * 100)}%)`);
      if (!(im * sL > 0.3)) falta(im * sL < -0.3 ? 10 : 5, `livro perto do preço com mais ${isBuy ? 'compra' : 'venda'}`); }
  } else {
    const eD = estrutura(k, '1d', cur, 'Diário'); if (eD) add(10 * eD.s * sL, eD.t);
    const rD = rsiAt(k, '1d', 864e5, cur), rW = rsiAt(k, '1w', 7 * 864e5, cur);
    if (!isBuy && rD && rD.v >= 70) add(5, `RSI diário em sobrecompra (${f1(rD.v)})`);
    if (rW && rW.v >= 70) add(isBuy ? -5 : 5, `RSI semanal esticado (${f1(rW.v)})`);
  }
  const q = squeeze(k, press[k]);
  if (q && q.t === 'Longs apertados') add(isBuy ? -10 : 10, 'longs apertados');
  if (q && q.t === 'Shorts apertados') add(isBuy ? 10 : -10, 'shorts apertados');
  if (!q || q.t !== (isBuy ? 'Shorts apertados' : 'Longs apertados')) falta(q && q.t === (isBuy ? 'Longs apertados' : 'Shorts apertados') ? 20 : 10, `${isBuy ? 'shorts' : 'longs'} ficarem apertados (funding, OI e grupos)`);
  const l5 = liqSum(realLiqs(k), 300e3), lim = Math.max(500e3, 0.25 * Math.max(zn.ap ? zn.ap.a[1] : 0, zn.ve ? zn.ve.a[1] : 0));
  if (isBuy && l5.long >= lim) blocks.push(`cascata de longs em curso (${fm(l5.long)} em 5 min) — não pegue faca caindo`);
  if (!isBuy && l5.short >= lim) blocks.push(`cascata de shorts em curso (${fm(l5.short)} em 5 min)`);
  sc = Math.max(0, Math.min(100, Math.round(sc)));
  const st = blocks.length ? ['BLOQUEADO', COR.dn] : sc >= ROTEIRO.liberado ? ['LIBERADO', COR.up] : sc >= ROTEIRO.cuidado ? ['CUIDADO', COR.am] : ['FRACO', COR.mu];
  faltam.sort((x, y) => y[0] - x[0]);
  return { sc, st, blocks, pros, cons, stop, alvo, rr, faltam };
}

/* histórico local para o gráfico (compartilhado entre as abas): liquidações reais vistas e a foto anterior do mapa */
const liqHist = {}, mapaPrev = {};
/* trades do Meu diário (mesma senha), para marcar no gráfico; relidos no máximo a cada 60 s */
const diario = { t: 0, trades: [] };
async function carregarDiario() {
  if (!senha() || Date.now() - diario.t < 60e3) return; diario.t = Date.now();
  try { const r = await fetch('api/trades', { headers: { 'x-senha': senha() } }); if (r.ok) diario.trades = (await r.json()).trades || []; } catch (e) {}
}
const mesmoAtivo = (k, a) => !!a && (a === k || 'xyz:' + a === k || k.replace(/^xyz:/, '') === String(a).replace(/^xyz:/, ''));
const GRAF_HTML = `<div class="lv-bar"><b class="lv-an"></b><b class="lv-px num"></b><span class="lv-tr"></span><span class="lv-vd"></span><span style="flex:1"></span><span class="small muted lv-st"></span></div>
    <div class="lv-tabs"></div>
    <div class="lv-erro" hidden></div>
    <div class="box lv-graf"><div class="box-head" style="flex-wrap:wrap;gap:8px"><div class="seg lv-gtf"><button data-g="15m">15 min</button><button data-g="1h">1 hora</button><button data-g="4h">4 horas</button><button data-g="1d">Diário</button></div>
      <div class="lv-gcam" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center"></div><span style="flex:1"></span><button class="lv-grsi" type="button" style="font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:none;color:var(--fg);cursor:pointer">ver no RSI Mestre ↗</button></div>
      <p class="small lv-gleit"></p><div class="lv-gplano small"></div><div class="lv-gsvg"></div><div class="lv-grsil"></div><p class="small muted lv-gnota"></p></div>`;
const CAMADAS = [['sr', 'Suporte/resistência'], ['niv', 'Níveis'], ['est', 'Estrutura'], ['liq', 'Liquidez'], ['bol', 'Liquidações'], ['rsi', 'RSI'], ['plano', 'Meu plano'], ['trades', 'Meus trades'], ['rsima', 'Média do RSI']];

/* ---------- uma instância por mercado (Cripto / Ações) e por vista (Liquidez ao vivo / Gráfico) ---------- */
function criarApp(mercado, painel, raiz, vista = 'liq') {
  let lista = mercado === 'acoes' && Array.isArray(window.radarAcoes) && window.radarAcoes.length ? window.radarAcoes.slice(0, 12) : ATIVOS[mercado];
  const ls = (n, v) => { try { if (v === undefined) return localStorage.getItem('lv-' + mercado + '-' + n); localStorage.setItem('lv-' + mercado + '-' + n, v); } catch (e) { return null; } };
  let SEL = ls('sel') || lista[0], Z = +(ls('zoom') || 0.5), MODO = ls('modo') || 'full', GTF = ls('gtf') || '15m', hov = null, mx0 = 0, my0 = 0, gSig = '';
  let CAM = Object.fromEntries(CAMADAS.map(([k]) => [k, k !== 'rsima']));   // a média do RSI começa desligada
  try { Object.assign(CAM, JSON.parse(ls('gcam') || '{}')); } catch (e) {}
  const rOpen = new Set();

  raiz.innerHTML = vista === 'graf' ? GRAF_HTML : `<div class="lv-bar"><b class="lv-an"></b><b class="lv-px num"></b><span class="lv-tr"></span><span class="lv-vd"></span><span style="flex:1"></span>
    <button class="chip lv-som" type="button"></button><div class="seg lv-mode"><button data-m="ess">Essencial</button><button data-m="full">Completo</button></div><span class="small muted lv-st"></span></div>
    <div class="lv-tabs"></div>
    <div class="lv-erro" hidden></div>
    <div class="lv-grid"><div class="lv-main">
      <div class="box lv-top"></div>
      <div class="box"><div class="box-head"><h2>Mapa de liquidações</h2><button class="lv-irgraf" type="button" style="font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:none;color:var(--fg);cursor:pointer">abrir no Gráfico ↗</button><div class="seg lv-zoom"><button data-z="1">±15%</button><button data-z="0.5">±7,5%</button><button data-z="0.2">±3%</button></div></div>
        <div class="lv-gat"></div>
        <div class="lv-chart"><div class="lv-svg"></div><div class="lv-tip"></div></div><p class="small muted lv-foot"></p></div>
      <div class="lv-cards"></div>
      <div class="box lv-full lv-liqr"></div>
    </div><div class="lv-side">
      <div class="box lv-rot"></div>
      <div class="box lv-full lv-press"></div>
      <div class="box lv-full lv-como"></div>
    </div></div>`;
  const $ = s => raiz.querySelector(s);
  function setModo(m) { MODO = m; ls('modo', m); raiz.classList.toggle('lv-ess', m === 'ess'); raiz.querySelectorAll('.lv-mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === m))); }
  function setZoom(z) { Z = z; ls('zoom', z); raiz.querySelectorAll('.lv-zoom button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.z === z))); }
  setModo(MODO); setZoom(Z);

  /* ---- aviso sonoro + notificação do navegador (ativo selecionado; só enquanto esta página estiver aberta) ---- */
  let SOM = vista === 'graf' ? false : ls('som') === '1', actx = null; const avisados = {}, ultTrava = {};
  const visivel = () => !painel.hidden && !document.hidden;
  function setSom(on) {
    if (vista === 'graf') return;   // o aviso sonoro fica só na Liquidez ao vivo
    SOM = on; ls('som', on ? '1' : '0'); const b = $('.lv-som'); b.textContent = on ? '🔔 Aviso ligado' : '🔕 Aviso desligado'; b.setAttribute('aria-pressed', String(on));
    b.title = 'Toca um bip e mostra uma notificação quando o preço chegar perto de uma zona, houver liquidações em curso ou a Trava mudar (ativo selecionado). Só funciona com esta página aberta.';
  }
  function bip() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume();
      [0, 0.22].forEach(t => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; g.gain.value = 0.12; o.connect(g); g.connect(actx.destination); o.start(actx.currentTime + t); o.stop(actx.currentTime + t + 0.15); });
    } catch (e) {}
  }
  function avisar(id, texto, rearme = 15 * 60e3) {
    if (!SOM) return; const k = SEL + '|' + id, agora = Date.now();
    if (avisados[k] && agora - avisados[k] < rearme) return; avisados[k] = agora;
    bip(); try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Liquidez ao vivo · ' + nome(SEL), { body: texto }); } catch (e) {}
  }
  const sel = () => mapas[SEL] ? build(mapas[SEL]) : null;
  function analyze() {
    const d = sel(), cur = live[SEL] || (d && d.p) || null; if (!d || !cur) return null;
    return { d, cur, zn: zones(d, cur), tr: trend(SEL, cur) };
  }
  const CORES = { BTC: '#ef9f27', ETH: '#7f77dd', SOL: '#1d9e75', XRP: '#378add', HYPE: '#5dcaa5', NEAR: '#d4537e' };
  const corAtivo = k => CORES[nome(k)] || `hsl(${[...nome(k)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 55% 55%)`;
  function renderTabs() {
    $('.lv-tabs').innerHTML = lista.map(k => { const cur = live[k], tr = cur ? trend(k, cur) : null;
      return `<button class="lv-tab" data-k="${k}" aria-pressed="${k === SEL}"><i class="lv-dot" style="background:${corAtivo(k)}"></i><b>${nome(k)}</b><span style="color:${tr ? tr.color : COR.mu}">${tr ? tr.arrow : ''}</span><span class="small muted num">${cur ? fpx(cur) : '—'}</span></button>`; }).join('');
  }
  function renderBar(A) {
    const k = SEL, cur = A ? A.cur : live[k];
    $('.lv-an').textContent = nome(k);
    const px = $('.lv-px'); px.textContent = cur ? fpx(cur) : '—'; px.style.color = flash[k] && flash[k].until > Date.now() ? flash[k].col : '';
    $('.lv-tr').innerHTML = A ? `<span class="chip" style="color:${A.tr.color}">${A.tr.arrow} ${A.tr.label}</span>` : '';
    if (A) {
      const est = ['day', 'swing'].map(m => { const a = avaliar(k, A, m, 'compra'), b = avaliar(k, A, m, 'venda'); return (m === 'day' ? 'Day' : 'Swing') + ' ' + [!a.blocks.length ? 'compra livre' : '', !b.blocks.length ? 'venda livre' : ''].filter(Boolean).join(' e ') || 'bloqueado'; }).join(' · ');
      if (ultTrava[k] != null && ultTrava[k] !== est) avisar('trava|' + est, 'A Trava do roteiro mudou: ' + est + '.', 60e3);
      ultTrava[k] = est;
    }
    $('.lv-vd').innerHTML = A ? ['day', 'swing'].map(m => { const a = avaliar(k, A, m, 'compra'), b = avaliar(k, A, m, 'venda');
      const okA = !a.blocks.length, okB = !b.blocks.length, r = okA && (!okB || a.sc >= b.sc) ? { ...a, l: 'compra' } : okB ? { ...b, l: 'venda' } : (a.sc >= b.sc ? { ...a, l: 'compra' } : { ...b, l: 'venda' });
      return `<span class="chip" style="color:${r.st[1]}">${m === 'day' ? 'Day' : 'Swing'}: ${r.st[0] === 'BLOQUEADO' ? '■ bloq' : r.st[0].toLowerCase()} ${r.sc} · ${r.l}</span>`; }).join(' ') : '';
    const age = (Date.now() - lastMsg) / 1000, M = mapas[k];
    $('.lv-st').innerHTML = `<span style="color:${lastMsg && age < 15 ? COR.up : COR.dn}">●</span> ${lastMsg && age < 15 ? 'preço ao vivo' : 'sem preço'}${M ? ` · barras de ${ago(M.ts)}` : ''}`;
  }
  function calcAlertas(A) {
    const { cur, zn } = A, k = SEL;
    const al = [];
    const perto = (E, lab, amt, cls, id) => { if (E == null) return; const dd = Math.abs(E / cur - 1) * 100; if (dd < 0.6) al.push([cls, `Preço a ${f1(dd)}% do ${lab} (${fm(amt)} em liquidações).`, id]); };
    if (zn.ap) perto(zn.ap.a[0] + zn.bw / 2, 'apoio', zn.ap.a[1], 'down', 'apoio'); if (zn.ve) perto(zn.ve.a[0] - zn.bw / 2, 'nível de venda', zn.ve.a[1], 'up', 'venda');
    const rd = rsiAt(k, '1d', 864e5, cur), r4 = rsiAt(k, '4h', 144e5, cur);
    if (rd && rd.v <= 30) al.push(['warn', `Dia em sobrevenda: RSI ${f1(rd.v)}. Sozinho não prevê direção.`]);
    if (rd && rd.v >= 70) al.push(['warn', `Dia em sobrecompra: RSI ${f1(rd.v)}. Sozinho não prevê direção.`]);
    if (r4 && (r4.v >= 70 || r4.v <= 30)) al.push(['warn', `4H em ${r4.v >= 70 ? 'sobrecompra' : 'sobrevenda'}: RSI ${f1(r4.v)}.`]);
    const l5 = liqSum(realLiqs(k), 300e3), lim = Math.max(500e3, 0.25 * Math.max(zn.ap ? zn.ap.a[1] : 0, zn.ve ? zn.ve.a[1] : 0));
    if (l5.long >= lim) al.unshift(['down', `⚡ Liquidações em curso: ${fm(l5.long)} de longs nos últimos 5 min (${l5.nl} eventos).`, 'liq-l']);
    if (l5.short >= lim) al.unshift(['up', `⚡ Liquidações em curso: ${fm(l5.short)} de shorts nos últimos 5 min (${l5.ns} eventos).`, 'liq-s']);
    al.forEach(([c, t, id]) => { if (id) avisar(id, t.replace('⚡ ', '')); });
    return al;
  }
  function renderTop(A) {
    const { cur, zn, tr } = A, k = SEL;
    const lado = (o, isL) => { if (!o) return `<span class="muted">sem ${isL ? 'apoio' : 'venda'} relevante ${isL ? 'abaixo' : 'acima'}</span>`;
      const E = isL ? o.a[0] + zn.bw / 2 : o.a[0] - zn.bw / 2;
      return `<span style="color:${isL ? COR.long : COR.short}"><b>${isL ? 'Apoio' : 'Venda'}</b> ${fpx(E)} (${pc((E / cur - 1) * 100)}) · ${fm(o.a[1])}</span> <span class="muted">→ tocar em 24 h</span> <b>${pp(pTouch(k, E, cur, 24))}</b>`; };
    const cd = cand[k] && cand[k]['1d'], fraseD = cd && cd.length > 20 ? fraseRsi([...cd.map(x => x.c).slice(0, cd[cd.length - 1].t + 864e5 > Date.now() ? -1 : undefined), cur], 'do dia') : '';
    const ctxMedo = mercado === 'cripto' ? (MEDO ? fraseMedo(MEDO) : '') : (VIX ? fraseVix(VIX) : '');
    let rs = ''; TF.forEach(([lb, tf, ms]) => { const r = rsiAt(k, tf, ms, cur);
      rs += `<div class="lv-rt"><span class="small muted">${lb}</span>` + (r ? `<b class="num" style="color:${rsiCol(r.v)}">${f1(r.v)}<small style="color:${r.v >= r.prev ? COR.up : COR.dn}"> ${r.v >= r.prev ? '▲' : '▼'}</small></b>
        <div class="lv-gauge"><i style="left:${Math.min(100, Math.max(0, r.v))}%"></i></div>` : `<b class="muted">—</b><div class="lv-gauge"></div>`) + `</div>`; });
    const al = calcAlertas(A);
    const q = squeeze(k, press[k]);
    const vac = (runs, abaixo) => {
      const r = runs[0]; if (!r) return '';
      const d1 = (r.hi / cur - 1) * 100, d2 = (r.lo / cur - 1) * 100;
      const z = abaixo ? zn.ap : zn.ve, antes = z ? (abaixo ? r.lo >= z.a[0] : r.hi <= z.a[0]) : false;   // o vácuo fica antes da zona (no caminho) ou depois dela
      return `<br><span class="small" style="color:var(--warn)">Vácuo ${abaixo ? 'abaixo' : 'acima'}: ${fpx(r.lo)}–${fpx(r.hi)} (${pc(abaixo ? d1 : d2)} a ${pc(abaixo ? d2 : d1)}): ${antes ? `entre o preço e ${abaixo ? 'o apoio' : 'a venda'}: pouca liquidez no caminho, o preço pode chegar rápido` : `${abaixo ? 'perdendo o apoio' : 'rompendo a venda'}, o preço pode passar reto`}.</span>`;
    };
    const zc = (o, isL) => {
      const c = isL ? COR.long : COR.short, nomeZ = isL ? 'Zona abaixo · apoio' : 'Zona acima · venda';
      if (!o) return `<div class="lv-zc"><span class="small muted">${nomeZ}</span><b class="lv-zd muted">—</b><span class="small muted">sem zona relevante na faixa lida</span></div>`;
      const E = isL ? o.a[0] + zn.bw / 2 : o.a[0] - zn.bw / 2, dd = (E / cur - 1) * 100;
      return `<div class="lv-zc" style="border-color:${c}"><span class="small muted">${nomeZ}${Math.abs(dd) < 0.6 ? ' <span class="chip warn">preço encostado</span>' : ''}</span>
        <b class="lv-zd" style="color:${c}">${pc(dd)}</b><span class="num">${fpx(o.a[0] - zn.bw / 2)} – ${fpx(o.a[0] + zn.bw / 2)}</span>
        <span class="small muted">${fm(o.a[1])}${o.a[2] != null ? ' · ' + o.a[2] + ' posições' : ''} · tocar 4 h <b>${pp(pTouch(k, E, cur, 4))}</b> · 24 h <b>${pp(pTouch(k, E, cur, 24))}</b></span></div>`;
    };
    $('.lv-top').innerHTML = `<div class="lv-zcs">${zc(zn.ve, false)}${zc(zn.ap, true)}<div class="lv-zc lv-zrsi"><span class="small muted">RSI 14 · ao vivo</span><div class="lv-rsi">${rs}</div>${fraseD ? `<span class="small muted">${fraseD}</span>` : ''}${ctxMedo ? `<span class="small muted">${ctxMedo}</span>` : ''}</div></div><div class="lv-lados">${(vac(zn.vL, true) + vac(zn.vS, false)).replace(/^<br>/, '')}</div>
      <p class="small muted" style="margin-top:4px">1m ${pc2(tr.c1)} · 5m ${pc2(tr.c5)} · 15m ${pc2(tr.c15)}${q ? ` · quem está apertado: <b style="color:${q.c}">${q.t}</b>` : ''}</p>
      ${al.length ? `<div class="lv-alerts">${al.slice(0, 3).map(([c, t]) => `<div class="chip ${c}">${t}</div>`).join('')}</div>` : ''}`;
  }
  function renderChart(A) {
    const { d, cur, zn, tr } = A, k = SEL;
    const W = 960, H = 330, x0 = 12, x1 = W - 12, top = 70, base = 290;
    const Rv = d.R * Z, lo = d.p * (1 - Rv / 100), hi = d.p * (1 + Rv / 100);
    const X = pr => x0 + (pr - lo) / (hi - lo) * (x1 - x0), XC = pr => Math.min(Math.max(X(pr), x0), x1), vis = a => a[0] > lo && a[0] < hi;
    const mx = Math.max(1, ...d.L.concat(d.S).filter(vis).map(a => a[1]), 0.15 * Math.max(1, ...d.L.concat(d.S).map(a => a[1])));
    const colw = (x1 - x0) / (d.nb * Z), w = Math.max(2, colw - 3), hh = base - top - 22;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Mapa de liquidações de ${nome(k)}"><defs><pattern id="lvHatch-${mercado}" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" style="stroke:var(--warn);stroke-width:2.5;stroke-opacity:.35"/></pattern></defs>`;
    s += `<text x="${W / 2}" y="18" text-anchor="middle" style="fill:var(--fg);font:700 13px var(--f-mono)">agora ${fpx(cur)}</text>`;
    const bk = book[k];
    if (bk && Date.now() - bk.t < 30000) {
      const yb = 50, bh = 16, all = bk.bids.concat(bk.asks), mb = Math.max(1, ...all.map(o => o.usd)), bwp = Math.max(2, X(cur + bk.step) - X(cur) - 1);
      s += `<text x="${x0}" y="32" style="fill:var(--muted);font-size:10.5px">livro de ordens</text>`;
      const bar = (o, c) => { if (o.px < lo || o.px > hi) return; const h = Math.max(1.5, o.usd / mb * bh);
        s += `<rect x="${(X(o.px) - bwp / 2).toFixed(1)}" y="${(yb - h).toFixed(1)}" width="${bwp.toFixed(1)}" height="${h.toFixed(1)}" rx="1" style="fill:${c};opacity:.8"/>`; };
      bk.bids.forEach(o => bar(o, COR.up)); bk.asks.forEach(o => bar(o, COR.dn));
      const wall = all.reduce((a, b) => b.usd > a.usd ? b : a);
      if (wall.px >= lo && wall.px <= hi) s += `<text x="${x1}" y="32" text-anchor="end" style="fill:${bk.bids.includes(wall) ? COR.up : COR.dn};font-size:10.5px">maior parede ${fm(wall.usd)} em ${fpx(wall.px)}</text>`;
    }
    [-Rv, -Rv / 2, Rv / 2, Rv].forEach(v => { const xv = X(d.p * (1 + v / 100));
      s += `<line x1="${xv.toFixed(1)}" x2="${xv.toFixed(1)}" y1="${top}" y2="${base}" style="stroke:var(--line)"/>`;
      s += `<text x="${xv.toFixed(1)}" y="${base + 18}" text-anchor="${v === -Rv ? 'start' : v === Rv ? 'end' : 'middle'}" style="fill:var(--muted);font-size:11.5px">${v > 0 ? '+' : ''}${String(+v.toFixed(2)).replace('.', ',')}% · ${fpx(d.p * (1 + v / 100))}</text>`; });
    [zn.vL, zn.vS].forEach(runs => runs.forEach((r, ri) => { if (r.hi < lo || r.lo > hi) return; const xa = XC(r.lo), xb = XC(r.hi); if (xb - xa < 3) return;
      s += `<rect x="${xa.toFixed(1)}" y="${top}" width="${(xb - xa).toFixed(1)}" height="${base - top}" rx="3" style="fill:url(#lvHatch-${mercado});stroke:var(--warn);stroke-opacity:.45;stroke-dasharray:4 4"/>`;
      if (ri === 0 && xb - xa >= 44) s += `<text x="${((xa + xb) / 2).toFixed(1)}" y="${top + 16}" text-anchor="middle" style="fill:var(--warn);font-size:11px;font-weight:600">${xb - xa >= 150 ? 'vácuo · pode passar reto' : 'vácuo'}</text>`; }));
    s += `<line x1="${x0}" x2="${x1}" y1="${base}" y2="${base}" style="stroke:var(--faint)"/>`;
    let hits = '';
    const draw = (arr, c, isL) => arr.forEach((a, j) => { if (!vis(a)) return;
      const h = Math.max(1.5, Math.min(1, a[1] / mx) * hh), crossed = isL ? a[0] + zn.bw / 2 >= cur : a[0] - zn.bw / 2 <= cur, key = (isL ? 'L' : 'S') + '-' + j, on = hov === key;
      if (on) s += `<rect x="${(X(a[0]) - colw / 2).toFixed(1)}" y="${top}" width="${colw.toFixed(1)}" height="${base - top}" style="fill:var(--fg);opacity:.05"/>`;
      s += `<rect x="${(X(a[0]) - w / 2).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2.5" style="fill:${c};opacity:${crossed ? 0.2 : on ? 1 : 0.88}"/>`;
      hits += `<rect data-k="${key}" x="${(X(a[0]) - colw / 2).toFixed(1)}" y="${top}" width="${colw.toFixed(1)}" height="${base - top}" style="fill:transparent;cursor:crosshair"/>`; });
    draw(d.L, COR.long, true); draw(d.S, COR.short, false);
    let rot = '';   // rótulos das zonas: desenhados por último, com contorno, para a linha do preço não os cobrir
    const box = (o, isL) => { if (!o || !vis(o.a)) return;
      const h = Math.max(1.5, Math.min(1, o.a[1] / mx) * hh), c = isL ? COR.long : COR.short, xa = X(o.a[0]) - colw / 2;
      s += `<rect x="${xa.toFixed(1)}" y="${(base - h - 4).toFixed(1)}" width="${colw.toFixed(1)}" height="${(h + 4).toFixed(1)}" rx="4" style="fill:${c};fill-opacity:.1;stroke:${c};stroke-width:2"/>`;
      const p24 = pTouch(k, isL ? o.a[0] + zn.bw / 2 : o.a[0] - zn.bw / 2, cur, 24), lx = Math.min(Math.max(X(o.a[0]), x0 + 60), x1 - 60);
      const yl = Math.max(top + 28, base - h - 24), dist = pc(((isL ? o.a[0] + zn.bw / 2 : o.a[0] - zn.bw / 2) / cur - 1) * 100);
      const halo = 'paint-order:stroke;stroke:var(--surface);stroke-width:4px;stroke-linejoin:round;';
      rot += `<text x="${lx.toFixed(1)}" y="${yl.toFixed(1)}" text-anchor="middle" style="${halo}fill:${c};font-size:12px;font-weight:700">${isL ? 'apoio' : 'venda'} ${fm(o.a[1])}</text>`
        + `<text x="${lx.toFixed(1)}" y="${(yl + 13).toFixed(1)}" text-anchor="middle" style="${halo}fill:${c};font-size:11px">${dist} · 24h ~${pp(p24)}</text>`; };
    box(zn.ap, true); box(zn.ve, false);
    const xs = X(d.p); if (xs > x0 && xs < x1) s += `<line x1="${xs.toFixed(1)}" x2="${xs.toFixed(1)}" y1="${top}" y2="${base}" style="stroke:var(--faint);stroke-dasharray:4 4"/>`;
    const cx = XC(cur), now = Date.now(), span = 900e3, yT = top - 6, yB = base;
    const pts = (hist[k] || []).filter(a => a[0] >= now - span).concat([[now, cur]]), stp = Math.max(1, Math.floor(pts.length / 120)), sp = pts.filter((a, i) => i % stp === 0 || i === pts.length - 1);
    for (let i = 1; i < sp.length; i++) { const [ta, pa] = sp[i - 1], [tb, pb] = sp[i];
      s += `<line x1="${XC(pa).toFixed(1)}" y1="${(yT + (now - ta) / span * (yB - yT)).toFixed(1)}" x2="${XC(pb).toFixed(1)}" y2="${(yT + (now - tb) / span * (yB - yT)).toFixed(1)}" style="stroke:${tr.color};stroke-width:2.2;stroke-opacity:${(0.15 + 0.75 * (1 - (now - tb) / span)).toFixed(2)};stroke-linecap:round"/>`; }
    realLiqs(k).filter(e => now - e.t <= span && e.px && e.usd >= 5000).forEach(e => {
      const y = yT + (now - e.t) / span * (yB - yT), r = Math.min(11, 2.5 + Math.sqrt(e.usd / 1e4) * 1.3), c = e.side === 'long' ? COR.long : e.side === 'short' ? COR.short : COR.mu;
      s += `<circle cx="${XC(e.px).toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" style="fill:${c};fill-opacity:${e.exact ? 0.95 : 0.5};stroke:var(--surface);stroke-width:1.2"/>`; });
    s += `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${yT}" y2="${base}" style="stroke:var(--fg);stroke-opacity:.85;stroke-width:1.6"/>`;
    if (tr.dir) { const ax = cx + tr.dir * 24, c = tr.dir > 0 ? COR.up : COR.dn;
      s += `<line x1="${cx.toFixed(1)}" y1="${yT}" x2="${(ax - tr.dir * 6).toFixed(1)}" y2="${yT}" style="stroke:${c};stroke-width:3"/><polygon points="${ax.toFixed(1)},${yT} ${(ax - tr.dir * 8).toFixed(1)},${yT - 6} ${(ax - tr.dir * 8).toFixed(1)},${yT + 6}" style="fill:${c}"/>`; }
    s += `<circle cx="${cx.toFixed(1)}" cy="${yT}" r="5" style="fill:${tr.color};stroke:var(--surface);stroke-width:2"/>`;
    $('.lv-svg').innerHTML = s + rot + hits + '</svg>';
    const sumL = d.L.reduce((t, a) => t + a[1], 0), sumS = d.S.reduce((t, a) => t + a[1], 0), C = chance[k];
    renderGat(A);
    $('.lv-foot').innerHTML = `Livro de ordens da Hyperliquid, agora: parede pode sumir e não prevê direção. Na faixa lida: longs ${fm(sumL)} · shorts ${fm(sumS)} · Coinversa, ${ago(d.ts)}. Laranja: longs liquidados se cair; azul: shorts se subir. Bolinhas: liquidações reais dos últimos 15 min. Linha: preço ao vivo, rastro de 15 min (de cima = agora).` +
      (C && C.conf ? ` Chance de tocar conferida no histórico (70/30): ~25% → ${pp(C.conf[0].tocou)}, ~50% → ${pp(C.conf[1].tocou)}, ~75% → ${pp(C.conf[2].tocou)}.` : '');
    if (hov) tipFor(hov);
  }
  function tipFor(key) {
    const A = analyze(); if (!A) return;
    const { d, cur, zn } = A, k = SEL, [side, j] = key.split('-'), a = d[side][+j], bw = d.bw, isL = side === 'L';
    const crossed = isL ? a[0] + bw / 2 >= cur : a[0] - bw / 2 <= cur, ord = isL ? zn.Lo : zn.So, idx = ord.findIndex(o => o.j === +j);
    const acc = idx >= 0 ? ord.slice(0, idx + 1).reduce((t, o) => t + o.a[1], 0) : null, near = isL ? a[0] + bw / 2 : a[0] - bw / 2;
    const inVac = (isL ? zn.vL : zn.vS).some(r => r.js.includes(+j));
    const rl = realLiqs(k).filter(e => e.px && e.px >= a[0] - bw / 2 && e.px < a[0] + bw / 2 && e.side === (isL ? 'long' : 'short')), tot = rl.reduce((t, e) => t + e.usd, 0);
    const tip = $('.lv-tip');
    tip.innerHTML = `<b style="color:${isL ? COR.long : COR.short}">${isL ? 'Longs' : 'Shorts'}</b><br><b class="num">${fpx(a[0] - bw / 2)} – ${fpx(a[0] + bw / 2)}</b> <span class="muted">${pc((a[0] / cur - 1) * 100)} do preço</span><br>` +
      `Em risco: <b>${fm(a[1])}</b>${a[2] != null ? ` <span class="muted">· ${a[2]} posições</span>` : ''}` +
      (crossed ? `<br><span class="muted">faixa já cruzada pelo preço</span>` :
        `<br>Acumulado até aqui: <b>${acc != null ? fm(acc) : '—'}</b><br>Chance de tocar: 4 h <b>${pp(pTouch(k, near, cur, 4))}</b> · 24 h <b>${pp(pTouch(k, near, cur, 24))}</b>` +
        `<br>RSI se chegar: ${TF.map(([lb, tf, ms]) => { const r = rsiAt(k, tf, ms, near); return `<span class="muted">${lb}</span> ${r ? `<b style="color:${rsiCol(r.v)}">${f1(r.v)}</b>` : '—'}`; }).join(' · ')}` +
        (inVac ? `<br><span style="color:var(--warn)">vácuo: pouca liquidez, o preço pode passar reto</span>` : '')) +
      `<br>Liquidações reais aqui (1 h): <b>${rl.length ? fm(tot) + ' · ' + rl.length : 'nenhuma'}</b>`;
    const wr = $('.lv-chart').getBoundingClientRect(); tip.style.display = 'block';
    let x = mx0 - wr.left + 14; if (x + tip.offsetWidth > wr.width) x = mx0 - wr.left - tip.offsetWidth - 14;
    tip.style.left = x + 'px'; tip.style.top = (my0 - wr.top + 14) + 'px';
  }
  /* faixa do gatilho: o melhor veredito de day trade da Trava, dito como o roteiro diz (nota não é chance) */
  function renderGat(A) {
    const el = $('.lv-gat'); if (!el) return;
    const a = avaliar(SEL, A, 'day', 'compra'), b = avaliar(SEL, A, 'day', 'venda');
    const okA = !a.blocks.length, okB = !b.blocks.length;
    const r = okA && (!okB || a.sc >= b.sc) ? { ...a, l: 'compra' } : okB ? { ...b, l: 'venda' } : (a.sc >= b.sc ? { ...a, l: 'compra' } : { ...b, l: 'venda' });
    const est = r.st[0], acao = est === 'BLOQUEADO' ? 'Não entrar' : est === 'LIBERADO' ? 'Liberado pelo roteiro' : 'Aguardar gatilho';
    const precisa = Math.max(0, ROTEIRO.liberado - r.sc);
    let lista = [], soma = 0; for (const [v, t] of r.faltam) { if (soma >= precisa) break; lista.push(`${t} (+${v})`); soma += v; }
    const oQueFalta = !precisa ? '' : soma >= precisa ? `faltam ${precisa} pontos: ${lista.join(' · ')}` : `faltam ${precisa} pontos e nem tudo a favor chega lá hoje: espere outro setup`;
    const falta = r.blocks.length ? r.blocks[0] + (oQueFalta ? `. Depois disso, ${oQueFalta}` : '')
      : est === 'LIBERADO' ? (r.stop && r.alvo ? `stop ${fpx(r.stop)} · alvo ${fpx(r.alvo)} · R:R ${r.rr != null ? f1(r.rr) : '—'}` : '')
      : oQueFalta;
    el.innerHTML = `<div class="lv-gatb" style="border-color:${r.st[1]};color:${r.st[1]}"><b>${acao}</b> · day trade · ${r.l} · <span class="lv-gatf">${falta}</span><span style="flex:1"></span><b class="num">${r.sc}/100</b> <span class="small muted">nota do roteiro</span></div>
      <p class="small muted" style="margin:4px 0 0">A nota soma o que o roteiro confere (R:R, estrutura, fluxo, RSI). É contexto, não chance de acerto: ainda não há histórico medido dela.</p>`;
  }
  function renderCards(A) {
    const { cur, zn } = A, k = SEL;
    const card = (o, isL) => { const c = isL ? COR.long : COR.short, t = isL ? 'Apoio' : 'Venda';
      if (!o) return `<div class="box"><h3 style="color:${c}">${t}</h3><p class="muted small">Sem cluster relevante ${isL ? 'abaixo' : 'acima'} na faixa lida.</p></div>`;
      const E = isL ? o.a[0] + zn.bw / 2 : o.a[0] - zn.bw / 2;
      const dd = Math.abs(E / cur - 1) * 100;
      return `<div class="box"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3 style="color:${c}">${t}</h3><span class="chip ${dd < 0.6 ? 'warn' : ''}">${dd < 0.6 ? 'preço encostado' : 'a ' + f1(dd) + '%'}</span></div><p class="lv-rng num">${fpx(o.a[0] - zn.bw / 2)} – ${fpx(o.a[0] + zn.bw / 2)}</p>
        <p class="small muted">${fm(o.a[1])} em liquidações${o.a[2] != null ? ' · ' + o.a[2] + ' posições' : ''} · ${pc((o.a[0] / cur - 1) * 100)} do preço</p>
        <div class="lv-row"><span class="muted">Chance de tocar</span><span>4 h <b>${pp(pTouch(k, E, cur, 4))}</b> · 24 h <b>${pp(pTouch(k, E, cur, 24))}</b></span></div>
        <div class="lv-row"><span class="muted">RSI se chegar lá <span class="small">(conta, não previsão)</span></span><span>${TF.map(([lb, tf, ms]) => { const r = rsiAt(k, tf, ms, E); return `${lb === '15 min' ? '15m' : lb === 'Semana' ? 'S' : lb === 'Dia' ? 'D' : lb} <b style="color:${r ? rsiCol(r.v) : COR.mu}">${r ? f1(r.v) : '—'}</b>`; }).join(' · ')}</span></div></div>`; };
    $('.lv-cards').innerHTML = card(zn.ap, true) + card(zn.ve, false);
  }
  function renderLiqs() {
    const k = SEL, L = liqs[k], ev = realLiqs(k), cut = L && L.truncated && L.oldest && Date.now() - L.oldest < 900e3;
    const s15 = liqSum(ev, 900e3), h = L && L.sum1h, s60 = h || liqSum(ev, 3600e3), lb = cut ? 'desde ' + ago(L.oldest).replace('há ', '') : '15 min';
    const st = (lab, v, n, c) => `<div class="kpi"><span class="lab">${lab}</span><span class="val" style="color:${c}">${fm(v)}</span><span class="note">${n} eventos</span></div>`;
    const big = ev.filter(e => e.usd >= 10000).slice(0, 8);
    $('.lv-liqr').innerHTML = `<div class="box-head"><h2>Liquidações reais</h2><p>Coinversa + Hyperliquid, a cada 30 s. "Exato": preço e lado lidos na Hyperliquid; "estimado": tamanho pela taxa paga e lado pelo movimento do minuto.</p></div>
      <div class="kpis">${st('Longs · ' + lb, s15.long, s15.nl, COR.long)}${st('Shorts · ' + lb, s15.short, s15.ns, COR.short)}${st('Longs · 1 hora', s60.long, s60.nl, COR.long)}${st('Shorts · 1 hora', s60.short, s60.ns, COR.short)}</div>
      ${L ? (big.length ? `<div class="tbl-wrap"><table><tbody>${big.map(e => `<tr><td class="muted">${ago(e.t)}</td><td><b style="color:${e.side === 'long' ? COR.long : e.side === 'short' ? COR.short : COR.mu}">${e.side === 'long' ? 'Long liquidado' : e.side === 'short' ? 'Short liquidado' : 'lado ?'}</b></td><td class="n">${fm(e.usd)}${e.px ? ' a ' + fpx(e.px) : ''}</td><td class="muted small">${e.exact ? '✓ exato' : '≈ estimado'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">Nenhuma liquidação acima de US$ 10 mil na última hora.</p>') : '<p class="muted small">carregando…</p>'}`;
  }
  function renderRot(A) {
    const row = (m, l) => { const r = avaliar(SEL, A, m, l), key = m + '-' + l, open = rOpen.has(key);
      const hint = r.blocks.length ? r.blocks[0] : (r.alvo && r.stop ? `stop ${fpx(r.stop)} · alvo ${fpx(r.alvo)} · R:R ${r.rr != null ? f1(r.rr) : '—'}` : 'sem plano pelo mapa');
      return `<div class="lv-rrow" data-r="${key}" style="border-color:${r.st[1]}"><span><b>${m === 'day' ? 'Day trade' : 'Swing'} · ${l}</b></span><b class="num" style="color:${r.st[1]}">${r.sc}</b><b class="small" style="color:${r.st[1]}">${r.st[0] === 'BLOQUEADO' ? '■ ' : ''}${r.st[0]}</b>
        <span class="small" style="grid-column:1/-1;color:${r.blocks.length ? COR.dn : COR.mu}">${r.blocks.length ? '⛔ ' : ''}${hint}</span>
        ${open ? `<div class="small" style="grid-column:1/-1">${r.alvo && r.stop ? `<span class="muted">entrada ~${fpx(A.cur)} · stop ${fpx(r.stop)} · alvo ${fpx(r.alvo)}${r.rr != null ? ' · R:R ' + f1(r.rr) : ''}</span>` : ''}<ul>${r.blocks.slice(1).map(t => `<li style="color:${COR.dn}">⛔ ${t}</li>`).join('')}${r.pros.map(t => `<li style="color:${COR.up}">${t}</li>`).join('')}${r.cons.map(t => `<li style="color:${COR.am}">${t}</li>`).join('')}</ul></div>` : ''}</div>`; };
    $('.lv-rot').innerHTML = `<div class="box-head"><h2>Trava do seu roteiro</h2><span class="chip warn">não é recomendação</span></div>
      ${row('day', 'compra')}${row('day', 'venda')}${row('swing', 'compra')}${row('swing', 'venda')}
      <p class="small muted lv-full" style="margin-top:8px">Bloqueiam: R:R &lt; ${ROTEIRO.rrMin}:1 · cascata de liquidações contra você. O resto soma ou tira pontos (base 50; liberado ≥ ${ROTEIRO.liberado}). Stop além da zona de liquidação mais próxima; alvo na zona do outro lado. Day trade usa 4 h; swing usa 24 h e o diário. Clique numa linha para ver os motivos. Confira balanços e agenda na aba de eventos.</p>`;
  }
  function renderPress() {
    const k = SEL, P = press[k], el = $('.lv-press');
    if (!P) { el.innerHTML = `<div class="box-head"><h2>Quem está apertado</h2></div><p class="muted small">${erros['press' + k] ? 'sem dados agora (' + erros['press' + k] + ')' : 'carregando…'}</p>`; return; }
    const q = squeeze(k, P), ls = P.ls, o = P.oiChg || {}, oc = x => x ? `<span style="color:${x.oi >= 0 ? COR.up : COR.dn}">${pc(x.oi * 100)}</span>` : '—';
    const f24 = P.funding24 != null ? P.funding24 * 24 * 365 * 100 : null;
    const coh = TIER.map(([t, n]) => { const c = P.cohorts.find(x => x.tier === t); if (!c || c.L + c.S < 1) return '';
      const b = c.bias, w = Math.min(50, Math.abs(b) * 50), cl = b >= 0 ? COR.up : COR.dn;
      return `<div class="lv-coh"><span>${n}</span><div class="lv-cbar"><i style="${b >= 0 ? 'left:50%' : 'right:50%'};width:${w}%;background:${cl}"></i></div><span style="color:${cl};text-align:right">${b >= 0 ? 'comprado' : 'vendido'} ${Math.round(Math.abs(b) * 100)}%</span></div>`; }).join('');
    el.innerHTML = `<div class="box-head"><h2>Quem está apertado</h2><span class="small muted">a cada 2 min</span></div>
      <p style="font:800 18px var(--f-display);color:${q.c}">${q.t}</p><p class="small muted">${q.L} sinais contra longs · ${q.S} contra shorts</p>
      ${q.why.length ? `<div class="lv-why">${q.why.map(([s, t]) => `<span class="chip ${s === 'L' ? 'down' : 'up'}">${s === 'L' ? '▼' : '▲'} ${t}</span>`).join('')}</div>` : ''}
      <div class="kpis lv-kp2">
        <div class="kpi"><span class="lab">Funding</span><span class="val">${q.ann != null ? f1(q.ann) + '% a.a.' : '—'}</span><span class="note">${P.funding != null ? (P.funding >= 0 ? 'longs pagam' : 'shorts pagam') : ''}${f24 != null ? ' · 24 h: ' + f1(f24) + '%' : ''}</span></div>
        <div class="kpi"><span class="lab">Open interest</span><span class="val">${P.oiUsd ? fB(P.oiUsd) : '—'}</span><span class="note">1 h ${oc(o.h1)} · 4 h ${oc(o.h4)} · 24 h ${oc(o.h24)}</span></div>
        <div class="kpi"><span class="lab">Contas compradas</span><span class="val">${ls ? Math.round(100 * ls.longAcc / (ls.longAcc + ls.shortAcc)) + '%' : '—'}</span><span class="note">${ls ? ls.longAcc.toLocaleString('pt-BR') + ' × ' + ls.shortAcc.toLocaleString('pt-BR') : ''}</span></div>
        <div class="kpi"><span class="lab">PnL aberto</span><span class="val" style="color:${ls && ls.longPnl < 0 ? COR.dn : COR.up}">L ${ls && ls.longPnl != null ? sgn(ls.longPnl) : '—'}</span><span class="note" style="color:${ls && ls.shortPnl < 0 ? COR.dn : COR.up}">S ${ls && ls.shortPnl != null ? sgn(ls.shortPnl) : '—'}</span></div>
      </div>
      <h3 style="margin-top:10px">Posição por grupo de traders</h3>${coh}
      <p class="small muted" style="margin-top:6px">Funding e OI da Hyperliquid (funding-piso ${k.startsWith('xyz:') ? '5,475' : '10,95'}% a.a. conta como neutro); posições e grupos da Coinversa. Sinais de posicionamento, não previsão.</p>`;
  }
  function renderComo() {
    $('.lv-como').innerHTML = `<div class="box-head"><h2>O que ficou de fora</h2></div><p class="small muted">"Qual lado é capturado primeiro" e "escada/possível cascata" não aparecem aqui: testados no radar em 11/11/2026, o primeiro é só a distância e o segundo aparecia em 99% das zonas, com resultado guiado pela queda do mês. As chances usam o mesmo método do Resumo (excursão histórica ÷ volatilidade), calculadas no seu navegador para este ativo.</p>`;
  }
  /* histórico local para o gráfico: liquidações reais (guardadas por 3 dias neste navegador) e a foto anterior do mapa */
  function guardarLiqs(k) {
    const h = liqHist[k] || (liqHist[k] = (() => { try { return JSON.parse(localStorage.getItem('radar-liqhist-' + k) || '[]'); } catch (e) { return []; } })());
    const chave = e => e.t + '|' + (e.addr || '') + '|' + Math.round(e.usd), ja = new Set(h.map(chave)); let novo = false;
    for (const e of realLiqs(k)) if (e.px != null && e.usd > 0 && !ja.has(chave(e))) { h.push({ t: e.t, px: e.px, usd: e.usd, side: e.side, addr: e.addr, ex: !!e.exact }); novo = true; }
    if (novo) { const lim = Date.now() - 3 * 864e5; liqHist[k] = h.filter(e => e.t >= lim).sort((a, b) => a.t - b.t).slice(-3000);
      try { localStorage.setItem('radar-liqhist-' + k, JSON.stringify(liqHist[k])); } catch (e) {} }
    return liqHist[k];
  }
  function perfilDe(k) {
    const m = mapas[k]; if (!m) return null;
    const p = mapaPrev[k] || (mapaPrev[k] = { cur: null, ant: null });
    if (!p.cur || p.cur.ts !== m.ts) { p.ant = p.cur; p.cur = m; }
    const d = build(m), da = p.ant ? build(p.ant) : null;
    // valor da foto anterior no mesmo preço (as faixas andam com o preço de cada foto, então casa pelo preço, não pela posição)
    const antEm = px => { if (!da) return null; const x = da.L.concat(da.S).find(f => Math.abs(f[0] - px) <= da.bw / 2); return x ? x[1] : 0; };
    const casa = arr => arr.map(x => [x[0], x[1], antEm(x[0])]);
    return { bw: d.bw, L: casa(d.L), S: casa(d.S),
      hora: new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) };
  }
  function planoDe() {
    const A = analyze(); if (!A) return null;
    const op = ['compra', 'venda'].map(l => ({ l, r: avaliar(SEL, A, 'day', l) })).filter(o => o.r.stop && o.r.alvo);
    if (!op.length) return null;
    op.sort((a, b) => (a.r.blocks.length - b.r.blocks.length) || (b.r.sc - a.r.sc));
    const o = op[0]; return { lado: o.l, entrada: A.cur, stop: o.r.stop, alvo: o.r.alvo, rr: o.r.rr, st: o.r.st[0], cor: o.r.st[1], sc: o.r.sc, bloq: o.r.blocks[0] || '' };
  }
  function aoVivo(arr, ms, px) {
    if (!arr || !arr.length || !px) return arr;
    const u = arr[arr.length - 1], agora = Date.now();
    if (agora < u.t + ms) return arr.slice(0, -1).concat({ ...u, c: px, h: Math.max(u.h, px), l: Math.min(u.l, px) });
    const t = u.t + Math.floor((agora - u.t) / ms) * ms;
    return arr.concat({ t, o: u.c, h: Math.max(u.c, px), l: Math.min(u.c, px), c: px, v: 0 });
  }
  function renderGrafico() {
    const box = $('.lv-graf'); if (!box) return;
    const k = SEL, G0 = graf[k], cur = live[k];
    const G = G0 && cur ? { ...G0, c15: aoVivo(G0.c15, 9e5, cur), c1h: aoVivo(G0.c1h, 36e5, cur), c4h: aoVivo(G0.c4h, 144e5, cur), c1d: aoVivo(G0.c1d, 864e5, cur) } : G0;
    box.querySelectorAll('.lv-gtf button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.g === GTF)));
    if (!G || !cur) { if (gSig !== 'x') { $('.lv-gsvg').innerHTML = '<p class="muted small">Buscando as velas…</p>'; $('.lv-gleit').textContent = ''; gSig = 'x'; } return; }
    const ms = { '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 }[GTF] || 9e5, todas = { '15m': G.c15, '1h': G.c1h, '4h': G.c4h, '1d': G.c1d }[GTF] || G.c15, c = todas.slice(-({ '15m': 120, '1h': 96, '4h': 120, '1d': 120 }[GTF] || 120));
    const curto = ms < 864e5, bol = curto ? guardarLiqs(k) : null, perf = perfilDe(k);   // barras em todos os tempos; bolhas até 4 h (o histórico guardado é de 3 dias)
    const pl = vista === 'graf' && CAM.plano ? planoDe() : null, tds = vista === 'graf' && CAM.trades ? diario.trades.filter(t => mesmoAtivo(k, t.ativo) && t.abertura && t.entrada) : null;
    const sig = [k, GTF, G.t, cur, c.length, bol ? bol.length : 0, mapas[k] ? mapas[k].ts : 0, JSON.stringify(CAM), pl ? pl.stop + '/' + pl.alvo + '/' + pl.st : '', diario.t, tds ? tds.length : 0].join('|'); if (sig === gSig) return; gSig = sig;
    const cam = $('.lv-gcam');
    if (cam) cam.innerHTML = '<span class="small muted">Mostrar:</span>' + CAMADAS.map(([c, n]) => `<button type="button" class="chip" data-c="${c}" aria-pressed="${!!CAM[c]}" style="cursor:pointer;font:inherit;font-size:12px;border:1px solid ${CAM[c] ? 'var(--accent)' : 'var(--line)'};background:${CAM[c] ? 'var(--accent-soft)' : 'none'};color:var(--fg)">${CAM[c] ? '✓ ' : ''}${n}</button>`).join('');
    const pe = $('.lv-gplano');
    if (pe) pe.innerHTML = !CAM.plano ? '' : pl ? `<span style="color:${pl.cor};font-weight:700">Meu plano · day trade ${pl.lado} · ${pl.st} ${pl.sc}</span> <span class="muted">(da Trava do roteiro: entrada ~${fpx(pl.entrada)} · stop ${fpx(pl.stop)} · alvo ${fpx(pl.alvo)}${pl.rr != null ? ' · R:R ' + f1(pl.rr) : ''}${pl.bloq ? ' · ⛔ ' + pl.bloq : ''})</span>`
      : '<span class="muted">Meu plano: sem plano agora (a Trava precisa do mapa da Coinversa para achar stop e alvo).</span>';
    const niv = niveisDia(G.c15, mercado), est = estruturaVelas(todas.slice(-200));
    if (GTF === '4h' || GTF === '1d') niv.niveis = niv.niveis.concat(niveisPeriodo(G.c1d));
    // linha do RSI Mestre: os cinco tempos, com as mesmas cores e o mesmo regime da aba RSI Mestre
    const fc = a => (a || []).map(x => x.c), rv = { '15m': rsiWilder(fc(G.c15)), '1h': rsiWilder(fc(G.c1h)), '4h': rsiWilder(fc(G.c4h)), '1d': rsiWilder(fc(G.c1d)), '1w': rsiWilder(fc(agrupar(G.c1d || [], 7 * 864e5))) };
    const rg = regimeRsi(rv['1d']), rr = resumoRsi(Object.values(rv));
    const chip = (k, nome) => { const v = rv[k], f = faixaRsi(v), bg = f.lado < 0 ? 'var(--warn-soft)' : f.lado > 0 ? 'var(--down-soft)' : 'transparent', cor = f.lado < 0 ? 'var(--warn)' : f.lado > 0 ? 'var(--down)' : 'var(--fg)';
      return `<button type="button" ${k !== '1w' ? `data-g="${k}"` : 'disabled'} title="${f.txt}" style="font:inherit;font-size:12.5px;padding:3px 9px;border-radius:6px;cursor:${k !== '1w' ? 'pointer' : 'default'};background:${bg};color:${cor};border:1px solid ${k === GTF ? 'var(--fg)' : 'var(--line)'};${f.nivel === 2 ? 'font-weight:800' : ''}"><span class="muted" style="font-weight:400">${nome}</span> <b class="num">${v == null ? '—' : v.toFixed(1).replace('.', ',')}</b></button>`; };
    const corReg = rg.lado > 0 ? 'var(--up)' : rg.lado < 0 ? 'var(--warn)' : 'var(--muted)';
    $('.lv-grsil').innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:2px 0 8px;padding-left:8px"><span class="small muted">RSI 14 nos 5 tempos</span>${[['15m', '15 min'], ['1h', '1H'], ['4h', '4H'], ['1d', 'Dia'], ['1w', 'Semana']].map(([k, n]) => chip(k, n)).join('')}` +
      `<span style="font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;border:1px solid ${corReg};color:${corReg}">${rg.t}</span><span class="small muted">${rr.txt}</span></div>`;
    // suporte e resistência mais próximos: níveis de ontem/semana/mês, topos e fundos, zonas de liquidação e a maior parede do livro
    let sr = null;
    if (CAM.sr && est) {
      const F = niveisDia(G.c15, mercado).niveis.filter(n => ['PDH', 'PDL', 'MXD', 'MND'].includes(n.id)).map(n => ({ p: n.preco, nome: n.rot }))
        .concat(niveisPeriodo(G.c1d).map(n => ({ p: n.preco, nome: n.rot })))
        .concat(est.pivos.slice(-30).map(x => ({ p: x.p, nome: (x.tipo === 'H' ? 'topo ' : 'fundo ') + (x.r || '') + ' (' + GTF + ')' })));
      const A = analyze();
      if (A && A.zn) { if (A.zn.ap) F.push({ p: A.zn.ap.a[0], nome: `liquidações de longs ${fm(A.zn.ap.a[1])}` }); if (A.zn.ve) F.push({ p: A.zn.ve.a[0], nome: `liquidações de shorts ${fm(A.zn.ve.a[1])}` }); }
      const bk = book[k]; if (bk && Date.now() - bk.t < 30000) { const mx = a => a.reduce((x, y) => y.usd > x.usd ? y : x, a[0]); if (bk.bids.length) { const w = mx(bk.bids); F.push({ p: w.px, nome: `parede de compra ${fm(w.usd)}` }); } if (bk.asks.length) { const w = mx(bk.asks); F.push({ p: w.px, nome: `parede de venda ${fm(w.usd)}` }); } }
      sr = zonasSR(cur, F, est.atr);
    }
    const fech = todas.map(x => x.c), rsTodo = rsiSerie(fech);
    const rsMed = CAM.rsima ? rsTodo.map((v, i) => { if (i < 13) return null; const j = rsTodo.slice(i - 13, i + 1); return j.some(x => x == null) ? null : j.reduce((a, b) => a + b, 0) / 14; }).slice(-c.length) : null;
    const rsNiv = [70, 50, 30].map(v => ({ v, p: precoParaRsi(fech, v) }));
    const rs = rsTodo.slice(-c.length), rd = G.c1d && G.c1d.length > 20 ? rsiSerie(G.c1d.map(x => x.c)).pop() : null;
    const { svg, fora } = graficoSvg({ candles: c, niv: CAM.niv ? niv : null, est: CAM.est ? est : null, preco: cur, ms, perfil: CAM.liq ? perf : null, bolhas: CAM.bol ? bol : null,
      rsi: CAM.rsi ? rs : null, rsiMedia: CAM.rsi ? rsMed : null, rsiNiveis: rsNiv, regimeDia: CAM.rsi && rd != null ? { ...regimeRsi(rd), v: rd } : null, plano: pl, trades: tds, sr });
    $('.lv-gsvg').innerHTML = svg;
    $('.lv-gleit').textContent = leituraGrafico(est, niv, cur, fpx);
    $('.lv-gnota').textContent = (curto ? '' : 'No Diário não há bolhas (o histórico guardado é de só 3 dias). ') + (curto ? `Bolhas = liquidações reais (laranja = long liquidado, azul = short liquidado; tamanho = valor; passe o mouse para ver), guardadas neste navegador desde que a página abre (${bol ? bol.length : 0} até agora; a fonte entrega só os últimos ~200 registros, então numa rajada cobre poucos segundos). Contorno cheio = preço e lado exatos; tracejado = estimados pelo movimento do minuto. ` : '') + 'Barras à direita = liquidez em risco por preço (Coinversa, a cada 60 s); o contorno tracejado é a foto anterior: barra menor que o contorno = liquidez consumida. ' + (mapas[k] ? '' : 'Sem bolhas e sem barras agora: falta a senha do radar no topo da página (o mapa e as liquidações vêm da Coinversa). ') + `Níveis: ${mercado === 'acoes' ? 'sessão de NY (9:30–16:00)' : 'dia em UTC'}. VWAP e abertura contam desde o início da sessão. ` +
      (fora.length ? `Fora da vista: ${fora.map(n => n.rot + ' ' + fpx(n.preco)).join(', ')}. ` : '') +
      'Estrutura: pivôs de 2 velas (HH/HL = topo/fundo mais alto, LH/LL = mais baixo); BOS = continuação, CHoCH = quebra contra a tendência. Medido em BTC, ETH e SOL (15 min, 1 h, 4 h e diário) e em ações (diário): nenhum desses sinais deu ganho firme depois dos custos, e vários foram piores que entrar sem sinal. Uma pista no diário de cripto (fechar abaixo da mínima do mês passado) não se repetiu em 30 ações dos EUA (15 anos). É mapa de contexto, não gatilho (estudo em estudos/niveis_estrutura).';
  }
  function render() {
    renderTabs();
    if (vista === 'graf') { renderBar(analyze()); renderGrafico(); return; }
    const A = analyze();
    renderBar(A);
    const err = erros.senha ? 'Digite a senha do radar no topo da página para ver o mapa da Coinversa.' : erros['mapa' + SEL] ? `Sem mapa agora: ${erros['mapa' + SEL]}` : '';
    $('.lv-erro').hidden = !err; $('.lv-erro').textContent = err;
    if (!A) { $('.lv-top').innerHTML = `<p class="muted">${err || 'carregando o mapa…'}</p>`; return; }
    renderTop(A); renderChart(A); renderCards(A); renderLiqs(); renderRot(A); renderPress(); renderComo();
  }

  // eventos
  raiz.addEventListener('click', e => {
    const t = e.target.closest('.lv-tab'); if (t) { SEL = t.dataset.k; ls('sel', SEL); hov = null; trocar(); return; }
    const r = e.target.closest('[data-r]'); if (r) { const k = r.dataset.r; rOpen.has(k) ? rOpen.delete(k) : rOpen.add(k); render(); return; }
    const sm = e.target.closest('.lv-som');
    if (sm) { const on = !SOM; setSom(on); if (on) { bip(); try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (er) {} } return; }
    const m = e.target.closest('.lv-mode button'); if (m) { setModo(m.dataset.m); return; }
    const z = e.target.closest('.lv-zoom button'); if (z) { setZoom(+z.dataset.z); render(); return; }
    if (e.target.closest('.lv-grsi')) { if (typeof window.show === 'function') window.show('rsi'); window.scrollTo(0, 0); return; }
    if (e.target.closest('.lv-irgraf')) { if (typeof window.show === 'function') window.show(mercado === 'acoes' ? 'a-grafico' : 'grafico'); window.scrollTo(0, 0); return; }
    const cm = e.target.closest('.lv-gcam button'); if (cm) { CAM[cm.dataset.c] = !CAM[cm.dataset.c]; ls('gcam', JSON.stringify(CAM)); gSig = ''; renderGrafico(); return; }
    const g = e.target.closest('.lv-gtf button, .lv-grsil button[data-g]'); if (g) { GTF = g.dataset.g; ls('gtf', GTF); gSig = ''; renderGrafico(); }
  });
  const svg = $('.lv-svg') || document.createElement('div');   // a aba Gráfico não tem o mapa
  svg.addEventListener('mousemove', e => { mx0 = e.clientX; my0 = e.clientY; const t = e.target.closest('[data-k]');
    if (!t) { if (hov) { hov = null; $('.lv-tip').style.display = 'none'; } return; } const k = t.getAttribute('data-k'); if (k !== hov) { hov = k; render(); } else tipFor(k); });
  svg.addEventListener('mouseleave', () => { hov = null; $('.lv-tip').style.display = 'none'; });

  // carregamento do ativo escolhido
  async function trocar() {
    render();
    const k = SEL;
    await Promise.all([buscar('mapa', k, mapas), carregarMinuto(k), carregarChance(k).catch(() => {})]);
    render();
    buscar('liqs', k, liqs).then(render); buscar('press', k, press).then(render);
    carregarGrafico(k).then(render);
    if (vista === 'graf') carregarDiario().then(render);
    carregarCandles(k, ['15m', '4h']).then(() => { render(); carregarCandles(k, ['1d', '1w']).then(render); });
    if (live[k]) carregarLivro(k, live[k]).then(render);
  }
  setSom(SOM);
  let MEDO = null, VIX = null;
  const ctx = () => (mercado === 'cripto' ? medo().then(m => { MEDO = m; }) : vix().then(m => { VIX = m; }));
  ctx(); setInterval(ctx, 900e3);
  // a tela RSI Mestre abre o ativo clicado aqui
  window.addEventListener('radar-abrir-ativo', ev => { const d = ev.detail || {}; if (d.mercado !== mercado || !d.coin) return;
    if (!lista.includes(d.coin)) lista = [d.coin, ...lista].slice(0, 12);
    SEL = d.coin; ls('sel', SEL); hov = null; trocar(); });
  function vigiar() { const A = analyze(); if (!A) return; renderBar(A); calcAlertas(A); }   // sem desenhar nada: só confere os avisos
  // laços: com a aba aberta e a janela visível desenham tudo; com o aviso ligado continuam em segundo plano só vigiando
  let n = 0;
  setInterval(() => {
    const vis = visivel(); if (!vis && !SOM) return; n++;
    const k = SEL;
    if (n % 60 === 0) buscar('mapa', k, mapas).then(render);
    if (n % 30 === 0) buscar('liqs', k, liqs);
    if (n % 120 === 0) buscar('press', k, press);
    if (n % 180 === 0) carregarCandles(k, ['15m']);
    if (n % 60 === 0) carregarGrafico(k);
    if (vista === 'graf' && n % 60 === 0) carregarDiario();
    if (n % 3 === 0 && live[k]) carregarLivro(k, live[k]);
    if (vis) render(); else vigiar();
  }, 1000);
  window.addEventListener('radar-acoes', ev => { if (mercado === 'acoes' && ev.detail && ev.detail.length) { lista = ev.detail.slice(0, 12); if (!lista.includes(SEL)) SEL = lista[0]; render(); } });
  function sincronizar() { const s = ls('sel'); if (s && s !== SEL) { if (!lista.includes(s)) lista = [s, ...lista].slice(0, 12); SEL = s; hov = null; trocar(); } else render(); }
  return { iniciar: trocar, sincronizar, ativo: () => visivel() || SOM };
}

/* ---------- estilo (usa as cores do radar; claro e escuro) ---------- */
const css = document.createElement('style');
css.textContent = `
:root{--lv-long:#e0822e;--lv-short:#3b7ddd}
.lv-bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:8px 12px;margin-bottom:10px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}
.lv-an{font:800 18px var(--f-display)}.lv-px{font-size:19px;font-weight:700;transition:color .2s}
.lv-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.lv-tab{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;padding:4px 11px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--fg);cursor:pointer}
.lv-dot{width:8px;height:8px;border-radius:50%;flex:none}
.lv-tab[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft)}
.lv-erro{padding:8px 12px;border-radius:var(--r);background:var(--warn-soft);color:var(--warn);margin-bottom:10px}
.lv-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:14px;align-items:start}
.lv-main,.lv-side{display:grid;gap:14px}
@media (max-width:1000px){.lv-grid{grid-template-columns:1fr}}
.lv-lados{font-size:15px;line-height:1.7}
.lv-rsi{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}
.lv-rt{background:var(--surface-2);border-radius:8px;padding:6px 9px;display:grid;gap:3px}
.lv-rt b{font-size:17px}
.lv-gauge{position:relative;height:5px;border-radius:3px;background:linear-gradient(90deg,var(--warn-soft) 0 30%,var(--line) 30% 70%,var(--down-soft) 70% 100%)}
.lv-gauge i{position:absolute;top:-3px;width:11px;height:11px;border-radius:50%;background:var(--fg);border:2px solid var(--surface-2);transform:translateX(-50%)}
.lv-alerts{display:flex;flex-direction:column;gap:6px;margin-top:10px}.lv-alerts .chip{white-space:normal;justify-content:flex-start;border-radius:8px;padding:6px 10px;font-size:13px}
.lv-chart{position:relative}
.lv-tip{position:absolute;pointer-events:none;display:none;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12.5px;line-height:1.55;white-space:nowrap;z-index:6;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.lv-cards{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.lv-rng{font:700 20px var(--f-mono);margin:4px 0}
.lv-row{display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding-top:7px;margin-top:7px;font-size:13px}
.lv-rrow{display:grid;grid-template-columns:1fr 40px 100px;gap:4px 6px;align-items:center;padding:8px 10px;border-radius:8px;background:var(--surface-2);border:1px solid;margin-top:6px;cursor:pointer}
.lv-rrow ul{margin:4px 0 0;padding-left:16px}
.lv-why{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}.lv-why .chip{white-space:normal}
.lv-kp2{grid-template-columns:1fr 1fr!important}
.lv-coh{display:grid;grid-template-columns:120px 1fr 110px;gap:8px;align-items:center;font-size:12px;padding:2px 0}
.lv-cbar{position:relative;height:9px;background:var(--surface-2);border-radius:5px}
.lv-cbar:before{content:"";position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--faint)}
.lv-cbar i{position:absolute;top:0;bottom:0;border-radius:5px}
.lv-zcs{display:grid;grid-template-columns:1fr 1fr 1.25fr;gap:10px}
.lv-zrsi .lv-rsi{grid-template-columns:1fr 1fr;gap:6px;margin-top:4px}.lv-zrsi .lv-rt{padding:4px 8px}.lv-zrsi .lv-rt b{font-size:15px}
@media (max-width:900px){.lv-zcs{grid-template-columns:1fr 1fr}.lv-zrsi{grid-column:1/-1}.lv-zrsi .lv-rsi{grid-template-columns:repeat(4,1fr)}}
.lv-zc{display:grid;gap:2px;padding:10px 12px;border:1px solid var(--line);border-left-width:3px;border-radius:8px;background:var(--surface-2)}
.lv-zd{font:800 22px var(--f-display)}
.lv-lados:empty{display:none}.lv-lados{margin-top:6px}
.lv-gatb{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;padding:7px 10px;border:1px solid;border-radius:8px;background:var(--surface-2);font-size:13px;margin-top:6px}
.lv-gatf{color:var(--fg)}
@media (max-width:600px){.lv-zcs{grid-template-columns:1fr}}
.lv-som{cursor:pointer;font:inherit;font-size:12.5px;border:1px solid var(--line);background:var(--surface-2);color:var(--fg)}.lv-som[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft)}
.lv-ess .lv-full{display:none!important}`;
document.head.appendChild(css);

/* ---------- montagem: cada painel monta quando é aberto pela primeira vez ---------- */
const apps = {};
for (const [mercado, id, raizId, vista] of [['cripto', 'p-aovivo', 'lvCripto', 'liq'], ['acoes', 'p-a-aovivo', 'lvAcoes', 'liq'], ['cripto', 'p-grafico', 'gfCripto', 'graf'], ['acoes', 'p-a-grafico', 'gfAcoes', 'graf']]) {
  const painel = document.getElementById(id), raiz = document.getElementById(raizId), chave = mercado + '-' + vista;
  if (!painel || !raiz) continue;
  const montar = () => { if (painel.hidden) return; if (!apps[chave]) { apps[chave] = criarApp(mercado, painel, raiz, vista); apps[chave].iniciar(); } else apps[chave].sincronizar(); };
  montar();
  new MutationObserver(montar).observe(painel, { attributes: true, attributeFilter: ['hidden'] });
}
// preço ao vivo (1 s) só enquanto uma das abas estiver aberta
setInterval(() => { if (Object.values(apps).some(a => a.ativo())) poll(); }, 1000);
poll();
