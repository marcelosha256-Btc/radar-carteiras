/* Regras do diário no servidor: limpeza dos campos e cálculo de R (usado por api/trades.js e testado em tests/diario.test.mjs). */
const num = v => { if (v === '' || v == null) return null; const x = Number(String(v).replace(',', '.')); return Number.isFinite(x) ? x : null; };
const txt = (v, max = 500) => (v == null || v === '' ? null : String(v).slice(0, max));
const COLS = ['ativo', 'mercado', 'lado', 'tf', 'setup', 'tipo', 'entrada', 'stop', 'alvo1', 'alvo2', 'qtd', 'risco_usd', 'abertura', 'fechamento', 'saida', 'taxas_usd', 'motivo', 'emocao', 'nota'];
const NUMS = new Set(['entrada', 'stop', 'alvo1', 'alvo2', 'qtd', 'risco_usd', 'abertura', 'fechamento', 'saida', 'taxas_usd']);

export function limpar(b) {
  const o = {};
  for (const k of COLS) if (k in b) o[k] = NUMS.has(k) ? num(b[k]) : txt(b[k], k === 'nota' ? 2000 : 80);
  if (o.lado && !['compra', 'venda'].includes(o.lado)) throw new Error('lado');
  if (o.mercado && !['cripto', 'acoes'].includes(o.mercado)) throw new Error('mercado');
  if (o.tipo && !['papel', 'real'].includes(o.tipo)) throw new Error('tipo');
  return o;
}
// R = lucro em múltiplos do risco inicial (distância até o stop); as taxas entram como fração do risco em dólares
export function calcR(t) {
  if (t.saida == null || !(t.entrada > 0) || t.entrada === t.stop) return { r: null, resultado_usd: null, status: 'aberto' };
  const side = t.lado === 'compra' ? 1 : -1, risco = Math.abs(t.entrada - t.stop);
  let r = side * (t.saida - t.entrada) / risco;
  if (t.taxas_usd && t.risco_usd > 0) r -= t.taxas_usd / t.risco_usd;
  const usd = t.risco_usd > 0 ? r * t.risco_usd : null;
  return { r: Math.round(r * 100) / 100, resultado_usd: usd == null ? null : Math.round(usd * 100) / 100, status: 'fechado' };
}
