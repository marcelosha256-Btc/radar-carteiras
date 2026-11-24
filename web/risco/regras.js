/* Núcleo de risco do day trade: regras do dia, trava de perda diária, consolidação das execuções da Hyperliquid em
 * operações e checklist antes de entrar. Funções puras (sem rede nem tela), testadas em tests/risco.test.mjs. */

export const H = 36e5, BRT = 3 * H;   // Brasília = UTC−3 o ano todo
export const ORDEM_MINIMA = 10;   // valor mínimo de ordem na Hyperliquid (US$)
export const REGRAS_PADRAO = {
  perdaDiaPct: 2,      // para no dia ao perder isto do capital (realizado + aberto)
  perdasSeguidas: 3,   // para no dia depois de N perdas seguidas
  opsDia: 5,           // máximo de operações abertas no dia
  janelaIni: 10, janelaFim: 13,   // janela de entradas (hora de Brasília)
  rrMin: 2,            // R:R líquido mínimo
  noticiaMin: 30,      // sem entradas de 15 min antes... até N min depois de notícia de alto impacto
  heatMax: 5,          // risco total aberto máximo, % do capital
  acoesJanelaH: 2.5,   // ações: entradas da abertura de Nova York até N horas depois
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
const fpx = v => (+v).toLocaleString('pt-BR', { maximumFractionDigits: v >= 100 ? 2 : v >= 1 ? 3 : 5 });

/** Checklist antes de entrar. calc = resultado da calculadora; eventos = agenda macro [{t, nome, impacto}];
 *  heatAberto = risco já no plano (US$). Itens: ['bloqueia'|'aviso'|'ok', texto]. */
export function checklist({ calc, trava, eventos = [], heatAberto = 0, regras = REGRAS_PADRAO, agora = Date.now(), mercado = 'cripto', extras = [] }) {
  const it = [];
  if (trava && trava.parar) it.push(['bloqueia', 'Trava do dia: ' + trava.motivos.join('; ') + '. Pare por hoje.']);
  else if (trava) it.push(['ok', `Dentro das regras do dia (${trava.ops}/${regras.opsDia} operações).`]);
  if (mercado === 'acoes') {   // ações seguem o pregão de Nova York
    const P = pregaoNY(agora), fimJ = P.abre + (regras.acoesJanelaH ?? 2.5) * H;
    if (!P.aberto) it.push(['aviso', `Fora do pregão de Nova York${P.feriado ? ` (feriado: ${P.feriado})` : ''}: o preço é só da Hyperliquid, a liquidez é fina e há risco de salto na abertura (${horaBRTtxt(P.prox)} de Brasília${new Date(P.prox - BRT).getUTCDate() !== new Date(agora - BRT).getUTCDate() ? ', em ' + new Date(P.prox - BRT).toISOString().slice(8, 10) + '/' + new Date(P.prox - BRT).toISOString().slice(5, 7) : ''}).`]);
    else {
      if (agora > fimJ) it.push(['aviso', `Fora da sua janela das ações (abertura de NY às ${horaBRTtxt(P.abre)} até ${horaBRTtxt(fimJ)} de Brasília): só entre se for o plano.`]);
      else it.push(['ok', 'Dentro da janela das ações (início do pregão de NY).']);
      if (P.fecha - agora < 15 * 60000) it.push(['aviso', `Faltam ${Math.max(0, Math.round((P.fecha - agora) / 60000))} min para o fechamento de NY.`]);
      if (P.meio) it.push(['aviso', `Pregão mais curto hoje (${P.meio}): fecha às ${horaBRTtxt(P.fecha)} de Brasília.`]);
    }
  } else {
    const h = horaBRT(agora);
    if (h < regras.janelaIni || h >= regras.janelaFim) it.push(['aviso', `Fora da sua janela de entradas (${regras.janelaIni}h–${regras.janelaFim}h de Brasília): só entre se for o plano.`]);
    else it.push(['ok', 'Dentro da janela de entradas.']);
  }
  const ev = eventos.filter(e => e.impacto === 'alto' && agora >= e.t - 15 * 60000 && agora <= e.t + regras.noticiaMin * 60000);
  if (ev.length) it.push(['bloqueia', `Notícia de alto impacto agora: ${ev.map(e => e.nome).join(', ')}. Espere ${regras.noticiaMin} min depois.`]);
  const prox = eventos.filter(e => e.impacto === 'alto' && e.t > agora + 15 * 60000 && e.t <= agora + 120 * 60000);
  if (prox.length) it.push(['aviso', `Notícia de alto impacto em ${Math.round((prox[0].t - agora) / 60000)} min (${prox[0].nome}): reduza o tamanho ou espere.`]);
  if (!calc) return it;
  if (calc.oposto > 0 && calc.e > 0 && calc.s > 0) {   // entrando colado no extremo oposto (vender no fundo, comprar no topo)
    const R = Math.abs(calc.e - calc.s), d = calc.side * (calc.oposto - calc.e) / R;
    if (d >= 0 && d < 0.5) it.push(['aviso', `${calc.side > 0 ? 'O topo' : 'O fundo'} recente (${fmt(calc.oposto)}) está a ${fmt(d)}R da entrada: você estaria ${calc.side > 0 ? 'comprando no topo' : 'vendendo no fundo'}. Espere ${calc.side > 0 ? 'um recuo' : 'um repique'}.`]);
    // espaço real: o alvo 1 fica além do extremo recente → o R:R de verdade é até esse extremo
    const a1 = calc.alvos && calc.alvos[0] && calc.alvos[0].p > 0 ? calc.side * (calc.alvos[0].p - calc.e) / R : null;
    if (d >= 0 && a1 != null && a1 > d) {
      const nome = calc.side > 0 ? 'máxima' : 'mínima', rm = regras.rrMin;
      if (d < rm) {
        const eMin = (calc.oposto + rm * calc.s) / (1 + rm);
        it.push(['bloqueia', `Estrutura no caminho: a ${nome} recente (${fpx(calc.oposto)}) fica a ${fmt(d)}R da entrada, antes do alvo 1 (${fmt(a1)}R). O espaço real é menor que o seu mínimo de ${rm}:1; só vale ${calc.side > 0 ? 'comprando em' : 'vendendo em'} ${fpx(eMin)} ou ${calc.side > 0 ? 'abaixo' : 'acima'}, ou com alvo até a ${nome}.`, { eMin, ref: calc.oposto, stop: calc.s, base: `Estrutura no caminho: a ${nome} recente (${fpx(calc.oposto)}) fica a ${fmt(d)}R da entrada, antes do alvo 1 (${fmt(a1)}R). O espaço real é menor que o seu mínimo de ${rm}:1.` }]);
      } else it.push(['aviso', `A ${nome} recente (${fpx(calc.oposto)}) fica a ${fmt(d)}R, antes do alvo 1 (${fmt(a1)}R): o preço pode parar ali.`]);
    }
  }
  it.push(...extras);
  // "só vale entrar em X": várias regras viram UMA entrada mínima (a mais restritiva); se ela passar do stop, não há entrada válida
  const metas = it.filter(x => x[0] === 'bloqueia' && x[2] && x[2].eMin > 0);
  /* com o stop do plano nenhuma entrada serve: monta o plano de espera com o stop além da zona mais longe (o do mapa)
     e a entrada que passa em TODAS as regras com esse stop */
  const alternativa = () => {
    const compra = calc.side > 0, rm = regras.rrMin;
    const st = metas.map(x => x[2].stop).filter(v => v > 0), stop = compra ? Math.min(calc.s, ...st) : Math.max(calc.s, ...st);
    const ent = metas.filter(x => x[2].ref > 0).map(x => (x[2].ref + rm * stop) / (1 + rm)), e2 = compra ? Math.min(...ent) : Math.max(...ent);
    const ok = ent.length > 0 && (compra ? e2 > stop : e2 < stop);
    return ok
      ? `Com o stop em ${fpx(calc.s)} nenhuma entrada passa. Plano de espera: ${compra ? 'comprar num recuo' : 'vender num repique'} até ${fpx(e2)} ou ${compra ? 'abaixo' : 'acima'}, com stop em ${fpx(stop)} (além da zona de liquidação); refaça o plano lá.`
      : `Nenhum preço de entrada passa nas regras acima com o stop em ${fpx(calc.s)}: espere outro setup.`;
  };
  if (metas.length && calc.s > 0) {
    const compra = calc.side > 0, eMin = compra ? Math.min(...metas.map(x => x[2].eMin)) : Math.max(...metas.map(x => x[2].eMin));
    const valido = compra ? eMin > calc.s : eMin < calc.s;
    if (metas.length > 1 || !valido) {
      const ultimo = it.indexOf(metas[metas.length - 1]);
      metas.forEach(x => { x[1] = x[2].base; });
      it.splice(ultimo + 1, 0, ['bloqueia', valido
        ? `Espere ${compra ? 'um recuo' : 'um repique'} até ${fpx(eMin)} ou ${compra ? 'abaixo' : 'acima'}: é a entrada que passa nas regras acima, com o mesmo stop.`
        : alternativa()]);
    }
  }
  if (calc.e > 0 && calc.atr > 0 && calc.alvos && calc.alvos.length > 1) {   // alvo 2 realista?
    const a2 = calc.alvos[calc.alvos.length - 1], R2 = Math.abs(calc.e - calc.s) || 1;
    const dF = Math.abs(a2.p - calc.e) / calc.e, passa = calc.oposto > 0 && calc.side * (a2.p - calc.e) / R2 > calc.side * (calc.oposto - calc.e) / R2 && calc.side * (calc.oposto - calc.e) > 0;
    if (a2.p > 0 && (dF > 8 * calc.atr || passa))
      it.push(['aviso', `Alvo 2 (${fpx(a2.p)}): ${[passa ? `passa da ${calc.side > 0 ? 'máxima' : 'mínima'} recente (${fpx(calc.oposto)})` : '', dF > 8 * calc.atr ? `fica a ${fmt(dF * 100)}% do preço, ${fmt(dF / calc.atr)} ATR do tempo gráfico` : ''].filter(Boolean).join(' e ')}. O R:R depende de romper a estrutura: considere sair tudo no alvo 1.`]);
  }
  if (calc.stopATR != null && calc.stopATR > 3)
    it.push(['aviso', `Stop largo (${fmt(calc.stopATR)} ATR do tempo gráfico): a posição fica em US$ ${fmt(calc.notional)} (${fmt(calc.notional / (calc.cap || 1) * 100)}% do capital). Isso é swing, não day trade: ${calc.notional < 0.1 * calc.cap ? 'a posição pequena não paga o esforço' : 'confira se é o que você quer'}.`]);
  if (calc.notional > 0 && calc.notional < ORDEM_MINIMA) it.push(['bloqueia', `Posição de US$ ${fmt(calc.notional)} abaixo da ordem mínima da Hyperliquid (US$ ${ORDEM_MINIMA}): aumente o risco ou afaste o stop.`]);
  if (calc.cortado) it.push(['aviso', `Posição no teto de US$ ${fmt(calc.posMax)}: o risco real é US$ ${fmt(calc.risco)}, menor que o planejado.`]);
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

/* ---------------------------------------------------------------- pregão de Nova York ---- */
/* feriados e meios-pregões da bolsa de Nova York (NYSE). Atualizar a lista a cada ano. */
export const NYSE_FERIADOS = {
  '2026-01-01': 'Ano-Novo', '2026-01-19': 'Martin Luther King', '2026-02-16': 'Dia dos Presidentes', '2026-04-03': 'Sexta-feira Santa',
  '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth', '2026-07-03': 'Independência', '2026-09-07': 'Dia do Trabalho',
  '2026-11-26': 'Ação de Graças', '2026-12-25': 'Natal',
  '2027-01-01': 'Ano-Novo', '2027-01-18': 'Martin Luther King', '2027-02-15': 'Dia dos Presidentes', '2027-03-26': 'Sexta-feira Santa',
  '2027-05-31': 'Memorial Day', '2027-06-18': 'Juneteenth', '2027-07-05': 'Independência', '2027-09-06': 'Dia do Trabalho',
  '2027-11-25': 'Ação de Graças', '2027-12-24': 'Natal',
};
export const NYSE_MEIO = { '2026-11-27': 'dia seguinte à Ação de Graças', '2026-12-24': 'véspera de Natal', '2027-11-26': 'dia seguinte à Ação de Graças' };   // fecha às 13h de NY

/** horário de verão americano: do 2º domingo de março ao 1º domingo de novembro (às 2h locais) */
function deslocNY(t) {
  const a = new Date(t).getUTCFullYear();
  const domingo = (mes, n) => { const d = new Date(Date.UTC(a, mes, 1)); const off = (7 - d.getUTCDay()) % 7; return Date.UTC(a, mes, 1 + off + 7 * (n - 1)); };
  const ini = domingo(2, 2) + 7 * 36e5, fim = domingo(10, 1) + 6 * 36e5;   // 2h EST = 7h UTC; 2h EDT = 6h UTC
  return t >= ini && t < fim ? -4 : -5;
}
/** situação do pregão de NY agora: aberto, horários em ms UTC e o motivo quando fechado */
export function pregaoNY(agora) {
  const o = deslocNY(agora) * H, local = new Date(agora + o), dia = local.toISOString().slice(0, 10), dow = local.getUTCDay();
  const meia = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - o;   // 00h de NY em UTC
  const abre = meia + 9.5 * H, fecha = meia + (NYSE_MEIO[dia] ? 13 : 16) * H;
  const util = dow >= 1 && dow <= 5 && !NYSE_FERIADOS[dia];
  const aberto = util && agora >= abre && agora < fecha;
  let prox = abre;   // próxima abertura
  if (!util || agora >= abre) for (let i = 1; i <= 10; i++) {
    const meio = meia + i * 24 * H + 12 * H, o2 = deslocNY(meio) * H, l = new Date(meio + o2), di = l.toISOString().slice(0, 10), w = l.getUTCDay();
    if (w >= 1 && w <= 5 && !NYSE_FERIADOS[di]) { prox = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - o2 + 9.5 * H; break; }
  }
  return { aberto, abre, fecha, prox, feriado: NYSE_FERIADOS[dia] || null, meio: NYSE_MEIO[dia] || null, util };
}
export const horaBRTtxt = t => { const d = new Date(t - BRT); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
