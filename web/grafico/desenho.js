/* Gráfico de velas em SVG com os níveis do dia, VWAP e a estrutura (pivôs HH/HL/LH/LL, rompimento e reteste).
 * Só desenha o que grafico/calc.js calculou. Cores de alta/baixa vêm das variáveis do tema. */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COR_NIVEL = { PDH: '#d4a72c', PDL: '#d4a72c', PDC: '#9a9a9a', AB: '#378add', ABNY: '#7f77dd', VWAP: '#e67e22', MXD: '#9a9a9a', MND: '#9a9a9a', PWH: '#c0568f', PWL: '#c0568f', PMH: '#1d9e75', PML: '#1d9e75' };
const HALO = 'paint-order:stroke;stroke:var(--surface);stroke-width:3.5px;stroke-linejoin:round;';

export function fmtPreco(n) {
  if (n >= 1000) return n.toLocaleString('pt-BR', { maximumFractionDigits: n >= 10000 ? 0 : 1 });
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 });
}
const hora = t => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const soDia = t => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const diaHora = t => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** opts: { candles, niv (niveisDia), est (estrutura), preco, ms, W, H, perfil, bolhas } → { svg, fora }
 *  perfil = { bw, L: [[preço, US$, US$ da foto anterior]], S: [...], hora } (liquidez em risco por faixa de preço, Coinversa)
 *  bolhas = [{ t, px, usd, side }] (liquidações reais) */
