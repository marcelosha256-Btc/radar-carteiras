import fs from 'node:fs';
// em cada fechamento de 15 min: fluxo agressivo (compra a mercado − venda a mercado) ÷ volume, na última vela e na última hora
// resultado: qual barreira o preço toca primeiro nas próximas 4 h: +1 ATR(15m×4) ou −1 ATR (1 = subiu primeiro). Sem custo.
const res = {}, add = (k, v, t) => (res[k] ||= []).push({ v, t });
const ATIVOS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','NEARUSDT'];
let corte = 0;
for (const a of ATIVOS) {
  const c = JSON.parse(fs.readFileSync(a + '.json')); corte = c[Math.floor(c.length / 2)][0];
  const d = c.map(x => x[4] ? (2 * x[5] - x[4]) / x[4] : 0);
  const tr = c.map((x, i) => i ? Math.max(x[1] - x[2], Math.abs(x[1] - c[i-1][3]), Math.abs(x[2] - c[i-1][3])) : x[1] - x[2]);
  for (let i = 100; i < c.length - 16; i++) {
    let atr = 0; for (let j = i - 13; j <= i; j++) atr += tr[j]; atr = atr / 14 * 2;   // ~ATR de 1 h
    const p = c[i][3]; let r = null;
    for (let j = i + 1; j <= i + 16; j++) { const up = c[j][1] >= p + atr, dn = c[j][2] <= p - atr; if (up && dn) break; if (up) { r = 1; break; } if (dn) { r = 0; break; } }
    if (r == null) continue;
    let q = 0, b = 0; for (let j = i - 3; j <= i; j++) { q += c[j][4]; b += c[j][5]; }
    const d60 = q ? (2 * b - q) / q : 0, d15 = d[i];
    // mover junto: fluxo a favor E preço a favor na última hora vs fluxo contra o preço (divergência)
    const ret60 = c[i][3] / c[i-4][3] - 1;
    const fx = v => v <= -0.10 ? 'a ≤ -10%' : v <= -0.03 ? 'b -10..-3%' : v < 0.03 ? 'c neutro' : v < 0.10 ? 'd +3..+10%' : 'e ≥ +10%';
    add('15m ' + fx(d15), r, c[i][0]); add('1h  ' + fx(d60), r, c[i][0]); add('TODOS', r, c[i][0]);
    add(`diverg ${ret60 > 0.003 ? 'preço↑' : ret60 < -0.003 ? 'preço↓' : 'preço='} fluxo${d60 > 0.05 ? '↑' : d60 < -0.05 ? '↓' : '='}`, r, c[i][0]);
  }
}
const base = res.TODOS, pb = base.reduce((s, x) => s + x.v, 0) / base.length;
console.log('subiu 1 ATR antes de cair 1 ATR (4 h) · base', (pb * 100).toFixed(1) + '%', 'n', base.length);
for (const k of Object.keys(res).sort()) { const l = res[k], p = l.reduce((s, x) => s + x.v, 0) / l.length, z = (p - pb) / Math.sqrt(pb * (1 - pb) / l.length);
  const h = f => { const x = l.filter(f); return (x.reduce((s, y) => s + y.v, 0) / x.length * 100).toFixed(1); };
  console.log(k.padEnd(26), String(l.length).padStart(7), (p * 100).toFixed(1).padStart(6) + '%', ((p - pb) * 100).toFixed(1).padStart(6), 'z', z.toFixed(1).padStart(5), '| 1ª', h(x => x.t < corte), ' 2ª', h(x => x.t >= corte)); }
