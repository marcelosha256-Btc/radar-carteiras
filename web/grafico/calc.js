/* Níveis do dia e estrutura de mercado a partir de velas {t, o, h, l, c, v}. Funções puras (testadas em tests/grafico.test.mjs).
 * Tudo aqui é regra objetiva: ou a condição é verdadeira ou não. Nada disso foi medido como estratégia. */

const NY = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }) : null;

/** Data (YYYY-MM-DD), minutos desde 00:00 e dia útil no horário de Nova York. */
export function nyHora(t) {
  const p = {}; for (const x of NY.formatToParts(new Date(t))) p[x.type] = x.value;
  return { dia: `${p.year}-${p.month}-${p.day}`, min: (+p.hour) * 60 + (+p.minute), util: !['Sat', 'Sun'].includes(p.weekday) };
}
export const diaUTC = t => new Date(t).toISOString().slice(0, 10);
const ABERTURA_NY = 9 * 60 + 30, FECHA_NY = 16 * 60;

/** ATR simples (média do true range) em preço absoluto; null com poucas velas. */
export function atrAbs(c, n = 14) {
  if (!c || c.length < n + 1) return null;
  let t = 0; for (let i = c.length - n; i < c.length; i++) t += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  return t / n;
}

function resumoGrupo(v) {
  if (!v.length) return null;
  let tp = 0, vol = 0; const vw = [];
  for (const x of v) { const w = x.v > 0 ? x.v : 0; tp += (x.h + x.l + x.c) / 3 * w; vol += w; vw.push([x.t, vol > 0 ? tp / vol : x.c]); }
  return { o: v[0].o, h: Math.max(...v.map(x => x.h)), l: Math.min(...v.map(x => x.l)), c: v[v.length - 1].c, t0: v[0].t, vwap: vw };
}

/** Agrupa velas de 15 min em "dias": cripto = dia UTC (24 h); ações = sessão de Nova York (9:30–16:00, só dias úteis). */
export function grupos(c15, mercado) {
  const mapa = new Map();
  for (const x of c15) {
    let chave;
    if (mercado === 'acoes') { const h = nyHora(x.t); if (!h.util || h.min < ABERTURA_NY || h.min >= FECHA_NY) continue; chave = h.dia; }
    else chave = diaUTC(x.t);
    (mapa.get(chave) || mapa.set(chave, []).get(chave)).push(x);
  }
  return [...mapa.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([dia, v]) => ({ dia, ...resumoGrupo(v) }));
}

/**
 * Níveis do dia. `hoje` é o dia/sessão em andamento (ou a última, se o mercado de ações estiver fechado: então vira "ontem").
 * Retorna { niveis: [{id, rot, preco}], vwap: [[t, preco]], ontem, hoje }.
 */
export function niveisDia(c15, mercado, agora = Date.now()) {
  const g = grupos(c15, mercado); if (!g.length) return { niveis: [], vwap: [], ontem: null, hoje: null };
  let hoje = g[g.length - 1], ontem = g.length > 1 ? g[g.length - 2] : null;
  if (mercado === 'acoes') {
    const n = nyHora(agora), emSessao = n.util && n.min >= ABERTURA_NY && n.min < FECHA_NY;
    if (!(emSessao && hoje.dia === n.dia)) { ontem = hoje; hoje = null; }   // pregão fechado: a última sessão é a de referência
  }
  const niveis = [];
  const add = (id, rot, preco) => { if (preco != null && isFinite(preco)) niveis.push({ id, rot, preco }); };
  if (ontem) { add('PDH', 'máx. ontem', ontem.h); add('PDL', 'mín. ontem', ontem.l); add('PDC', 'fech. ontem', ontem.c); }
  if (hoje) {
    add('AB', mercado === 'acoes' ? 'abertura NY' : 'abertura do dia', hoje.o);
    add('VWAP', 'VWAP', hoje.vwap[hoje.vwap.length - 1][1]);
    add('MXD', mercado === 'acoes' ? 'máx. da sessão' : 'máx. do dia', hoje.h); add('MND', mercado === 'acoes' ? 'mín. da sessão' : 'mín. do dia', hoje.l);
  }
  if (mercado !== 'acoes') {   // cripto também reage à abertura de NY (9:30)
    const ab = c15.filter(x => { const h = nyHora(x.t); return h.dia === nyHora(agora).dia && h.min === ABERTURA_NY; })[0];
    if (ab) add('ABNY', 'abertura NY', ab.o);
  }
  return { niveis, vwap: hoje ? hoje.vwap : [], ontem, hoje };
}

