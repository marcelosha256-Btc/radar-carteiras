/* Nota de SETUP da Trava do roteiro: cálculo puro (sem tela, sem rede), usado pela página (aovivo.js) e pelo servidor
 * (api/notas.js, gravado a cada 15 min). Uma fonte só: a nota do servidor é exatamente a da tela. Testes: tests/trava.test.mjs. */

export const ROTEIRO = {               // regras do roteiro do Marcelo (ajuste aqui)
  rrMin: 2,                     // R:R mínimo: abaixo disso, BLOQUEADO
  stopBuf: 0.0015,              // stop 0,15% além da zona de liquidação mais próxima
  // as regras do Connors RSI (veto de venda no swing, ETH sem edge, bônus de RSI diário em sobrevenda) saíram em 25/11/2026:
  // o estudo do CRSI não achou vantagem clara contra entrar em qualquer dia do mesmo regime
  liberado: 70, cuidado: 50,
};

/* ---------- formatação ---------- */
export const fm = n => n >= 995000 ? 'US$ ' + (n / 1e6).toFixed(1).replace('.', ',') + ' mi' : 'US$ ' + Math.round(n / 1e3) + ' mil';
export const fB = n => Math.abs(n) >= 1e9 ? 'US$ ' + (Math.abs(n) / 1e9).toFixed(2).replace('.', ',') + ' bi' : fm(Math.abs(n));
export const sgn = n => (n < 0 ? '-' : '+') + fB(n);
export const fpx = n => n >= 1000 ? n.toLocaleString('pt-BR', { maximumFractionDigits: n >= 10000 ? 0 : 1 }) : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 });
export const pc = v => (v > 0 ? '+' : '') + v.toFixed(1).replace('.', ',') + '%';
export const pc2 = v => (v > 0 ? '+' : '') + v.toFixed(2).replace('.', ',') + '%';
export const pp = v => v == null ? '…' : (v < 0.01 ? '<1%' : v > 0.99 ? '>99%' : Math.round(v * 100) + '%');
export const f1 = v => v.toFixed(1).replace('.', ',');

/** mapa da Coinversa (api/liquidez q=mapa) → faixas com preço central e US$ */
export const montarMapa = d => { const lo = d.p * (1 - d.R / 100), w = d.p * 2 * d.R / 100 / d.nb, h = d.nb / 2;
  return { ...d, bw: w, L: d.L.map((v, i) => [lo + (i + 0.5) * w, v * 1e6, d.LP ? d.LP[i] : null]), S: d.S.map((v, i) => [lo + (h + i + 0.5) * w, v * 1e6, d.SP ? d.SP[i] : null]) }; };

export function zones(d, cur) {
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

export function squeeze(k, P, sum1h, cores = { up: 'up', dn: 'dn', mu: 'mu' }) {
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
  const h = sum1h;
  if (h && h.long > 2 * h.short && h.long > 250e3) { L++; why.push(['L', `${fm(h.long)} de longs liquidados em 1 h`]); }
  if (h && h.short > 2 * h.long && h.short > 250e3) { S++; why.push(['S', `${fm(h.short)} de shorts liquidados em 1 h`]); }
  const v = L - S >= 2 ? { t: 'Longs apertados', c: cores.dn } : S - L >= 2 ? { t: 'Shorts apertados', c: cores.up } : { t: 'Sem lado claramente apertado', c: cores.mu };
  return { ...v, L, S, why, ann };
}

export function pivots(arr) {
  if (!arr || arr.length < 8) return null; let hi = null, lo = null;
  for (let i = arr.length - 3; i >= 2 && (hi == null || lo == null); i--) { const x = arr[i];
    if (hi == null && x.h > arr[i - 1].h && x.h > arr[i - 2].h && x.h >= arr[i + 1].h && x.h >= arr[i + 2].h) hi = x.h;
    if (lo == null && x.l < arr[i - 1].l && x.l < arr[i - 2].l && x.l <= arr[i + 1].l && x.l <= arr[i + 2].l) lo = x.l; }
  return { hi, lo };
}

export function estruturaDe(arr, cur, n) {
  const p = pivots(arr); if (!p) return null;
  if (p.hi != null && cur > p.hi) return { s: 1, t: `${n} rompeu o último topo (${fpx(p.hi)})` };
  if (p.lo != null && cur < p.lo) return { s: -1, t: `${n} perdeu o último fundo (${fpx(p.lo)})` };
  return null;
}

export function rsiCalc(cl) {
  if (cl.length < 16) return null;
  let g = 0, l = 0; for (let q = 1; q <= 14; q++) { const ch = cl[q] - cl[q - 1]; if (ch > 0) g += ch; else l -= ch; }
  g /= 14; l /= 14; const out = [], r = () => l === 0 ? 100 : 100 - 100 / (1 + g / l); out.push(r());
  for (let q = 15; q < cl.length; q++) { const ch = cl[q] - cl[q - 1]; g = (g * 13 + Math.max(ch, 0)) / 14; l = (l * 13 + Math.max(-ch, 0)) / 14; out.push(r()); }
  return out;
}

export function rsiAtArr(a, ms, price, agora = Date.now()) {
  if (!a || a.length < 16) return null;
  const cl = a.map(x => x.c), last = a[a.length - 1];
  if (last.t + ms > agora) cl[cl.length - 1] = price; else cl.push(price);
  const r = rsiCalc(cl); return r ? { v: r[r.length - 1], prev: r[r.length - 2] } : null;
}

export function quantis(arr) { const s = [...arr].sort((a, b) => a - b), q = []; for (let i = 0; i <= 100; i++) q.push(s[Math.min(s.length - 1, Math.round(i / 100 * (s.length - 1)))]); return q; }
export function probToque(qs, x) { if (x <= 0) return 1; let lo = 0, hi = qs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (qs[m] < x) lo = m + 1; else hi = m; } return Math.max(0, Math.min(1, 1 - lo / (qs.length - 1))); }

