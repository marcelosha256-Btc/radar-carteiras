/* VIX (medo das ações dos EUA) via /api/vix. Cache de 15 min no navegador. Contexto, não gatilho. */
const CH = 'radar-vix-cache', VALIDADE = 15 * 60e3;

export function faixaVix(v) {
  if (v == null) return { txt: '—', cor: 'var(--muted)' };
  if (v >= 35) return { txt: 'pânico (≥35)', cor: 'var(--down)' };
  if (v >= 25) return { txt: 'estresse (25 a 35)', cor: 'var(--down)' };
  if (v >= 20) return { txt: 'atenção (20 a 25)', cor: 'var(--warn)' };
  if (v >= 15) return { txt: 'normal (15 a 20)', cor: 'var(--fg)' };
  return { txt: 'calmo (<15)', cor: 'var(--up)' };
}
const f1 = v => v.toFixed(1).replace('.', ',');
export function fraseVix(m) {
  if (!m) return '';
  const f = faixaVix(m.v), d = m.ont != null ? m.v - m.ont : null;
  return `VIX (medo das ações dos EUA): ${f1(m.v)} · ${f.txt}${d != null ? `, ${d >= 0 ? '+' : ''}${f1(d)} no dia` : ''}${m.sem != null ? `, era ${f1(m.sem)} há 5 pregões` : ''}. Contexto, não gatilho.`;
}
export async function vix() {
  try { const c = JSON.parse(localStorage.getItem(CH) || 'null'); if (c && Date.now() - c.t < VALIDADE) return c.d; } catch (e) {}
  try {
    const r = await fetch('api/vix'); if (!r.ok) return null;
    const d = await r.json(); if (!isFinite(d.v)) return null;
    try { localStorage.setItem(CH, JSON.stringify({ t: Date.now(), d })); } catch (e) {}
    return d;
  } catch (e) { return null; }
}
