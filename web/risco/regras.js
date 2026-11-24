/* Núcleo de risco do day trade: regras do dia, trava de perda diária, consolidação das execuções da Hyperliquid em
 * operações e checklist antes de entrar. Funções puras (sem rede nem tela), testadas em tests/risco.test.mjs. */

export const H = 36e5, BRT = 3 * H;   // Brasília = UTC−3 o ano todo
export const REGRAS_PADRAO = {
  perdaDiaPct: 2,      // para no dia ao perder isto do capital (realizado + aberto)
  perdasSeguidas: 3,   // para no dia depois de N perdas seguidas
  opsDia: 5,           // máximo de operações abertas no dia
  janelaIni: 10, janelaFim: 13,   // janela de entradas (hora de Brasília)
  rrMin: 2,            // R:R líquido mínimo
  noticiaMin: 30,      // sem entradas de 15 min antes... até N min depois de notícia de alto impacto
  heatMax: 5,          // risco total aberto máximo, % do capital
};

/** início do dia de hoje em Brasília, em ms UTC */
export function inicioDiaBRT(agora) { return Math.floor((agora - BRT) / (24 * H)) * 24 * H + BRT; }
export const horaBRT = agora => new Date(agora - BRT).getUTCHours() + new Date(agora - BRT).getUTCMinutes() / 60;

/** Junta as execuções (userFills) em operações: do zero até voltar a zero, por ativo. Virada de mão fecha uma e abre outra.
 *  Execuções de posições abertas antes da janela consultada (posição inicial ≠ 0 sem a abertura) são ignoradas. */
export function consolidarFills(fills) {
  const porAtivo = new Map();
  for (const f of [...fills].sort((a, b) => a.time - b.time || a.tid - b.tid)) {
    if (!porAtivo.has(f.coin)) porAtivo.set(f.coin, []);
    porAtivo.get(f.coin).push(f);
  }
  const ops = [];
  const novo = (coin, f, lado) => ({ coin, lado, chave: `${coin}:${f.tid}`, abertura: f.time, fechamento: null, abre: { q: 0, v: 0 }, fecha: { q: 0, v: 0 }, taxas: 0, pnl: 0, maxQ: 0 });
  for (const [coin, L] of porAtivo) {
    let atual = null;
    for (const f of L) {
      const sz = +f.sz, px = +f.px, ini = +f.startPosition, delta = f.side === 'B' ? sz : -sz, fim = ini + delta;
      const eps = 1e-9 * Math.max(1, Math.abs(ini) + sz);
      if (!atual && Math.abs(ini) > eps) continue;   // posição veio de antes da janela: não dá para reconstruir
      const fee = +f.fee || 0, pnl = +f.closedPnl || 0;
      if (!atual) atual = novo(coin, f, delta > 0 ? 'compra' : 'venda');
      const sinalAtual = atual.lado === 'compra' ? 1 : -1;
      const fecha = Math.sign(delta) === -sinalAtual ? Math.min(sz, Math.abs(ini)) : 0;   // parte que reduz a posição
      const abre = sz - fecha;
      if (fecha > 0) { atual.fecha.q += fecha; atual.fecha.v += fecha * px; }
      atual.taxas += fee; atual.pnl += pnl;
      const virou = Math.abs(fim) > eps && Math.sign(fim) !== Math.sign(ini) && Math.abs(ini) > eps;
      if (abre > 0 && !virou) { atual.abre.q += abre; atual.abre.v += abre * px; }
      atual.maxQ = Math.max(atual.maxQ, virou ? Math.abs(ini) : Math.abs(fim));
      if (Math.abs(fim) <= eps || virou) {
        atual.fechamento = f.time; ops.push(atual); atual = null;
        if (virou) { atual = novo(coin, f, fim > 0 ? 'compra' : 'venda'); atual.abre.q = abre; atual.abre.v = abre * px; atual.maxQ = Math.abs(fim); }
      }
    }
    if (atual) ops.push(atual);
  }
  return ops.filter(o => o.abre.q > 0).map(o => ({
    chave: o.chave, ativo: o.coin.replace(/^xyz:/, ''), mercado: o.coin.startsWith('xyz:') ? 'acoes' : 'cripto', lado: o.lado,
    entrada: o.abre.v / o.abre.q, saida: o.fecha.q ? o.fecha.v / o.fecha.q : null, qtd: o.maxQ,
    taxas_usd: round2(o.taxas), resultado_usd: o.fechamento ? round2(o.pnl - o.taxas) : null,
    abertura: o.abertura, fechamento: o.fechamento, status: o.fechamento ? 'fechado' : 'aberto',
  }));
}
const round2 = v => Math.round(v * 100) / 100;

/** Situação do dia. real = operações consolidadas da corretora; papel = Meu diário (tipo papel).
 *  capital = saldo atual; aberto = PnL não realizado agora. Devolve números e se deve parar. */
