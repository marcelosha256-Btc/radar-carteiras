// Medição dos sinais de níveis do dia e estrutura (web/grafico/calc.js) em 15 min: BTC, ETH, SOL (Binance spot, desde 2024).
// Entrada na abertura da vela seguinte ao sinal; stop 1 ATR, alvo 1,5 ATR, no máximo 32 velas (8 h); custo 0,10% ida e volta.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estrutura, atrAbs } from '../../web/grafico/calc.js';

const SCR = path.dirname(fileURLToPath(import.meta.url));   // o cache das velas (m15_*.json) fica ao lado do script
const ATIVOS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], M15 = 9e5, DIA = 864e5;
const CUSTO = 0.001; let STOP = 1, ALVO = 1.5, MAXB = 32;

async function baixar(sim) {
  const f = `${SCR}/m15_${sim}.json`;
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const out = []; let t = Date.UTC(2024, 0, 1);
  for (;;) {
    const r = await (await fetch(`https://api.binance.com/api/v3/klines?symbol=${sim}&interval=15m&startTime=${t}&limit=1000`)).json();
    if (!Array.isArray(r) || !r.length) break;
    r.forEach(k => out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    if (r.length < 1000) break; t = r[r.length - 1][0] + 1;
  }
  const v = out.filter(x => x.t + M15 <= Date.now());
  fs.writeFileSync(f, JSON.stringify(v)); return v;
}

// ATR(14) causal por vela (média móvel simples do true range)
function atrSerie(c) {
  const tr = c.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)) : x.h - x.l), a = Array(c.length).fill(null);
  let s = 0; for (let i = 0; i < c.length; i++) { s += tr[i]; if (i >= 14) s -= tr[i - 14]; if (i >= 13) a[i] = s / 14; }
  return a;
}

// simula uma entrada na abertura da vela i+1; devolve R líquido (stop/alvo em ATR)
function simular(c, i, dir, atr) {
  const e = c[i + 1].o, R = atr * STOP, stop = e - dir * R, alvo = e + dir * ALVO * R;
  for (let j = i + 1; j <= Math.min(c.length - 1, i + MAXB); j++) {
    const hitS = dir > 0 ? c[j].l <= stop : c[j].h >= stop, hitA = dir > 0 ? c[j].h >= alvo : c[j].l <= alvo;
    if (hitS) return { r: -1 - CUSTO * e / R, fim: j };           // empate na mesma vela: conta o stop (pior caso)
    if (hitA) return { r: ALVO / STOP - CUSTO * e / R, fim: j };
  }
  const fim = Math.min(c.length - 1, i + MAXB); return { r: dir * (c[fim].c - e) / R - CUSTO * e / R, fim };
}

// gera os sinais de uma série: { i, dir, sig }
function sinais(c) {
  const out = [], atr = atrSerie(c);
  let dia = null, aberto = 0, tp = 0, vol = 0, pdh = null, pdl = null, mxd = -Infinity, mnd = Infinity, rompeuH = false, rompeuL = false, vwapPrev = null;
  let ultQuebraT = null, retesteVisto = new Set();
  for (let i = 0; i < c.length - 1; i++) {
    const d = new Date(c[i].t).toISOString().slice(0, 10);
    if (d !== dia) {   // novo dia UTC: guarda ontem
      if (dia !== null) { pdh = mxd; pdl = mnd; }
      dia = d; tp = 0; vol = 0; mxd = -Infinity; mnd = Infinity; rompeuH = false; rompeuL = false; vwapPrev = null;
    }
    mxd = Math.max(mxd, c[i].h); mnd = Math.min(mnd, c[i].l);
    tp += (c[i].h + c[i].l + c[i].c) / 3 * c[i].v; vol += c[i].v;
    const vwap = vol > 0 ? tp / vol : c[i].c, barras = ((c[i].t % DIA) / M15) | 0;
    if (i < 250 || atr[i] == null || pdh == null || barras < 8) { vwapPrev = vwap; continue; }
    const px = c[i].c, push = (dir, sig) => out.push({ i, dir, sig });
    // VWAP: estar acima/abaixo (a cada vela nova que cruza) e cruzamento
    const acima = px > vwap, antes = i > 0 ? c[i - 1].c > (vwapPrev ?? vwap) : acima;
    if (acima && !antes) { push(1, 'VWAP: fechou acima (cruzou p/ cima)'); }
    if (!acima && antes) { push(-1, 'VWAP: fechou abaixo (cruzou p/ baixo)'); }
    // ontem: rompimento da máxima/mínima de ontem (1ª vez no dia) e rompimento falso (varreu e voltou)
    if (!rompeuH && px > pdh) { rompeuH = true; push(1, 'Rompeu máx. de ontem (fechou acima)'); }
    if (!rompeuL && px < pdl) { rompeuL = true; push(-1, 'Rompeu mín. de ontem (fechou abaixo)'); }
    if (c[i].h > pdh && px < pdh && c[i - 1].c <= pdh * 1.0005 && !rompeuH) push(-1, 'Varreu máx. de ontem e voltou (vende)');
    if (c[i].l < pdl && px > pdl && c[i - 1].c >= pdl * 0.9995 && !rompeuL) push(1, 'Varreu mín. de ontem e voltou (compra)');
    // estrutura: eventos novos nesta vela
    const jan = c.slice(i - 199, i + 1), e = estrutura(jan);
    const q = e.quebra;
    if (q && q.j === jan.length - 1) push(q.sobe ? 1 : -1, `${q.tipo} ${q.sobe ? 'p/ cima' : 'p/ baixo'}`);
    if (q && e.reteste && e.reteste.estado === 'confirmado') {
      const chave = q.t + '|' + q.nivel;
      if (!retesteVisto.has(chave)) { retesteVisto.add(chave); push(q.sobe ? 1 : -1, `Reteste confirmado depois de ${q.tipo} ${q.sobe ? 'p/ cima' : 'p/ baixo'}`);
        if (q.sobe === acima) push(q.sobe ? 1 : -1, `Reteste confirmado + lado certo da VWAP`); }
    }
    vwapPrev = vwap;
  }
  return { out, atr };
}