/** Chance de tocar (método do coletor/chance.py): excursão das próximas 4 h/24 h ÷ amplitude média das 24 velas de 1 h anteriores.
 *  c = velas de 1 h {h,l,c} (até 5.000). Devolve { vol, q, conf, n } ou { erro }. */
export function chanceDe(c, agora = Date.now()) {
  if (!c || c.length < 400) return { t: agora, erro: 'pouco histórico' };
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
    let n = 0, hit = 0;
    const x = qa['24'].up[Math.round((1 - alvo) * 100)];
    for (const p of teste) { n += 2; if (p.e24.up >= x) hit++; if (p.e24.dn >= qa['24'].dn[Math.round((1 - alvo) * 100)]) hit++; }
    return { prevista: alvo, tocou: n ? hit / n : null };
  });
  let s = 0; for (let j = amp.length - 24; j < amp.length; j++) s += amp[j];
  return { t: agora, vol: s / 24, q: build(pts), conf, n: pts.length };
}

export function pTouchC(C, level, cur, h) {
  if (!C || !C.q) return null;
  const up = level > cur, d = Math.abs(level / cur - 1);
  return probToque(C.q[String(h)][up ? 'up' : 'dn'], d / C.vol);
}

/** Nota de SETUP da Trava (a camada lenta; ver gatilho.js). Entradas puras, para a página e o servidor darem a mesma nota:
 *  k = moeda; cur = preço; zn = zones(mapa, cur); c15 = variação % dos últimos 15 min; cand = {'15m','4h','1d','1w': velas {t,c,h,l}};
 *  chance = chanceDe(velas 1h); press = "quem está apertado" (api/liquidez q=press); sum1h = liquidações da última hora. */