/** Níveis de semana e mês passados (UTC, semana começa na segunda) a partir de velas diárias. */
export function niveisPeriodo(c1d, agora = Date.now()) {
  if (!c1d || !c1d.length) return [];
  const sem = t => Math.floor((t - 4 * 864e5) / (7 * 864e5)), mes = t => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const out = [];
  for (const [id, k, nome] of [['PW', sem, 'semana'], ['PM', mes, 'mês']]) {
    const atual = k(agora), ant = c1d.filter(x => k(x.t) === atual - 1); if (!ant.length) continue;
    out.push({ id: id + 'H', rot: `máx. ${nome} passada`, preco: Math.max(...ant.map(x => x.h)) }, { id: id + 'L', rot: `mín. ${nome} passada`, preco: Math.min(...ant.map(x => x.l)) });
  }
  return out;
}

/** Pivôs (fractais): topo/fundo confirmado quando `n` velas de cada lado são menores/maiores. */
export function pivos(c, n = 2) {
  const out = [];
  for (let i = n; i < c.length - n; i++) {
    let topo = true, fundo = true;
    for (let k = 1; k <= n; k++) {
      if (!(c[i].h > c[i - k].h && c[i].h >= c[i + k].h)) topo = false;
      if (!(c[i].l < c[i - k].l && c[i].l <= c[i + k].l)) fundo = false;
    }
    if (topo) out.push({ i, t: c[i].t, p: c[i].h, tipo: 'H' });
    if (fundo) out.push({ i, t: c[i].t, p: c[i].l, tipo: 'L' });
  }
  return out;
}

/** Rotula cada pivô contra o anterior do mesmo tipo: HH/LH (topos) e HL/LL (fundos). */
export function rotular(pv) {
  let uH = null, uL = null;
  return pv.map(x => {
    let r;
    if (x.tipo === 'H') { r = uH == null ? 'T' : x.p > uH ? 'HH' : 'LH'; uH = x.p; }
    else { r = uL == null ? 'F' : x.p > uL ? 'HL' : 'LL'; uL = x.p; }
    return { ...x, r };
  });
}

/**
 * Estrutura: tendência pelos últimos dois topos e dois fundos, último rompimento de pivô (BOS, ou CHoCH se contra a tendência
 * anterior) e o reteste do nível rompido. `tol` = tolerância do reteste (padrão 0,15 ATR).
 */
export function estrutura(c, { n = 2 } = {}) {
  const pv = rotular(pivos(c, n));
  const H = pv.filter(x => x.tipo === 'H'), L = pv.filter(x => x.tipo === 'L');
  const atr = atrAbs(c) || (c.length ? (Math.max(...c.map(x => x.h)) - Math.min(...c.map(x => x.l))) / 20 : 0), tol = 0.15 * atr;
  let tendencia = 'indefinida';
  const hh = H.length >= 2 && H[H.length - 1].r === 'HH', hl = L.length >= 2 && L[L.length - 1].r === 'HL';
  const lh = H.length >= 2 && H[H.length - 1].r === 'LH', ll = L.length >= 2 && L[L.length - 1].r === 'LL';
  if (hh && hl) tendencia = 'alta'; else if (lh && ll) tendencia = 'baixa';
  // rompimentos: primeiro fechamento além de cada pivô recente (depois de confirmado)
  const eventos = [];
  for (const x of pv.slice(-8)) {
    for (let j = x.i + n + 1; j < c.length; j++) {
      if (x.tipo === 'H' ? c[j].c > x.p : c[j].c < x.p) { eventos.push({ pivo: x, j, t: c[j].t, nivel: x.p, sobe: x.tipo === 'H' }); break; }
    }
  }
  eventos.sort((a, b) => a.j - b.j);
  const ult = eventos.length ? eventos[eventos.length - 1] : null;
  let quebra = null, reteste = null;
  if (ult) {
    // tendência vigente imediatamente antes do rompimento (pivôs já conhecidos até então)
    const antes = pv.filter(x => x.i + n < ult.j), aH = antes.filter(x => x.tipo === 'H'), aL = antes.filter(x => x.tipo === 'L');
    const tAnt = aH.length >= 2 && aL.length >= 2 ? (aH[aH.length - 1].r === 'HH' && aL[aL.length - 1].r === 'HL' ? 'alta' : aH[aH.length - 1].r === 'LH' && aL[aL.length - 1].r === 'LL' ? 'baixa' : 'indefinida') : 'indefinida';
    const choch = (ult.sobe && tAnt === 'baixa') || (!ult.sobe && tAnt === 'alta');
    quebra = { tipo: choch ? 'CHoCH' : 'BOS', sobe: ult.sobe, nivel: ult.nivel, t: ult.t, j: ult.j };
    let tocou = false, estado = null;
    for (let k = ult.j + 1; k < c.length; k++) {
      const dentro = ult.sobe ? (c[k].l <= ult.nivel + tol && c[k].c >= ult.nivel - tol) : (c[k].h >= ult.nivel - tol && c[k].c <= ult.nivel + tol);
      const falhou = ult.sobe ? c[k].c < ult.nivel - tol : c[k].c > ult.nivel + tol;
      if (!tocou && falhou) { estado = 'falhou'; break; }
      if (dentro && !tocou) tocou = true;
      if (tocou && falhou) { estado = 'falhou'; break; }
      if (tocou && (ult.sobe ? c[k].c > ult.nivel + 0.5 * atr : c[k].c < ult.nivel - 0.5 * atr)) { estado = 'confirmado'; break; }
    }
    if (!estado) estado = tocou ? 'em curso' : 'aguardando';
    reteste = { nivel: ult.nivel, sobe: ult.sobe, estado };
  }
  return { pivos: pv, tendencia, ultimoTopo: H.length ? H[H.length - 1] : null, ultimoFundo: L.length ? L[L.length - 1] : null, quebra, reteste, atr };
}

