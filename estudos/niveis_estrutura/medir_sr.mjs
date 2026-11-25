// Suporte/resistência por confluência: uma faixa onde vários níveis coincidem "segura" o preço mais que um preço qualquer?
// Fontes (só preço, sem olhar o futuro): máx./mín. de ontem, da semana passada e do mês passado + topos/fundos (pivôs de 2 velas).
// Evento: o preço vem de cima (fechamento anterior a mais de 0,5 ATR da faixa) e a mínima encosta na faixa (suporte); o contrário p/ resistência.
// Resultado: "segurou" = depois do toque o preço vai 1,5 ATR para longe da faixa antes de FECHAR 0,5 ATR além dela, em até 24 velas.
// Controle: o mesmo teste numa faixa falsa, deslocada 0,7 a 1,5 ATR da verdadeira e sem nenhum nível a menos de 0,3 ATR.
// Uso: node medir_sr.mjs 1h | 4h      (velas em cache: 1h_*.json / 4h_*.json, criadas pelo medir_tf.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TF = process.argv[2] || '1h', ATIVOS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TOL = 0.3, TOQUE = 0.1, LONGE = 1.5, QUEBRA = 0.5, MAXB = 24, APROX = 0.5;
const diaK = t => Math.floor(t / 864e5), semK = t => Math.floor((t - 4 * 864e5) / (7 * 864e5)), mesK = t => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

let semente = 7; const rnd = () => (semente = (semente * 16807) % 2147483647) / 2147483647;   // aleatório repetível

function atrSerie(c) {
  const tr = c.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)) : x.h - x.l), a = Array(c.length).fill(null);
  let s = 0; for (let i = 0; i < c.length; i++) { s += tr[i]; if (i >= 14) s -= tr[i - 14]; if (i >= 13) a[i] = s / 14; }
  return a;
}

// níveis conhecidos no fechamento de cada vela i (sem olhar o futuro)
function niveisPorVela(c) {
  const out = Array(c.length), per = [['D', diaK], ['W', semK], ['M', mesK]].map(([id, k]) => ({ id, k, chave: null, mx: -Infinity, mn: Infinity, ph: null, pl: null }));
  const piv = [];
  for (let i = 0; i < c.length; i++) {
    for (const p of per) { const k = p.k(c[i].t); if (k !== p.chave) { if (p.chave !== null) { p.ph = p.mx; p.pl = p.mn; } p.chave = k; p.mx = -Infinity; p.mn = Infinity; } p.mx = Math.max(p.mx, c[i].h); p.mn = Math.min(p.mn, c[i].l); }
    const j = i - 2;   // pivô de 2 velas confirmado agora
    if (j >= 2) {
      if (c[j].h > c[j - 1].h && c[j].h > c[j - 2].h && c[j].h >= c[j + 1].h && c[j].h >= c[j + 2].h) piv.push({ p: c[j].h, i: j, tipo: 'pivô topo' });
      if (c[j].l < c[j - 1].l && c[j].l < c[j - 2].l && c[j].l <= c[j + 1].l && c[j].l <= c[j + 2].l) piv.push({ p: c[j].l, i: j, tipo: 'pivô fundo' });
      while (piv.length > 40) piv.shift();
    }
    const L = [];
    for (const p of per) if (p.ph != null) L.push({ p: p.ph, tipo: 'máx ' + p.id }, { p: p.pl, tipo: 'mín ' + p.id });
    for (const x of piv) L.push(x);
    out[i] = L;
  }
  return out;
}

// faixa mais próxima de um lado: o nível mais perto + quantos níveis caem a menos de TOL ATR dele
function faixa(L, px, atr, lado) {
  const cand = L.filter(x => lado < 0 ? x.p < px : x.p > px).sort((a, b) => lado < 0 ? b.p - a.p : a.p - b.p);
  if (!cand.length) return null;
  const z = cand[0].p, junto = L.filter(x => Math.abs(x.p - z) <= TOL * atr);
  return { z, n: junto.length, tipos: [...new Set(junto.map(x => x.tipo.split(' ')[0] + ' ' + x.tipo.split(' ')[1]))] };
}

// depois de tocar a faixa z na vela i, o preço segurou? lado -1 = suporte (vindo de cima)
function segurou(c, i, z, atr, lado) {
  for (let j = i; j < Math.min(c.length, i + MAXB); j++) {
    const quebrou = lado < 0 ? c[j].c < z - QUEBRA * atr : c[j].c > z + QUEBRA * atr;
    if (quebrou) return 0;
    const longe = lado < 0 ? c[j].h >= z + LONGE * atr : c[j].l <= z - LONGE * atr;
    if (longe) return 1;
  }
  return null;   // não decidiu: fica de fora
}

