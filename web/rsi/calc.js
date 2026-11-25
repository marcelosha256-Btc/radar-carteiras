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

/** Média simples dos últimos n fechamentos; null se faltar histórico. */
export function mediaSimples(closes, n) {
  if (!closes || closes.length < n) return null;
  let t = 0; for (let i = closes.length - n; i < closes.length; i++) t += closes[i];
  return t / n;
}

/** Regime pelo RSI do dia (critério nosso, lido da tela do Augusto Backes de 19/11/2026): capitulação ≤30, queda forte ≤35, queda ≤45; espelho em cima. */
export function regime(rsiDia) {
  if (rsiDia == null) return { t: '—', lado: 0, nivel: 0 };
  if (rsiDia <= 30) return { t: 'CAPITULAÇÃO', lado: -1, nivel: 3 };
  if (rsiDia <= 35) return { t: 'QUEDA FORTE', lado: -1, nivel: 2 };
  if (rsiDia <= 45) return { t: 'QUEDA', lado: -1, nivel: 1 };
  if (rsiDia >= 70) return { t: 'EUFORIA', lado: 1, nivel: 3 };
  if (rsiDia >= 65) return { t: 'ALTA FORTE', lado: 1, nivel: 2 };
  if (rsiDia >= 55) return { t: 'ALTA', lado: 1, nivel: 1 };
  return { t: 'NEUTRO', lado: 0, nivel: 0 };
}

/** Série completa do RSI de Wilder (mesmo tamanho dos fechamentos; null no começo). */
export function rsiSerie(closes, n = 14) {
  const out = closes.map(() => null);
  if (!closes || closes.length < n + 1) return out;
  let g = 0, p = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else p -= d; }
  g /= n; p /= n; out[n] = p === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / p);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; p = (p * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = p === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / p);
  }
  return out;
}

/** Frase do RSI recente: o fundo/topo dos últimos `janela` fechamentos e o que aconteceu depois (conta, não previsão). */
export function fraseRsi(closes, nome = 'do dia', janela = 10, corte = 30) {
  const s = rsiSerie(closes), n = s.length - 1, atual = s[n];
  if (atual == null) return '';
  const rec = s.slice(Math.max(0, n - janela + 1)).map((v, i, a) => [v, a.length - 1 - i]).filter(x => x[0] != null);
  const fund = rec.reduce((m, x) => (x[0] < m[0] ? x : m), rec[0]), topo = rec.reduce((m, x) => (x[0] > m[0] ? x : m), rec[0]);
  const f = v => v.toFixed(1).replace('.', ',');
  if (fund[0] <= corte) {
    const velas = fund[1];
    if (atual <= corte) return velas ? `RSI ${nome} foi a ${f(fund[0])} há ${velas} vela${velas > 1 ? 's' : ''} e segue em sobrevenda (${f(atual)}). Sozinho não prevê direção.` : `RSI ${nome} está em sobrevenda (${f(atual)}), no fundo das últimas ${janela} velas. Sozinho não prevê direção.`;
    return `RSI ${nome} foi a ${f(fund[0])} há ${velas} vela${velas > 1 ? 's' : ''} e saiu da sobrevenda (agora ${f(atual)}). Sozinho não prevê direção.`;
  }
  if (topo[0] >= 100 - corte) {
    const velas = topo[1];
    if (atual >= 100 - corte) return velas ? `RSI ${nome} foi a ${f(topo[0])} há ${velas} vela${velas > 1 ? 's' : ''} e segue em sobrecompra (${f(atual)}). Sozinho não prevê direção.` : `RSI ${nome} está em sobrecompra (${f(atual)}), no topo das últimas ${janela} velas. Sozinho não prevê direção.`;
    return `RSI ${nome} foi a ${f(topo[0])} há ${velas} vela${velas > 1 ? 's' : ''} e saiu da sobrecompra (agora ${f(atual)}). Sozinho não prevê direção.`;
  }
  return '';
}

/** Conta inversa do RSI de Wilder: a que fechamento da vela atual (a última de `closes`, ainda em formação)
 *  o RSI ficaria exatamente em `alvo`. Usa as médias até a vela anterior. null se faltar histórico. */
export function precoParaRsi(closes, alvo, n = 14) {
  const m = closes ? closes.length - 1 : 0; if (m < n + 1 || !(alvo > 0 && alvo < 100)) return null;
  let g = 0, p = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else p -= d; }
  g /= n; p /= n;
  for (let i = n + 1; i < m; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; p = (p * (n - 1) + Math.max(-d, 0)) / n; }
  const ant = closes[m - 1], k = alvo / (100 - alvo);
  const sobe = k * p * (n - 1) - g * (n - 1);              // alta necessária (se a vela fechar acima da anterior)
  if (sobe >= 0) return ant + sobe;
  const desce = g * (n - 1) / k - p * (n - 1);             // queda necessária
  return desce >= 0 ? ant - desce : ant;
}
