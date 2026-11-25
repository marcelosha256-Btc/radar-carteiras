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

/** opts: { candles, niv (niveisDia), est (estrutura), preco, ms, W, H } → { svg, fora } */
export function graficoSvg({ candles, niv, est, preco, ms, W = 960, H = 380 }) {
  const c = candles; if (!c || c.length < 5) return { svg: '', fora: [] };
  const L = 8, R = 74, T = 14, B = 26, x1 = W - R, y1 = H - B;
  let lo = Math.min(...c.map(x => x.l)), hi = Math.max(...c.map(x => x.h)); const r0 = hi - lo || 1;
  const niveis = (niv && niv.niveis) || [], fora = [];
  const dentro = niveis.filter(n => n.preco >= lo - 0.3 * r0 && n.preco <= hi + 0.3 * r0), outros = niveis.filter(n => !dentro.includes(n));
  outros.forEach(n => fora.push(n));
  dentro.forEach(n => { lo = Math.min(lo, n.preco); hi = Math.max(hi, n.preco); });
  const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const Y = p => T + (hi - p) / (hi - lo) * (y1 - T), step = (x1 - L) / c.length, X = i => L + (i + 0.5) * step, bw = Math.max(1.5, Math.min(12, step * 0.64));
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Gráfico de velas com níveis do dia e estrutura">`;
  // grade e escala de preço
  for (let g = 0; g <= 5; g++) { const p = lo + (hi - lo) * g / 5, y = Y(p);
    s += `<line x1="${L}" x2="${x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" style="stroke:var(--line)"/><text x="${x1 + 6}" y="${(y + 4).toFixed(1)}" style="fill:var(--muted);font-size:11px">${fmtPreco(p)}</text>`; }
  // horas no eixo
  const cada = Math.max(1, Math.round(c.length / 6));
  for (let i = 0; i < c.length; i += cada) s += `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" style="fill:var(--muted);font-size:10.5px">${ms >= 864e5 ? soDia(c[i].t) : ms >= 36e5 ? diaHora(c[i].t) : hora(c[i].t)}</text>`;
  // velas
  c.forEach((v, i) => { const up = v.c >= v.o, col = up ? 'var(--up)' : 'var(--down)', yo = Y(v.o), yc = Y(v.c);
    s += `<line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${Y(v.h).toFixed(1)}" y2="${Y(v.l).toFixed(1)}" style="stroke:${col}"/>`
      + `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(yc - yo)).toFixed(1)}" style="fill:${col}"/>`; });
  // VWAP (linha, começa na abertura do dia/sessão)
  const vw = (niv && niv.vwap) || [];
  if (vw.length) {
    const pts = [];
    for (const [t, v] of vw) { const i = c.findIndex(x => t >= x.t && t < x.t + ms); if (i >= 0) pts.push([X(i), Y(v)]); }
    if (pts.length > 1) s += `<polyline points="${pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}" fill="none" style="stroke:${COR_NIVEL.VWAP};stroke-width:1.8;opacity:.9"/>`;
  }
  // níveis horizontais (a VWAP já foi desenhada como linha; aqui só o rótulo)
  const rot = []; let ys = [];
  dentro.sort((a, b) => b.preco - a.preco).forEach(n => {
    const y = Y(n.preco), col = COR_NIVEL[n.id] || '#9a9a9a';
    if (n.id !== 'VWAP') s += `<line x1="${L}" x2="${x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" style="stroke:${col};stroke-dasharray:${n.id === 'MXD' || n.id === 'MND' || n.id === 'PDC' ? '2 4' : '6 4'};stroke-width:1.2;opacity:.85"/>`;
    let yl = y - 3; if (ys.length && yl - ys[ys.length - 1] < 12) yl = ys[ys.length - 1] + 12; ys.push(yl);   // não deixa rótulos se sobreporem (de cima para baixo)
    rot.push(`<text x="${L + 4}" y="${yl.toFixed(1)}" style="${HALO}fill:${col};font-size:11px;font-weight:600">${esc(n.rot)} ${fmtPreco(n.preco)}</text>`);
  });
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
  // preço atual
  if (preco) { const y = Y(preco);
    s += `<line x1="${L}" x2="${x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" style="stroke:var(--fg);stroke-opacity:.55;stroke-dasharray:3 3"/>`
      + `<rect x="${x1 + 1}" y="${(y - 9).toFixed(1)}" width="${R - 3}" height="18" rx="3" style="fill:var(--fg)"/><text x="${x1 + 5}" y="${(y + 4).toFixed(1)}" style="fill:var(--surface);font-size:11px;font-weight:700">${fmtPreco(preco)}</text>`; }
  return { svg: s + rot.join('') + '</svg>', fora };
}
