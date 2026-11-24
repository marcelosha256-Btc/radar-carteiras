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
  if (t.fonte === 'hyperliquid') return calcRImportado(t);
  if (t.saida == null || !(t.entrada > 0) || t.entrada === t.stop) return { r: null, resultado_usd: null, status: 'aberto' };
  const side = t.lado === 'compra' ? 1 : -1, risco = Math.abs(t.entrada - t.stop);
  let r = side * (t.saida - t.entrada) / risco;
  if (t.taxas_usd && t.risco_usd > 0) r -= t.taxas_usd / t.risco_usd;
  const usd = t.risco_usd > 0 ? r * t.risco_usd : null;
  return { r: Math.round(r * 100) / 100, resultado_usd: usd == null ? null : Math.round(usd * 100) / 100, status: 'fechado' };
}

/* Operação importada da corretora: o resultado em US$ vem das execuções (já com taxas). O R só existe quando o stop é
 * informado: risco = quantidade × distância até o stop (ou o risco em US$, se você informar). */
export function calcRImportado(t) {
  const stop = t.stop == null ? null : +t.stop;
  const risco = +t.risco_usd > 0 ? +t.risco_usd : (stop > 0 && +t.qtd > 0 && stop !== +t.entrada ? +t.qtd * Math.abs(+t.entrada - stop) : null);
  const fechado = t.status === 'fechado' && t.resultado_usd != null;
  return { r: fechado && risco ? Math.round(+t.resultado_usd / risco * 100) / 100 : null, risco_usd: risco == null ? null : Math.round(risco * 100) / 100,
    resultado_usd: t.resultado_usd == null ? null : +t.resultado_usd, status: t.status || 'aberto' };
}
/* campos que vêm das execuções (nunca do formulário) */
export function limparImportado(o) {
  const n = v => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
  if (!/^[A-Za-z0-9:_-]{1,40}:\d{1,20}$/.test(String(o.chave || ''))) throw new Error('chave');
  if (!['compra', 'venda'].includes(o.lado) || !['cripto', 'acoes'].includes(o.mercado) || !['aberto', 'fechado'].includes(o.status)) throw new Error('lado');
  return { chave: String(o.chave), fonte: 'hyperliquid', tipo: 'real', ativo: String(o.ativo).slice(0, 40), mercado: o.mercado, lado: o.lado,
    entrada: n(o.entrada), saida: n(o.saida), qtd: n(o.qtd), taxas_usd: n(o.taxas_usd), resultado_usd: n(o.resultado_usd),
    abertura: n(o.abertura), fechamento: n(o.fechamento), status: o.status };
}