export function graficoSvg({ candles, niv, est, preco, ms, W = 960, H = 440, perfil = null, bolhas = null, rsi = null, regimeDia = null, plano = null }) {
  const c = candles; if (!c || c.length < 5) return { svg: '', fora: [] };
  const L = 8, R = 74, T = 14, B = 26, x1 = W - R, y1 = H - B;
  let lo = Math.min(...c.map(x => x.l)), hi = Math.max(...c.map(x => x.h)); const r0 = hi - lo || 1;
  const niveis = ((niv && niv.niveis) || []).filter(n => ms < 144e5 || !['PDC', 'AB', 'ABNY', 'VWAP', 'MXD', 'MND'].includes(n.id)), fora = [];
  const dentro = niveis.filter(n => n.preco >= lo - 0.3 * r0 && n.preco <= hi + 0.3 * r0), outros = niveis.filter(n => !dentro.includes(n));
  outros.forEach(n => fora.push(n));
  dentro.forEach(n => { lo = Math.min(lo, n.preco); hi = Math.max(hi, n.preco); });
  if (plano) for (const p of [plano.stop, plano.alvo]) if (p >= lo - 0.5 * r0 && p <= hi + 0.5 * r0) { lo = Math.min(lo, p); hi = Math.max(hi, p); }   // o plano sempre à vista
  const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const Y = p => T + (hi - p) / (hi - lo) * (y1 - T), xc = perfil && perfil.bw ? x1 - 128 : x1, step = (xc - L) / c.length, X = i => L + (i + 0.5) * step, bw = Math.max(1.5, Math.min(12, step * 0.64));
  const HR = rsi ? 124 : 0;
  let s = `<svg viewBox="0 0 ${W} ${H + HR}" width="100%" role="img" aria-label="Gráfico de velas com níveis do dia e estrutura${rsi ? ' e RSI' : ''}">`;
  // grade e escala de preço
  for (let g = 0; g <= 5; g++) { const p = lo + (hi - lo) * g / 5, y = Y(p);
    s += `<line x1="${L}" x2="${x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" style="stroke:var(--line)"/><text x="${x1 + 6}" y="${(y + 4).toFixed(1)}" style="fill:var(--muted);font-size:11px">${fmtPreco(p)}</text>`; }
  // horas no eixo
  const cada = Math.max(1, Math.round(c.length / 6));
  for (let i = 0; i < c.length; i += cada) s += `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" style="fill:var(--muted);font-size:10.5px">${ms >= 864e5 ? soDia(c[i].t) : ms >= 36e5 ? diaHora(c[i].t) : hora(c[i].t)}</text>`;
  // perfil da liquidez em risco: barras deitadas a partir da borda direita, no mesmo eixo de preço.
  // Preenchido = foto atual; contorno = foto anterior (mostra se a faixa cresceu ou foi consumida).
  if (perfil && perfil.bw) {
    s += `<line x1="${xc + 4}" x2="${xc + 4}" y1="${T}" y2="${y1}" style="stroke:var(--line)"/>`;
    const PW = 122, faixas = [...perfil.L.map(a => [...a, 'L']), ...perfil.S.map(a => [...a, 'S'])].filter(a => a[0] + perfil.bw / 2 > lo && a[0] - perfil.bw / 2 < hi);
    const mx = Math.max(1, ...faixas.map(a => Math.max(a[1], a[2] || 0)));
    faixas.forEach(([p, v, ant, lado]) => {
      const ya = Y(Math.min(hi, p + perfil.bw / 2)), yb = Y(Math.max(lo, p - perfil.bw / 2)), h = Math.max(1, yb - ya - 1), col = lado === 'L' ? 'var(--lv-long)' : 'var(--lv-short)';
      const w = v / mx * PW; if (w >= 0.5) s += `<rect x="${(x1 - w).toFixed(1)}" y="${(ya + 0.5).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" style="fill:${col};opacity:.22"/>`;
      if (ant != null && Math.abs(ant - v) > 0.05 * mx) { const wa = ant / mx * PW; s += `<rect x="${(x1 - wa).toFixed(1)}" y="${(ya + 0.5).toFixed(1)}" width="${wa.toFixed(1)}" height="${h.toFixed(1)}" style="fill:none;stroke:${col};stroke-width:1;stroke-dasharray:2 2;opacity:.8"/>`; }
    });
    s += `<text x="${x1 - 4}" y="${T + 10}" text-anchor="end" style="${HALO}fill:var(--muted);font-size:10.5px">liquidez em risco${perfil.hora ? ' · foto ' + perfil.hora : ''}</text>`;
  }
  // velas
  c.forEach((v, i) => { const up = v.c >= v.o, col = up ? 'var(--up)' : 'var(--down)', yo = Y(v.o), yc = Y(v.c);
    s += `<line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${Y(v.h).toFixed(1)}" y2="${Y(v.l).toFixed(1)}" style="stroke:${col}"/>`
      + `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(yc - yo)).toFixed(1)}" style="fill:${col}"/>`; });
  // VWAP (linha, começa na abertura do dia/sessão)
  const vw = ms < 144e5 ? ((niv && niv.vwap) || []) : [];
  if (vw.length) {
    const pts = [];
    for (const [t, v] of vw) { const i = c.findIndex(x => t >= x.t && t < x.t + ms); if (i >= 0) pts.push([X(i), Y(v)]); }
    if (pts.length > 1) s += `<polyline points="${pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}" fill="none" style="stroke:${COR_NIVEL.VWAP};stroke-width:1.8;opacity:.9"/>`;
  }
  // níveis horizontais (a VWAP já foi desenhada como linha). Rótulos: níveis a menos de 14 px viram um só rótulo, e os grupos nunca se sobrepõem.
  const rot = [];
  dentro.sort((a, b) => b.preco - a.preco).forEach(n => {
    const y = Y(n.preco), col = COR_NIVEL[n.id] || '#9a9a9a';
    if (n.id !== 'VWAP') s += `<line x1="${L}" x2="${x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" style="stroke:${col};stroke-dasharray:${n.id === 'MXD' || n.id === 'MND' || n.id === 'PDC' ? '2 4' : '6 4'};stroke-width:1.2;opacity:.85"/>`;
  });
  const grp = [];
  dentro.forEach(n => { const y = Y(n.preco), g = grp[grp.length - 1]; if (g && y - g.fim < 14) { g.itens.push(n); g.fim = y; } else grp.push({ itens: [n], ini: y, fim: y }); });
  let yMin = T + 10;
  for (const g of grp) {
    let yl = Math.max((g.ini + g.fim) / 2 - 3, yMin); yMin = yl + 14;
    const tsp = g.itens.map((n, i) => `<tspan style="fill:${COR_NIVEL[n.id] || '#9a9a9a'}">${i ? ' · ' : ''}${esc(n.rot)} ${fmtPreco(n.preco)}</tspan>`).join('');
    rot.push(`<text x="${L + 4}" y="${yl.toFixed(1)}" style="${HALO}font-size:11px;font-weight:600">${tsp}</text>`);
  }
  // estrutura: pivôs rotulados, linha do nível rompido e marcas
  if (est) {
    const nTotal = c.length, t0 = c[0].t;
    const pv = est.pivos.filter(p => p.t >= t0).slice(-12);
    pv.forEach(p => { const i = c.findIndex(x => x.t === p.t); if (i < 0) return;
      const alta = p.r === 'HH' || p.r === 'HL', baixa = p.r === 'LH' || p.r === 'LL', col = alta ? 'var(--up)' : baixa ? 'var(--down)' : 'var(--muted)';
      const y = p.tipo === 'H' ? Y(p.p) - 7 : Y(p.p) + 14;
      s += `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.p).toFixed(1)}" r="2.6" style="fill:${col}"/>`;
      rot.push(`<text x="${X(i).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" style="${HALO}fill:${col};font-size:10.5px;font-weight:700">${p.r}</text>`); });
    const q = est.quebra;
    if (q && q.t >= t0) {
      const j = c.findIndex(x => x.t === q.t), ip = est.pivos.find(p => p.p === q.nivel && p.t >= t0), i0 = ip ? c.findIndex(x => x.t === ip.t) : Math.max(0, j - 6);
      if (j >= 0) {
        const col = q.sobe ? 'var(--up)' : 'var(--down)', yq = Y(q.nivel);
        s += `<line x1="${X(Math.max(0, i0)).toFixed(1)}" x2="${x1}" y1="${yq.toFixed(1)}" y2="${yq.toFixed(1)}" style="stroke:${col};stroke-width:1.4;stroke-dasharray:1 3"/>`;
        const rt = est.reteste, ext = X(j) > x1 - 150, txt = `${q.tipo} ${q.sobe ? '↑' : '↓'}${rt ? ' · reteste ' + rt.estado : ''}`;
        rot.push(`<text x="${(ext ? Math.min(X(j) + 6, x1 - 2) : X(j)).toFixed(1)}" y="${(q.sobe ? Y(c[j].l) + 16 : Y(c[j].h) - 8).toFixed(1)}" text-anchor="${ext ? 'end' : 'middle'}" style="${HALO}fill:${col};font-size:11px;font-weight:800">${esc(txt)}</text>`);
      }
    }
  }
  // bolhas: liquidações reais no preço e na hora em que aconteceram (área proporcional ao valor)
  if (bolhas && bolhas.length) {
    const t0 = c[0].t, tf = c[c.length - 1].t + ms, vis = bolhas.filter(b => b.px != null && b.t >= t0 && b.t < tf && b.px >= lo && b.px <= hi);
    // uma bolha por vela e por lado: soma dos valores, no preço médio ponderado (evita dezenas de círculos empilhados)
    const g = new Map();
    for (const b of vis) { const i = Math.min(c.length - 1, Math.floor((b.t - t0) / ms)), k = i + '|' + b.side, o = g.get(k) || { i, side: b.side, usd: 0, pu: 0, n: 0, nx: 0, t0: b.t, t1: b.t };
      o.usd += b.usd; o.pu += b.px * b.usd; o.n++; if (b.ex) o.nx++; o.t0 = Math.min(o.t0, b.t); o.t1 = Math.max(o.t1, b.t); g.set(k, o); }
    const gs = [...g.values()], mb = Math.max(1, ...gs.map(o => o.usd));
    gs.sort((a, b) => a.usd - b.usd).forEach(o => {
      const px = o.pu / o.usd, r = 2.5 + Math.sqrt(o.usd / mb) * 13, col = o.side === 'long' ? 'var(--lv-long)' : o.side === 'short' ? 'var(--lv-short)' : 'var(--muted)';
      const nome = o.side === 'long' ? 'Longs liquidados' : o.side === 'short' ? 'Shorts liquidados' : 'Liquidações (lado incerto)';
      s += `<circle cx="${X(o.i).toFixed(1)}" cy="${Y(px).toFixed(1)}" r="${r.toFixed(1)}" style="fill:${col};fill-opacity:.35;stroke:${col};stroke-width:1.2${o.nx * 2 < o.n ? ';stroke-dasharray:3 2' : ''}"><title>${nome} · US$ ${Math.round(o.usd).toLocaleString('pt-BR')} em ${o.n} ${o.n > 1 ? 'eventos' : 'evento'} (${o.nx} com preço e lado exatos) · perto de ${fmtPreco(px)} · ${hora(o.t0)}${o.t1 - o.t0 > 6e4 ? '–' + hora(o.t1) : ''}</title></circle>`;
    });
  }
  // meu plano: faixa de risco (entrada → stop) e de alvo (entrada → alvo), com rótulos à direita das velas
  if (plano && plano.stop && plano.alvo && plano.entrada) {
    const lim = y => Math.max(T, Math.min(y1, y)), ye = lim(Y(plano.entrada)), ys = lim(Y(plano.stop)), ya = lim(Y(plano.alvo)), xi = Math.max(L, xc - 150), pct = p => ((p / plano.entrada - 1) * 100).toFixed(1).replace('.', ',') + '%';
    s += `<rect x="${xi}" y="${Math.min(ye, ys).toFixed(1)}" width="${(xc - xi).toFixed(1)}" height="${Math.abs(ys - ye).toFixed(1)}" style="fill:var(--down);opacity:.12"/>`
      + `<rect x="${xi}" y="${Math.min(ye, ya).toFixed(1)}" width="${(xc - xi).toFixed(1)}" height="${Math.abs(ya - ye).toFixed(1)}" style="fill:var(--up);opacity:.12"/>`;
    for (const [p, col, nome] of [[plano.stop, 'var(--down)', 'stop'], [plano.alvo, 'var(--up)', 'alvo']]) {
      const yr = Y(p), fora = yr < T || yr > y1, y = lim(yr), seta = yr < T ? ' ↑' : yr > y1 ? ' ↓' : '';
      if (!fora) s += `<line x1="${L}" x2="${xc}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" style="stroke:${col};stroke-width:1.6"/>`;
      rot.push(`<text x="${xc - 4}" y="${(y + (yr > ye ? (fora ? -4 : 13) : (fora ? 12 : -4))).toFixed(1)}" text-anchor="end" style="${HALO}fill:${col};font-size:11px;font-weight:800">${nome} ${fmtPreco(p)} (${pct(p)})${seta}${fora ? ' fora da vista' : ''}</text>`);
    }
    rot.push(`<text x="${xi + 4}" y="${(ye - 4).toFixed(1)}" style="${HALO}fill:var(--fg);font-size:11px;font-weight:700">plano ${esc(plano.lado || '')}${plano.rr != null ? ' · R:R ' + plano.rr.toFixed(1).replace('.', ',') : ''}</text>`);
  }
  // preço atual
  if (preco) { const y = Y(preco);
    s += `<line x1="${L}" x2="${x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" style="stroke:var(--fg);stroke-opacity:.55;stroke-dasharray:3 3"/>`
      + `<rect x="${x1 + 1}" y="${(y - 9).toFixed(1)}" width="${R - 3}" height="18" rx="3" style="fill:var(--fg)"/><text x="${x1 + 5}" y="${(y + 4).toFixed(1)}" style="fill:var(--surface);font-size:11px;font-weight:700">${fmtPreco(preco)}</text>`; }
  // painel do RSI(14), alinhado vela a vela com o gráfico de cima
  if (rsi) {
    const r0 = H + 8, r1 = H + HR - 6, YR = v => r1 - v / 100 * (r1 - r0), xe = xc;
    s += `<rect x="${L}" y="${YR(100).toFixed(1)}" width="${(xe - L).toFixed(1)}" height="${(YR(70) - YR(100)).toFixed(1)}" style="fill:var(--down);opacity:.07"/>`
      + `<rect x="${L}" y="${YR(30).toFixed(1)}" width="${(xe - L).toFixed(1)}" height="${(YR(0) - YR(30)).toFixed(1)}" style="fill:var(--up);opacity:.07"/>`;
    for (const v of [30, 50, 70]) s += `<line x1="${L}" x2="${xe}" y1="${YR(v).toFixed(1)}" y2="${YR(v).toFixed(1)}" style="stroke:var(--line);${v === 50 ? '' : 'stroke-dasharray:4 4'}"/><text x="${xe + 6}" y="${(YR(v) + 4).toFixed(1)}" style="fill:var(--muted);font-size:10.5px">${v}</text>`;
    const pts = rsi.map((v, i) => v == null ? null : X(i).toFixed(1) + ',' + YR(v).toFixed(1)).filter(Boolean);
    if (pts.length > 1) s += `<polyline points="${pts.join(' ')}" fill="none" style="stroke:var(--accent, #7f77dd);stroke-width:1.6"/>`;
    const ult = [...rsi].reverse().find(v => v != null);
    s += `<text x="${L + 4}" y="${r0 + 11}" style="${HALO}fill:var(--fg);font-size:11px;font-weight:700">RSI 14${ult != null ? ' · ' + ult.toFixed(1).replace('.', ',') : ''}</text>`;
    if (regimeDia) s += `<text x="${xe - 4}" y="${r0 + 11}" text-anchor="end" style="${HALO}fill:${regimeDia.lado > 0 ? 'var(--up)' : regimeDia.lado < 0 ? 'var(--down)' : 'var(--muted)'};font-size:11px;font-weight:700">Diário: ${esc(regimeDia.t)}${regimeDia.v != null ? ' (RSI ' + regimeDia.v.toFixed(0) + ')' : ''}</text>`;
  }
  return { svg: s + rot.join('') + '</svg>', fora };
}
