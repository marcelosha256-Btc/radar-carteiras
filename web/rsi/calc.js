/* RSI Mestre: cálculos puros (testados em tests/rsi.test.mjs). */

/** RSI de Wilder (14) da série de fechamentos; null se faltar histórico. */
export function rsiWilder(closes, n = 14) {
  if (!closes || closes.length < n + 1) return null;
  let g = 0, p = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else p -= d; }
  g /= n; p /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    p = (p * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (p === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / p);
}

/** Junta velas [{t, c}] em blocos de `ms` alinhados à época (UTC): fechamento = o da última vela de cada bloco. */
export function agrupar(velas, ms) {
  const out = [];
  for (const v of velas) {
    const b = Math.floor(v.t / ms) * ms;
    if (out.length && out[out.length - 1].t === b) out[out.length - 1].c = v.c;
    else out.push({ t: b, c: v.c });
  }
  return out;
}

/** Classifica um RSI: extremo (≤20 / ≥80), esticado (≤30 / ≥70) ou neutro. */
export function faixa(v) {
  if (v == null) return { nivel: 0, lado: 0, txt: '—' };
  if (v <= 20) return { nivel: 2, lado: -1, txt: 'sobrevenda extrema' };
  if (v <= 30) return { nivel: 1, lado: -1, txt: 'sobrevenda' };
  if (v >= 80) return { nivel: 2, lado: 1, txt: 'sobrecompra extrema' };
  if (v >= 70) return { nivel: 1, lado: 1, txt: 'sobrecompra' };
  return { nivel: 0, lado: 0, txt: 'neutro' };
}

/** Resumo da linha: quantos tempos esticados e para que lado (todos do mesmo lado = "alinhado"). */
export function resumo(valores) {
  const fx = valores.map(faixa), est = fx.filter(f => f.nivel > 0);
  if (!est.length) return { n: 0, lado: 0, txt: 'nenhum tempo esticado' };
  const lados = new Set(est.map(f => f.lado)), lado = lados.size === 1 ? est[0].lado : 0;
  const ext = est.filter(f => f.nivel === 2).length;
  return { n: est.length, ext, lado, txt: `${est.length} de ${valores.length} esticados${lado ? (lado < 0 ? ' em sobrevenda' : ' em sobrecompra') : ' (lados opostos)'}${ext ? ` · ${ext} extremo${ext > 1 ? 's' : ''}` : ''}` };
}
