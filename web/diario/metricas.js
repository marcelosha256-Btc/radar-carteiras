/* Métricas do diário de operações, todas em R (múltiplos do risco inicial de cada operação).
 * Só entram operações fechadas, na ordem em que fecharam. Funções puras, testadas em tests/diario.test.mjs. */

const soma = a => a.reduce((s, x) => s + x, 0);

export function ordemFechamento(trades) {
  return trades.filter(t => t.status === 'fechado' && t.r != null)
    .sort((a, b) => (Number(a.fechamento) || Number(a.abertura) || 0) - (Number(b.fechamento) || Number(b.abertura) || 0) || a.id - b.id);
}

export function metricas(trades) {
  const f = ordemFechamento(trades), rs = f.map(t => Number(t.r)), n = rs.length;
  if (!n) return { n: 0 };
  const g = rs.filter(r => r > 0), p = rs.filter(r => r < 0);
  const ganho = soma(g), perda = -soma(p);
  let acum = 0, pico = 0, ddMax = 0, seqP = 0, seqPMax = 0, seqG = 0, seqGMax = 0;
  const curva = rs.map(r => {
    acum += r; pico = Math.max(pico, acum); ddMax = Math.max(ddMax, pico - acum);
    if (r < 0) { seqP++; seqG = 0; } else if (r > 0) { seqG++; seqP = 0; } else { seqP = 0; seqG = 0; }
    seqPMax = Math.max(seqPMax, seqP); seqGMax = Math.max(seqGMax, seqG);
    return acum;
  });
  const media = acum / n, dp = Math.sqrt(soma(rs.map(r => (r - media) ** 2)) / Math.max(n - 1, 1));
  const mediaG = g.length ? ganho / g.length : 0, mediaP = p.length ? perda / p.length : 0;
  return {
    n, ganhos: g.length, perdas: p.length, zeros: n - g.length - p.length,
    acerto: g.length / n, expectancia: media, totalR: acum,
    mediaGanho: mediaG, mediaPerda: -mediaP,
    payoff: mediaP > 0 ? mediaG / mediaP : null,
    fatorLucro: perda > 0 ? ganho / perda : (ganho > 0 ? Infinity : null),
    maiorSequenciaPerdas: seqPMax, maiorSequenciaGanhos: seqGMax,
    drawdownR: ddMax, melhor: Math.max(...rs), pior: Math.min(...rs),
    erroPadrao: n > 1 ? dp / Math.sqrt(n) : null,   // incerteza da expectância: com poucas operações ela é enorme
    curva,
  };
}

/* agrupa por uma chave (setup, ativo, tempo gráfico, tipo, hora de entrada...) e calcula a expectância de cada grupo */
export function porGrupo(trades, chave) {
  const m = new Map();
  for (const t of ordemFechamento(trades)) {
    const k = (typeof chave === 'function' ? chave(t) : t[chave]) || '(sem)';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return [...m.entries()].map(([k, L]) => { const x = metricas(L); return { chave: k, n: x.n, acerto: x.acerto, expectancia: x.expectancia, totalR: x.totalR }; })
    .sort((a, b) => b.totalR - a.totalR);
}

/* R aberto de uma operação em andamento, com o preço atual */
export function rAberto(t, preco) {
  if (!(preco > 0) || !(t.entrada > 0) || t.entrada === t.stop) return null;
  return (t.lado === 'compra' ? 1 : -1) * (preco - t.entrada) / Math.abs(t.entrada - t.stop);
}

/* leitura honesta do tamanho da amostra: com poucas operações, a expectância não quer dizer nada */
export function confianca(m) {
  if (!m || !m.n) return { nivel: 'nenhuma', texto: 'Ainda não há operações fechadas.' };
  if (m.n < 30) return { nivel: 'baixa', texto: `Só ${m.n} operações fechadas: é pouco para concluir qualquer coisa. Com menos de 30, o acaso explica quase tudo.` };
  if (m.n < 100) return { nivel: 'media', texto: `${m.n} operações: já dá para ver tendências, mas a margem de erro ainda é grande (±${(2 * (m.erroPadrao || 0)).toFixed(2)} R na média).` };
  return { nivel: 'razoavel', texto: `${m.n} operações: amostra razoável (margem de erro de ±${(2 * (m.erroPadrao || 0)).toFixed(2)} R na média).` };
}
