/* Medidor semicircular (estilo "medo e ganância"): faixas coloridas, agulha, valor grande e comparação com ontem/semana/mês/ano.
 * Visual próprio. Serve ao índice do cripto (0 a 100) e ao VIX (10 a 45, onde valor alto = medo). */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CX = 120, CY = 118, R = 96, W = 20;
const pt = (ang, r = R) => [CX + r * Math.cos(ang), CY - r * Math.sin(ang)];
const f = n => n.toFixed(2);

/** Ângulo (rad) do valor: min à esquerda (π), max à direita (0). */
export function angulo(v, min, max) { const t = Math.max(0, Math.min(1, (v - min) / (max - min))); return Math.PI * (1 - t); }
/** Faixa do valor: a primeira cujo limite superior (`ate`) ainda é maior que o valor; a última pega o resto. */
export function faixaDe(v, faixas) { if (v == null) return null; return faixas.find(x => v < x.ate) || faixas[faixas.length - 1]; }

function arco(a0, a1) { const [x0, y0] = pt(a0), [x1, y1] = pt(a1); return `M${f(x0)} ${f(y0)} A${R} ${R} 0 0 1 ${f(x1)} ${f(y1)}`; }

function estilo() {
  if (typeof document === 'undefined' || document.getElementById('estilo-medidor')) return;
  const s = document.createElement('style'); s.id = 'estilo-medidor';
  s.textContent = `.md{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:8px 18px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface)}
.md h3{margin:0;font-size:18px}.md .md-sub{margin:2px 0 0;color:var(--muted);font-size:12.5px}.md-cab{grid-column:1/-1}
.md svg{width:100%;max-width:300px;height:auto;display:block;margin:0 auto}
.md-agora{text-align:center;margin-top:-4px;font-size:13px}.md-agora b{font-size:15px}
.md-lista{display:grid;gap:0}.md-lin{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dotted var(--line)}.md-lin:last-child{border:0}
.md-lin span.md-r{flex:1;font-size:12.5px;color:var(--muted)}.md-lin span.md-r b{display:block;font-size:13.5px}
.md-bol{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:#fff;font:700 14px var(--f-display,inherit);flex:none}
.md-nota{grid-column:1/-1;margin:2px 0 0;font-size:12px;color:var(--muted)}
@media (max-width:480px){.md{grid-template-columns:minmax(0,1fr)}}`;
  document.head.appendChild(s);
}

/** m = { titulo, sub, v, min, max, faixas:[{ate,cor,rot}], hist:[[rótulo, valor|null]], marcas:[0,50,100], nota }. */
export function medidor(m) {
  estilo();
  const fx = m.faixas, fa = faixaDe(m.v, fx);
  let seg = '', ini = m.min;
  fx.forEach(x => { const fim = Math.min(x.ate, m.max);
    seg += `<path d="${arco(angulo(ini, m.min, m.max) - 0.012, angulo(fim, m.min, m.max) + 0.012)}" stroke="${x.cor}" stroke-width="${W}" fill="none"/>`; ini = fim; });
  const a = angulo(m.v, m.min, m.max), [nx, ny] = pt(a, R - 24);
  const marcas = (m.marcas || []).map(v => { const [tx, ty] = pt(angulo(v, m.min, m.max), R + 12);
    return `<text x="${f(tx)}" y="${f(ty + 3)}" text-anchor="middle" font-size="9" fill="currentColor" opacity=".55">${v}</text>`; }).join('');
  const svg = `<svg viewBox="0 0 240 150" role="img" aria-label="${esc(m.titulo)}: ${esc(String(Math.round(m.v)))}, ${esc(fa.rot)}">${seg}${marcas}
    <line x1="${CX}" y1="${CY}" x2="${f(nx)}" y2="${f(ny)}" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
    <circle cx="${CX}" cy="${CY}" r="9" fill="var(--surface)" stroke="currentColor" stroke-width="2.5"/>
    <text x="${CX}" y="${CY + 31}" text-anchor="middle" font-size="26" font-weight="800" fill="${fa.cor}">${esc(String(Math.round(m.v)))}</text></svg>`;
  const lin = (m.hist || []).filter(h => h[1] != null).map(([rot, v]) => { const g = faixaDe(v, fx);
    return `<div class="md-lin"><span class="md-r">${esc(rot)}<b style="color:${g.cor}">${esc(g.rot)}</b></span><span class="md-bol" style="background:${g.cor}">${Math.round(v)}</span></div>`; }).join('');
  return `<div class="md"><div class="md-cab"><h3>${esc(m.titulo)}</h3><p class="md-sub">${esc(m.sub)}</p></div>
    <div>${svg}<div class="md-agora">Agora: <b style="color:${fa.cor}">${esc(fa.rot)}</b></div></div>
    <div class="md-lista">${lin}</div>${m.nota ? `<p class="md-nota">${esc(m.nota)}</p>` : ''}</div>`;
}