export function travaDoDia({ real = [], papel = [], capital = 0, aberto = 0, riscoPct = 0.5, regras = REGRAS_PADRAO, agora = Date.now() }) {
  const ini = inicioDiaBRT(agora);
  const fechHoje = real.filter(o => o.fechamento && o.fechamento >= ini).sort((a, b) => a.fechamento - b.fechamento);
  const realizado = fechHoje.reduce((s, o) => s + (o.resultado_usd || 0), 0);
  const base = capital - realizado - aberto;   // capital no começo do dia
  const pctReal = base > 0 ? (realizado + aberto) / base * 100 : 0;
  const papFech = papel.filter(t => t.status === 'fechado' && t.r != null && +t.fechamento >= ini).sort((a, b) => a.fechamento - b.fechamento);
  const rPapel = papFech.reduce((s, t) => s + +t.r, 0), pctPapel = rPapel * riscoPct;
  const seq = L => { let n = 0; for (let i = L.length - 1; i >= 0 && L[i] < 0; i--) n++; return n; };
  const perdasReal = seq(fechHoje.map(o => o.resultado_usd || 0)), perdasPapel = seq(papFech.map(t => +t.r));
  const opsReal = real.filter(o => o.abertura >= ini).length, opsPapel = papel.filter(t => +t.abertura >= ini).length;
  const motivos = [];
  if (pctReal <= -regras.perdaDiaPct) motivos.push(`perda real de ${fmt(-pctReal)}% hoje (limite ${regras.perdaDiaPct}%)`);
  if (pctPapel <= -regras.perdaDiaPct) motivos.push(`perda em papel de ${fmt(-pctPapel)}% hoje (${fmt(rPapel)}R × ${riscoPct}% por operação)`);
  if (Math.max(perdasReal, perdasPapel) >= regras.perdasSeguidas) motivos.push(`${Math.max(perdasReal, perdasPapel)} perdas seguidas (limite ${regras.perdasSeguidas})`);
  if (opsReal + opsPapel >= regras.opsDia) motivos.push(`${opsReal + opsPapel} operações hoje (limite ${regras.opsDia})`);
  return { parar: motivos.length > 0, motivos, pctReal, realizado, aberto, base, rPapel, pctPapel, perdasReal, perdasPapel, opsReal, opsPapel, ops: opsReal + opsPapel };
}
const fmt = v => (Math.round(v * 100) / 100).toLocaleString('pt-BR');

/** Checklist antes de entrar. calc = resultado da calculadora; eventos = agenda macro [{t, nome, impacto}];
 *  heatAberto = risco já no plano (US$). Itens: ['bloqueia'|'aviso'|'ok', texto]. */
export function checklist({ calc, trava, eventos = [], heatAberto = 0, regras = REGRAS_PADRAO, agora = Date.now() }) {
  const it = [];
  if (trava && trava.parar) it.push(['bloqueia', 'Trava do dia: ' + trava.motivos.join('; ') + '. Pare por hoje.']);
  else if (trava) it.push(['ok', `Dentro das regras do dia (${trava.ops}/${regras.opsDia} operações).`]);
  const h = horaBRT(agora);
  if (h < regras.janelaIni || h >= regras.janelaFim) it.push(['aviso', `Fora da sua janela de entradas (${regras.janelaIni}h–${regras.janelaFim}h de Brasília): só entre se for o plano.`]);
  else it.push(['ok', 'Dentro da janela de entradas.']);
  const ev = eventos.filter(e => e.impacto === 'alto' && agora >= e.t - 15 * 60000 && agora <= e.t + regras.noticiaMin * 60000);
  if (ev.length) it.push(['bloqueia', `Notícia de alto impacto agora: ${ev.map(e => e.nome).join(', ')}. Espere ${regras.noticiaMin} min depois.`]);
  const prox = eventos.filter(e => e.impacto === 'alto' && e.t > agora + 15 * 60000 && e.t <= agora + 120 * 60000);
  if (prox.length) it.push(['aviso', `Notícia de alto impacto em ${Math.round((prox[0].t - agora) / 60000)} min (${prox[0].nome}): reduza o tamanho ou espere.`]);
  if (!calc) return it;
  if (calc.rr == null) it.push(['bloqueia', 'Defina o alvo: sem alvo não há R:R para conferir.']);
  else if (calc.rr < regras.rrMin) it.push(['bloqueia', `R:R líquido de ${fmt(calc.rr)} abaixo do seu mínimo (${regras.rrMin}).`]);
  else it.push(['ok', `R:R líquido de ${fmt(calc.rr)}.`]);
  const custo = calc.risco > 0 ? calc.notional * calc.custoStop / calc.risco : 0;
  if (custo > 0.25) it.push(['aviso', `Custos levam ${Math.round(custo * 100)}% do risco: stop curto demais para as taxas.`]);
  if (calc.carrega != null && calc.carrega > 30) it.push(['aviso', `Funding caro: este lado paga ${fmt(calc.carrega)}% ao ano.`]);
  if (calc.cap > 0 && (heatAberto + calc.risco) / calc.cap * 100 > regras.heatMax)
    it.push(['bloqueia', `Risco total aberto passaria de ${regras.heatMax}% do capital (${fmt((heatAberto + calc.risco) / calc.cap * 100)}%).`]);
  return it;
}