const res = {}, add = (k, v, t) => { (res[k] || (res[k] = [])).push({ v, t }); };
const meio = Date.UTC(2023, 9, 1);
for (const a of ATIVOS) {
  const f = `${DIR}/${TF}_${a}.json`; if (!fs.existsSync(f)) { console.log('sem', f); continue; }
  const c = JSON.parse(fs.readFileSync(f, 'utf8')), atr = atrSerie(c), N = niveisPorVela(c);
  for (let i = 300; i < c.length - MAXB; i++) {
    const at = atr[i - 1]; if (!at) continue;
    for (const lado of [-1, 1]) {
      const fx = faixa(N[i - 1], c[i - 1].c, at, lado); if (!fx) continue;
      const vindo = lado < 0 ? c[i - 1].c > fx.z + APROX * at : c[i - 1].c < fx.z - APROX * at;
      const toca = lado < 0 ? c[i].l <= fx.z + TOQUE * at : c[i].h >= fx.z - TOQUE * at;
      if (vindo && toca) {
        const s = segurou(c, i, fx.z, at, lado);
        const mb = Math.abs(c[i - 1].c - fx.z) / at, bk = mb < 1 ? 'a 0,5-1 ATR' : mb < 1.5 ? 'b 1-1,5 ATR' : mb < 2.5 ? 'c 1,5-2,5 ATR' : 'd 2,5+ ATR';
        if (s != null) { add(`DIST ${bk} · real`, s, c[i].t); add(`DIST ${bk} · real · ${fx.n >= 4 ? '4+' : fx.n >= 2 ? '2-3' : '1'} nível(is)`, s, c[i].t); }
        if (s != null) { add(`${lado < 0 ? 'suporte' : 'resistência'} · ${fx.n >= 4 ? '4+' : fx.n} nível(is)`, s, c[i].t); add(`todos · ${fx.n >= 4 ? '4+' : fx.n >= 2 ? '2-3' : '1'}`, s, c[i].t); add(`ativo ${a.slice(0, 3)} · ${fx.n >= 2 ? 'confluência (2+)' : 'nível único'}`, s, c[i].t); }
      }
      // controle: faixa falsa perto da verdadeira, longe de qualquer nível
      const off = (0.7 + rnd() * 0.8) * at * (rnd() < 0.5 ? -1 : 1), zf = fx.z + off;
      if (process.env.SEM_FILTRO !== '1' && N[i - 1].some(x => Math.abs(x.p - zf) <= TOL * at)) continue;   // SEM_FILTRO=1: controle sem a exclusão
      if (lado < 0 ? !(zf < c[i - 1].c) : !(zf > c[i - 1].c)) continue;
      const vf = lado < 0 ? c[i - 1].c > zf + APROX * at : c[i - 1].c < zf - APROX * at, tf = lado < 0 ? c[i].l <= zf + TOQUE * at : c[i].h >= zf - TOQUE * at;
      if (vf && tf) { const s = segurou(c, i, zf, at, lado), mf = Math.abs(c[i - 1].c - zf) / at, bf = mf < 1 ? 'a 0,5-1 ATR' : mf < 1.5 ? 'b 1-1,5 ATR' : mf < 2.5 ? 'c 1,5-2,5 ATR' : 'd 2,5+ ATR'; if (s != null) add(`DIST ${bf} · controle`, s, c[i].t); if (s != null) { add(`CONTROLE (preço qualquer) · ${lado < 0 ? 'suporte' : 'resistência'}`, s, c[i].t); add('todos · CONTROLE', s, c[i].t); } }
    }
  }
}
const pct = l => (l.reduce((t, x) => t + x.v, 0) / l.length * 100);
const ctl = res['todos · CONTROLE'], pc = ctl ? pct(ctl) / 100 : 0;
console.log(`S/R POR CONFLUÊNCIA · ${TF} · BTC, ETH, SOL · segurou = ir ${LONGE} ATR para longe antes de fechar ${QUEBRA} ATR além (até ${MAXB} velas)`);
console.log('GRUPO'.padEnd(46), 'n'.padStart(6), 'segurou'.padStart(8), 'vs controle'.padStart(12), 'z'.padStart(6), '| 1ª metade  2ª metade');
for (const k of Object.keys(res).sort()) {
  const l = res[k], p = pct(l) / 100, z = (p - pc) / Math.sqrt(pc * (1 - pc) / l.length + pc * (1 - pc) / ctl.length);
  const h = f => { const x = l.filter(f); return x.length ? pct(x).toFixed(1) + '%' : '—'; };
  console.log(k.padEnd(46), String(l.length).padStart(6), (p * 100).toFixed(1).padStart(7) + '%', ((p - pc) * 100 >= 0 ? '+' : '') + ((p - pc) * 100).toFixed(1).padStart(10) + ' pts', z.toFixed(1).padStart(6), '|', h(x => x.t < meio).padEnd(10), h(x => x.t >= meio));
}
