/* VIX (medo das ações dos EUA) via /api/vix. Cache de 15 min no navegador. Contexto, não gatilho. */
const CH = 'radar-vix-cache2', VALIDADE = 15 * 60e3;

export function faixaVix(v) {
  if (v == null) return { txt: '—', cor: 'var(--muted)' };
  if (v >= 35) return { txt: 'pânico (≥35)', cor: 'var(--down)' };
  if (v >= 25) return { txt: 'estresse (25 a 35)', cor: 'var(--down)' };
  if (v >= 20) return { txt: 'atenção (20 a 25)', cor: 'var(--warn)' };
  if (v >= 15) return { txt: 'normal (15 a 20)', cor: 'var(--fg)' };
  return { txt: 'calmo (<15)', cor: 'var(--up)' };
}
/** Faixas do medidor (VIX de 10 a 45; valor alto = medo, então as cores vão de verde a vermelho). */
export const FAIXAS_VIX = [{ ate: 15, cor: '#3fa34d', rot: 'Calmo' }, { ate: 20, cor: '#8cc152', rot: 'Normal' }, { ate: 25, cor: '#ef8a3a', rot: 'Atenção' },
  { ate: 35, cor: '#d6453d', rot: 'Estresse' }, { ate: 999, cor: '#9e2b25', rot: 'Pânico' }];
export function medidorVix(m) {
  return { titulo: 'VIX · medo das ações dos EUA', sub: 'Quanto o mercado paga por proteção contra queda', v: m.v, min: 10, max: 45, faixas: FAIXAS_VIX, marcas: [15, 20, 25, 35],
    hist: [['Fechamento anterior', m.ont], ['1 semana atrás', m.sem], ['1 mês atrás', m.mes], ['1 ano atrás', m.ano]],
    nota: 'VIX é a volatilidade esperada do S&P 500 (Cboe). Alto = medo, baixo = calma. Contexto, não gatilho.' };
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