export function setupNota({ k, cur, zn, c15 = 0, cand = {}, chance = null, press = null, sum1h = null, modo, lado, agora = Date.now() }) {
  const isBuy = lado === 'compra', bw = zn.bw, H = modo === 'day' ? 4 : 24;
  const blocks = [], pros = [], cons = [], faltam = []; let sc = 50;
  const falta = (v, t) => faltam.push([v, t]);
  const add = (v, t) => { sc += v; (v >= 0 ? pros : cons).push((v >= 0 ? '+' : '') + v + ' ' + t); };
  let stop = null, alvo = null;
  if (isBuy) { if (zn.ap) stop = (zn.ap.a[0] - bw / 2) * (1 - ROTEIRO.stopBuf); if (zn.ve) alvo = zn.ve.a[0] - bw / 2; }
  else { if (zn.ve) stop = (zn.ve.a[0] + bw / 2) * (1 + ROTEIRO.stopBuf); if (zn.ap) alvo = zn.ap.a[0] + bw / 2; }
  const rr = stop && alvo ? Math.abs(alvo - cur) / Math.abs(cur - stop) : null;
  if (rr == null) cons.push('sem alvo/stop claros no mapa — R:R não calculável');
  else if (rr < ROTEIRO.rrMin) { const e = (alvo + ROTEIRO.rrMin * stop) / (1 + ROTEIRO.rrMin);
    // não bloqueia o setup: vira preço-limite de entrada, que o gatilho confere ao vivo (como uma ordem limitada no nível)
    cons.push(`R:R ${f1(rr)} no preço do fechamento: entrada só ${isBuy ? 'em' : 'em'} ${fpx(e)} ou ${isBuy ? 'abaixo' : 'acima'} (${pc((e / cur - 1) * 100)})`); }
  else if (rr >= 3) add(15, `R:R ${f1(rr)}:1`); else add(8, `R:R ${f1(rr)}:1`);
  if (alvo && stop) { const pa = pTouchC(chance, alvo, cur, H), ps = pTouchC(chance, stop, cur, H);
    if (pa != null && ps != null) { const df = (pa - ps) * 100;
      if (df >= 10) add(10, `alvo mais provável que o stop em ${H} h (${pp(pa)} × ${pp(ps)})`);
      else if (df <= -10) add(-10, `stop mais provável que o alvo em ${H} h (${pp(ps)} × ${pp(pa)})`);
      if (df < 10 && Math.max(pa, ps) >= 0.05) falta(df <= -10 ? 20 : 10, `alvo ficar mais provável que o stop em ${H} h (hoje ${pp(pa)} × ${pp(ps)})`); } }
  const sL = isBuy ? 1 : -1;
  if (modo === 'day') {
    const e4 = estruturaDe(cand['4h'], cur, '4H'); if (e4) add(10 * e4.s * sL, e4.t);
    if (!e4 || e4.s !== sL) { const pv = pivots(cand['4h']), nv = pv && (isBuy ? pv.hi : pv.lo);
      if (nv != null) falta(e4 ? 20 : 10, `4H ${isBuy ? 'romper o último topo' : 'perder o último fundo'} (${fpx(nv)}, ${pc((nv / cur - 1) * 100)})`); }
    if (Math.abs(c15) >= 0.3) add((c15 > 0 ? 5 : -5) * sL, `15 min ${pc2(c15)}`);
    if (!(c15 * sL >= 0.3)) falta(c15 * sL <= -0.3 ? 10 : 5, `15 min ${isBuy ? 'subindo' : 'caindo'} 0,3% ou mais (hoje ${pc2(c15)})`);
    const r15 = rsiAtArr(cand['15m'], 9e5, cur, agora);
    if (r15 && r15.v <= 30) add(isBuy ? 5 : -5, `RSI 15 min em sobrevenda (${f1(r15.v)})`);
    if (r15 && r15.v >= 70) add(isBuy ? -5 : 5, `RSI 15 min em sobrecompra (${f1(r15.v)})`);
    if (r15 && (isBuy ? r15.v > 30 : r15.v < 70)) falta(5, `RSI 15 min ${isBuy ? 'em sobrevenda (≤30)' : 'em sobrecompra (≥70)'} (hoje ${f1(r15.v)})`);
  } else {
    const eD = estruturaDe(cand['1d'], cur, 'Diário'); if (eD) add(10 * eD.s * sL, eD.t);
    const rD = rsiAtArr(cand['1d'], 864e5, cur, agora), rW = rsiAtArr(cand['1w'], 7 * 864e5, cur, agora);
    if (!isBuy && rD && rD.v >= 70) add(5, `RSI diário em sobrecompra (${f1(rD.v)})`);
    if (rW && rW.v >= 70) add(isBuy ? -5 : 5, `RSI semanal esticado (${f1(rW.v)})`);
  }
  const q = squeeze(k, press, sum1h);
  if (q && q.t === 'Longs apertados') add(isBuy ? -10 : 10, 'longs apertados');
  if (q && q.t === 'Shorts apertados') add(isBuy ? 10 : -10, 'shorts apertados');
  if (!q || q.t !== (isBuy ? 'Shorts apertados' : 'Longs apertados')) falta(q && q.t === (isBuy ? 'Longs apertados' : 'Shorts apertados') ? 20 : 10, `${isBuy ? 'shorts' : 'longs'} ficarem apertados (funding, OI e grupos)`);
  sc = Math.max(0, Math.min(100, Math.round(sc)));
  faltam.sort((x, y) => y[0] - x[0]);
  return { sc, blocks, pros, cons, stop, alvo, rr, faltam };
}
