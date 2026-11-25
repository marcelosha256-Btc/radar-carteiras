/* Medo e ganância do cripto (alternative.me, público): valor de hoje, ontem e há 7 dias. Cache de 1 h no navegador.
 * Contexto, não gatilho: nas 11 vezes desde 2018 com índice ≤10 (conta citada na live do Augusto Backes de 19/11/2026,
 * não conferida por nós), o preço ainda caiu mais em algum dos 90 dias seguintes; medo extremo pode durar. */
const CH = 'radar-medo-cache2', VALIDADE = 3600e3;

export function faixaMedo(v) {
  if (v == null) return { txt: '—', cor: 'var(--muted)' };
  if (v <= 10) return { txt: 'medo extremo (≤10)', cor: 'var(--down)' };
  if (v < 25) return { txt: 'medo extremo', cor: 'var(--down)' };
  if (v < 45) return { txt: 'medo', cor: 'var(--warn)' };
  if (v < 55) return { txt: 'neutro', cor: 'var(--fg)' };
  if (v < 75) return { txt: 'ganância', cor: 'var(--up)' };
  return { txt: 'ganância extrema', cor: 'var(--up)' };
}
/** Faixas do medidor (0 a 100). */
export const FAIXAS_MEDO = [{ ate: 25, cor: '#d6453d', rot: 'Medo extremo' }, { ate: 45, cor: '#ef8a3a', rot: 'Medo' }, { ate: 55, cor: '#9a9a9a', rot: 'Neutro' },
  { ate: 75, cor: '#8cc152', rot: 'Ganância' }, { ate: 101, cor: '#3fa34d', rot: 'Ganância extrema' }];
export function medidorMedo(m) {
  return { titulo: 'Medo e ganância · cripto', sub: 'Que emoção move o mercado cripto agora?', v: m.v, min: 0, max: 100, faixas: FAIXAS_MEDO, marcas: [0, 25, 50, 75, 100],
    hist: [['Ontem', m.ont], ['1 semana atrás', m.sem], ['1 mês atrás', m.mes], ['1 ano atrás', m.ano]],
    nota: 'Índice da alternative.me (volatilidade, volume, redes sociais, dominância e tendências de busca). Contexto, não gatilho: medo extremo pode durar.' };
}
export function frase(m) {
  if (!m) return '';
  const f = faixaMedo(m.v), d = m.v - m.sem;
  return `Medo e ganância do cripto: ${m.v} (${f.txt})${m.sem != null ? `, ${d === 0 ? 'igual a' : d > 0 ? 'subiu de' : 'caiu de'} ${m.sem} há 7 dias` : ''}.${m.v <= 10 ? ' Medo extremo pode continuar: contexto, não gatilho.' : ''}`;
}
export async function medo() {
  try { const c = JSON.parse(localStorage.getItem(CH) || 'null'); if (c && Date.now() - c.t < VALIDADE) return c.d; } catch (e) {}
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=366'); if (!r.ok) return null;
    const a = (await r.json()).data || []; if (!a.length) return null;
    const at = i => (a[i] ? +a[i].value : null), d = { v: +a[0].value, ont: at(1), sem: at(7), mes: at(30), ano: at(365) };
    try { localStorage.setItem(CH, JSON.stringify({ t: Date.now(), d })); } catch (e) {}
    return d;
  } catch (e) { return null; }
}