/** Texto curto em português para a leitura do gráfico. `px` é o preço atual. */
export function leitura(est, niv, px, f = v => String(v)) {
  const t = [];
  if (niv && niv.niveis.length) {
    const v = niv.niveis.find(x => x.id === 'VWAP'), ab = niv.niveis.find(x => x.id === 'AB'), pdh = niv.niveis.find(x => x.id === 'PDH'), pdl = niv.niveis.find(x => x.id === 'PDL');
    if (v) t.push(`Preço ${px >= v.preco ? 'acima' : 'abaixo'} da VWAP (${f(v.preco)})`);
    if (ab) t.push(`${px >= ab.preco ? 'acima' : 'abaixo'} da ${ab.rot} (${f(ab.preco)})`);
    if (pdh && px > pdh.preco) t.push('acima da máxima de ontem'); else if (pdl && px < pdl.preco) t.push('abaixo da mínima de ontem');
    else if (pdh && pdl) t.push('dentro da faixa de ontem');
  }
  const base = t.length ? (t.join(', ') + '.').replace(/^./, m => m.toUpperCase()) : '';
  let e = '';
  if (est) {
    const tr = est.tendencia === 'alta' ? 'Estrutura de alta (topos e fundos mais altos).' : est.tendencia === 'baixa' ? 'Estrutura de baixa (topos e fundos mais baixos).' : 'Estrutura sem direção clara.';
    e = tr;
    if (est.quebra) {
      const q = est.quebra, nome = q.tipo === 'CHoCH' ? `Mudança de caráter: ${q.sobe ? 'rompeu o topo' : 'perdeu o fundo'}` : `Continuação: ${q.sobe ? 'rompeu o topo' : 'perdeu o fundo'}`;
      e += ` ${nome} em ${f(q.nivel)}`;
      if (est.reteste) e += est.reteste.estado === 'em curso' ? '; reteste em curso' : est.reteste.estado === 'confirmado' ? '; reteste confirmado' : est.reteste.estado === 'falhou' ? '; o nível não segurou (rompimento falso)' : '; ainda sem reteste';
      e += '.';
    }
  }
  return (base + ' ' + e).trim();
}

/**
 * Suporte e resistência mais próximos do preço: junta as fontes que caem a menos de `tol` ATR umas das outras.
 * fontes = [{ p, nome }]. Devolve { sup, res } com { lo, hi, meio, itens, dist } (dist em % do preço) ou null.
 * "Mais próximo", não "mais forte": medido em 25/11/2026, juntar níveis não fez o preço segurar mais (estudos/niveis_estrutura).
 */
export function zonasSR(px, fontes, atr, { tol = 0.3, folga = 0.05 } = {}) {
  if (!px || !(atr > 0)) return { sup: null, res: null };
  const lado = s => {
    const c = fontes.filter(f => f.p != null && isFinite(f.p) && (s < 0 ? f.p < px - folga * atr : f.p > px + folga * atr)).sort((a, b) => Math.abs(a.p - px) - Math.abs(b.p - px));
    if (!c.length) return null;
    const base = c[0].p, itens = c.filter(f => Math.abs(f.p - base) <= tol * atr);
    const lo = Math.min(...itens.map(f => f.p)), hi = Math.max(...itens.map(f => f.p)), meio = (lo + hi) / 2;
    return { lo, hi, meio, itens, dist: (meio / px - 1) * 100 };
  };
  return { sup: lado(-1), res: lado(1) };
}