// aplica um conjunto de sinais, uma operação por vez; devolve lista de R
function operar(c, atr, lista) {
  const rs = []; let livre = 0;
  for (const s of lista) { if (s.i < livre) continue; const r = simular(c, s.i, s.dir, atr[s.i]); rs.push({ r: r.r, i: s.i, t: c[s.i].t, dir: s.dir, cr: CUSTO * c[s.i + 1].o / (atr[s.i] * STOP) }); livre = r.fim + 1; }
  return rs;
}
const stat = rs => { const n = rs.length; if (!n) return { n: 0 }; const m = rs.reduce((t, x) => t + x.r, 0) / n, w = rs.filter(x => x.r > 0).length / n;
  const sd = Math.sqrt(rs.reduce((t, x) => t + (x.r - m) ** 2, 0) / Math.max(1, n - 1)); return { n, m, w, se: sd / Math.sqrt(n), t: m / (sd / Math.sqrt(n) || 1) }; };
const f2 = v => (v >= 0 ? '+' : '') + v.toFixed(3);

const dados = {};
for (const a of ATIVOS) { dados[a] = await baixar(a); }
console.log('velas:', Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, v.length + ' (' + new Date(v[0].t).toISOString().slice(0, 10) + ' a ' + new Date(v[v.length - 1].t).toISOString().slice(0, 10) + ')'])));


const meio = Date.UTC(2025, 6, 1);
const pre = {};   // sinais por ativo (independem da configuração)
for (const a of ATIVOS) { const c = dados[a], { out, atr } = sinais(c); pre[a] = { c, out, atr }; }
const curta = sig => /p\/ baixo|abaixo|vende/.test(sig) ? -1 : 1;
function rodar(rot, stop, alvo, maxb) {
  STOP = stop; ALVO = alvo; MAXB = maxb;
  const base = { 1: [], '-1': [] }, todos = {};
  for (const a of ATIVOS) {
    const { c, out, atr } = pre[a];
    for (const dir of [1, -1]) { const l = []; for (let i = 300; i < c.length - maxb - 8; i += 8) if (atr[i]) l.push({ i, dir }); base[dir].push(...operar(c, atr, l)); }
    const por = {}; out.forEach(x => (por[x.sig] || (por[x.sig] = [])).push(x));
    for (const [sig, l] of Object.entries(por)) (todos[sig] || (todos[sig] = [])).push(...operar(c, atr, l).map(x => ({ ...x, a })));
  }
  const B = { 1: stat(base[1]), '-1': stat(base[-1]) };
  console.log(`
=== ${rot}: stop ${stop} ATR, alvo ${alvo} ATR, até ${maxb} velas, custo ${CUSTO * 100}% ida e volta ===`);
  console.log(`base sem sinal: compra n=${B[1].n} líquida ${f2(B[1].m)}R (bruta ${f2(B[1].m + base[1].reduce((t, x) => t + x.cr, 0) / base[1].length)}R) · venda n=${B[-1].n} líquida ${f2(B[-1].m)}R (bruta ${f2(B[-1].m + base[-1].reduce((t, x) => t + x.cr, 0) / base[-1].length)}R) · custo médio ${(base[1].reduce((t, x) => t + x.cr, 0) / base[1].length).toFixed(3)}R`);
  console.log('SINAL'.padEnd(52), 'n'.padStart(5), 'líq.R'.padStart(7), 'bruta'.padStart(7), 'vs base'.padStart(8), 't'.padStart(5), '| 1ªmet'.padEnd(9), '2ªmet'.padEnd(9), '| ativos (vs base)');
  const L = [];
  for (const [sig, all] of Object.entries(todos)) {
    const s2 = stat(all); if (s2.n < 40) continue; const d = curta(sig), b = B[d];
    const br = all.reduce((t, x) => t + x.cr, 0) / all.length, diff = s2.m - b.m, t = diff / Math.sqrt(s2.se ** 2 + b.se ** 2);
    const half = f => { const x = stat(all.filter(f)), y = stat(base[d].filter(f)); return x.n ? x.m - y.m : 0; };
    const pa = ATIVOS.map(a => { const x = stat(all.filter(z => z.a === a)), y = stat(base[d].filter((_, i) => true)); return `${a.slice(0, 3)} ${f2(x.m)}`; }).join(' ');
    L.push({ sig, n: s2.n, m: s2.m, br: s2.m + br, diff, t, h1: half(x => x.t < meio), h2: half(x => x.t >= meio), pa });
  }
  L.sort((x, y) => y.diff - x.diff);
  for (const x of L) console.log(x.sig.padEnd(52), String(x.n).padStart(5), f2(x.m).padStart(7), f2(x.br).padStart(7), f2(x.diff).padStart(8), x.t.toFixed(1).padStart(5), '|', f2(x.h1).padEnd(8), f2(x.h2).padEnd(8), '|', x.pa);
}
rodar('A) curto prazo', 1, 1.5, 32);
rodar('B) stop largo (3 ATR de 15 min ≈ 1,5 de 1 h)', 3, 4.5, 96);
rodar('C) stop bem largo (6 ATR ≈ 3 de 1 h, até 2 dias)', 6, 9, 192);
