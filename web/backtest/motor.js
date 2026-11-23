/* Motor de backtest do Radar de Carteiras (Fase 1).
 *
 * Candle a candle, sem olhar o futuro: o sinal de um candle só usa dados até o fechamento dele.
 * Execução padrão: sinal no fechamento do candle i, entrada na ABERTURA do candle i+1 (opções: fechamento do
 * candle sinal, ou rompimento da máxima/mínima do candle sinal). Mesmo módulo no site e nos testes (node --test).
 *
 * Regras conservadoras:
 *  - stop e alvo no mesmo candle: se houver candles menores (5m/15m) cobrindo aquele candle, eles decidem quem veio
 *    primeiro; sem eles (ou se os dois caírem no mesmo candle menor), vale o stop;
 *  - stop e liquidação: vale o que o preço encontra primeiro no caminho adverso; abertura além do nível sai na abertura;
 *  - no candle em que o rompimento é executado, só o stop (e a liquidação) valem: não dá para saber se a mínima veio
 *    antes ou depois da execução; os alvos começam no candle seguinte;
 *  - break-even e trailing stop mudam o stop para o candle SEGUINTE (dentro do candle não se sabe a ordem);
 *  - liquidação: perde a margem isolada (na Hyperliquid a margem de manutenção não volta no backstop).
 *  - filtro no tempo gráfico maior: só o último candle JÁ FECHADO desse tempo gráfico, nunca o que está em formação.
 *
 * Custos (Hyperliquid, nível 0, doc oficial): taker 0,045%, maker 0,015% sobre o valor de cada execução. Entradas,
 * stops e saídas por sinal/tempo são a mercado (taker + derrapagem); alvos são ordens limitadas (maker, sem derrapagem).
 * Funding: de hora em hora, taxa por hora × quantidade × preço; comprado paga quando a taxa é positiva.
 * Liquidação (isolada, doc oficial): manutenção = metade da margem inicial na alavancagem máxima (mmr = 1/(2·máx));
 *   comprado: entrada·(1 − 1/alav)/(1 − mmr); vendido: entrada·(1 + 1/alav)/(1 + mmr).
 * Quantidade: arredondada para baixo em frações de 0,0001 (posicao.passo_qtd).
 */

export const CUSTOS_PADRAO = { taker: 0.045, maker: 0.015, derrapagem: 0.02, funding: true };   // em %
export const ALAV_MAX = { BTC: 40, ETH: 25, SOL: 20, XRP: 20, HYPE: 10, NEAR: 10 };
export const HORA = 3_600_000;
export const INTERVALO_MS = { '5m': 300_000, '15m': 900_000, '1h': HORA, '4h': 4 * HORA, '1d': 24 * HORA };
export const MAX_ALVOS = 5;

/* ================================================================ indicadores ==== */

const CAMPOS = { abertura: 'o', maxima: 'h', minima: 'l', fechamento: 'c', volume: 'v' };
const nulos = n => new Array(n).fill(null);

function serieCampo(V, campo = 'fechamento') {
  const k = CAMPOS[campo] || campo;
  if (k === 'tipico') return V.map(x => (x.h + x.l + x.c) / 3);
  if (k === 'medio') return V.map(x => (x.h + x.l) / 2);
  return V.map(x => x[k]);
}

/** Média aritmética simples; aceita nulos no começo da série (só começa quando há n valores seguidos). */
export function mms(x, n) {
  const out = nulos(x.length);
  let s = 0, cont = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] == null) { s = 0; cont = 0; continue; }
    s += x[i]; cont++;
    if (cont > n) { s -= x[i - n]; cont--; }
    if (cont === n) out[i] = s / n;
  }
  return out;
}

/** Média exponencial: começa pela média simples dos n primeiros valores válidos, k = 2/(n+1). */
export function mme(x, n) {
  const out = nulos(x.length), k = 2 / (n + 1);
  const ini = x.findIndex(v => v != null);
  if (ini < 0 || x.length - ini < n) return out;
  let e = 0;
  for (let i = ini; i < ini + n; i++) e += x[i];
  e /= n; out[ini + n - 1] = e;
  for (let i = ini + n; i < x.length; i++) { e = e + k * (x[i] - e); out[i] = e; }
  return out;
}

/** Suavização de Wilder (média com peso 1/n): começa pela média simples dos n primeiros. */
function wilder(x, n) {
  const out = nulos(x.length);
  const ini = x.findIndex(v => v != null);
  if (ini < 0 || x.length - ini < n) return out;
  let a = 0;
  for (let i = ini; i < ini + n; i++) a += x[i];
  a /= n; out[ini + n - 1] = a;
  for (let i = ini + n; i < x.length; i++) { a = (a * (n - 1) + x[i]) / n; out[i] = a; }
  return out;
}

export function ifr(c, n = 14) {
  // IFR de Wilder: médias de Wilder dos ganhos e das perdas
  const g = [null], p = [null];
  for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); p.push(Math.max(-d, 0)); }
  const mg = wilder(g, n), mp = wilder(p, n);
  return mg.map((v, i) => v == null ? null : mp[i] === 0 ? 100 : 100 - 100 / (1 + v / mp[i]));
}

function trueRange(V) {
  return V.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - V[i - 1].c), Math.abs(x.l - V[i - 1].c)));
}
export function atr(V, n = 14) { return wilder(trueRange(V), n); }

function desvio(x, n) {   // desvio-padrão populacional (padrão do Bollinger)
  const out = nulos(x.length);
  for (let i = n - 1; i < x.length; i++) {
    let m = 0; for (let j = i - n + 1; j <= i; j++) m += x[j]; m /= n;
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += (x[j] - m) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

/** Máxima e mínima de uma janela; `incluirAtual` = false olha só os n candles ANTERIORES. */
function janelaExtremos(V, n, incluirAtual) {
  const hh = nulos(V.length), ll = nulos(V.length), d = incluirAtual ? 0 : 1;
  for (let i = n - 1 + d; i < V.length; i++) {
    let a = -Infinity, b = Infinity;
    for (let j = i - n + 1 - d; j <= i - d; j++) { a = Math.max(a, V[j].h); b = Math.min(b, V[j].l); }
    hh[i] = a; ll[i] = b;
  }
  return { hh, ll };
}

function hilo(V, n) {
  // HiLo Activator: vira para alta quando fecha acima da média das máximas ANTERIOR, para baixa quando fecha abaixo
  // da média das mínimas anterior. Valor = média das mínimas em alta, das máximas em baixa.
  const ma = mms(V.map(x => x.h), n), mi = mms(V.map(x => x.l), n);
  const valor = nulos(V.length), tend = nulos(V.length);
  let t = null;
  for (let i = 1; i < V.length; i++) {
    if (ma[i - 1] == null) continue;
    if (V[i].c > ma[i - 1]) t = 1; else if (V[i].c < mi[i - 1]) t = -1;
    if (t == null) continue;
    tend[i] = t; valor[i] = t === 1 ? mi[i] : ma[i];
  }
  return { valor, tendencia: tend };
}

function vwapDiario(V) {
  // VWAP que recomeça todo dia às 00:00 UTC, com o preço típico; inclui o candle atual
  const out = nulos(V.length);
  let dia = null, pv = 0, vol = 0;
  for (let i = 0; i < V.length; i++) {
    const d = Math.floor(V[i].t / 86_400_000);
    if (d !== dia) { dia = d; pv = 0; vol = 0; }
    const tp = (V[i].h + V[i].l + V[i].c) / 3;
    pv += tp * V[i].v; vol += V[i].v;
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

function estocastico(V, n, suav, nd) {
  // estocástico lento: %K rápido = 100·(fech − mín n)/(máx n − mín n), com o candle atual; %K lento = média de
  // `suav` do rápido; %D = média de `nd` do %K lento
  const { hh, ll } = janelaExtremos(V, n, true);
  const rap = V.map((x, i) => hh[i] == null ? null : hh[i] === ll[i] ? 50 : 100 * (x.c - ll[i]) / (hh[i] - ll[i]));
  const k = mms(rap, suav);
  return { k, d: mms(k, nd) };
}

function adx(V, n) {
  // ADX de Wilder: +DM/−DM e TR suavizados por Wilder; DI = 100·DM/TR; DX = 100·|DI+ − DI−|/(DI+ + DI−); ADX = Wilder do DX
  const tr = trueRange(V), pdm = [null], ndm = [null];
  for (let i = 1; i < V.length; i++) {
    const up = V[i].h - V[i - 1].h, dn = V[i - 1].l - V[i].l;
    pdm.push(up > dn && up > 0 ? up : 0); ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  tr[0] = null;
  const str = wilder(tr, n), sp = wilder(pdm, n), sn = wilder(ndm, n);
  const dip = str.map((t, i) => t == null || t === 0 ? null : 100 * sp[i] / t);
  const dim = str.map((t, i) => t == null || t === 0 ? null : 100 * sn[i] / t);
  const dx = dip.map((p, i) => p == null || dim[i] == null || p + dim[i] === 0 ? null : 100 * Math.abs(p - dim[i]) / (p + dim[i]));
  return { adx: wilder(dx, n), di_mais: dip, di_menos: dim };
}

function supertrend(V, n, m) {
  const a = atr(V, n), valor = nulos(V.length), tend = nulos(V.length);
  let up = null, dn = null, t = 1;
  for (let i = 0; i < V.length; i++) {
    if (a[i] == null) continue;
    const meio = (V[i].h + V[i].l) / 2, bu = meio + m * a[i], bd = meio - m * a[i];
    const pc = i > 0 ? V[i - 1].c : V[i].c;
    up = up == null || bu < up || pc > up ? bu : up;       // banda de cima só desce (até o preço furar)
    dn = dn == null || bd > dn || pc < dn ? bd : dn;       // banda de baixo só sobe
    if (t === 1 && V[i].c < dn) t = -1; else if (t === -1 && V[i].c > up) t = 1;
    tend[i] = t; valor[i] = t === 1 ? dn : up;
  }
  return { valor, tendencia: tend };
}

function cci(V, n) {
  const tp = serieCampo(V, 'tipico'), m = mms(tp, n), out = nulos(V.length);
  for (let i = n - 1; i < V.length; i++) {
    let md = 0; for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]); md /= n;
    out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
  }
  return out;
}

function obv(V) {
  const out = [0];
  for (let i = 1; i < V.length; i++) out.push(out[i - 1] + (V[i].c > V[i - 1].c ? V[i].v : V[i].c < V[i - 1].c ? -V[i].v : 0));
  return out;
}

/** Trap no 1-2-3 de fundo (setup do Stormer): marca 1 no candle que perde a mínima do último 1-2-3.
 *  1-2-3 = candle do meio com mínima abaixo dos vizinhos (confirmado no 3º candle). O trap vale se acontecer em até
 *  `janela` candles depois do 1-2-3; uma mínima ainda menor dentro desse prazo vira o novo trap. Depois de um trap,
 *  novos 1-2-3 são ignorados até ele vencer (`validade` candles), como no script do TradingView. */
function trap123(V, janela, validade) {
  const out = nulos(V.length);
  let fundo = null, pat = null, trap = null, trapMin = null;
  for (let i = 2; i < V.length; i++) {
    out[i] = 0;
    if (trap != null && i - trap >= validade) { fundo = pat = trap = trapMin = null; }
    if (trap == null && pat != null && i - pat > janela) { fundo = pat = null; }
    if (trap == null && V[i - 1].l < V[i - 2].l && V[i - 1].l < V[i].l) { fundo = V[i - 1].l; pat = i; }
    if (fundo != null && i > pat && i - pat <= janela && V[i].l < fundo && (trapMin == null || V[i].l < trapMin)) {
      trapMin = V[i].l; trap = i; out[i] = 1;
    }
  }
  return out;
}

function fvg(V, linha) {
  // gap de valor justo de 3 candles: alta quando a máxima de i−2 fica abaixo da mínima de i; baixa ao contrário
  return V.map((x, i) => i < 2 ? null : linha === 'baixa' ? (V[i - 2].l > x.h ? 1 : 0) : (V[i - 2].h < x.l ? 1 : 0));
}

export const INDICADORES = {
  preco: 'campo: abertura | maxima | minima | fechamento | volume',
  MMA: 'média aritmética · periodo, fonte (fechamento)',
  MMS: 'o mesmo que MMA',
  MME: 'média exponencial · periodo, fonte',
  IFR: 'Wilder · periodo (14)',
  MACD: 'rapida (12), lenta (26), sinal (9), linha: macd | sinal | histograma',
  Estocastico: 'lento · periodo (14), suavizacao (3), d (3), linha: k | d',
  Bollinger: 'periodo (20), desvios (2), linha: superior | media | inferior | %b | largura',
  ATR: 'Wilder · periodo (14)',
  VWAP: 'do dia, recomeça 00:00 UTC',
  ADX: 'Wilder · periodo (14), linha: adx | di_mais | di_menos',
  Supertrend: 'periodo (10), multiplicador (3), linha: valor | tendencia (+1/−1)',
  Donchian: 'periodo (20), linha: superior | inferior | media — N candles anteriores',
  Keltner: 'periodo (20, MME), atr (10), multiplicador (2), linha: superior | media | inferior',
  HiLo: 'periodo (10), linha: valor | tendencia (+1/−1)',
  WilliamsR: 'periodo (14), de −100 a 0',
  CCI: 'periodo (20)',
  OBV: 'acumulado do volume',
  VolumeMedio: 'periodo (20), média do volume',
  Maxima: 'periodo — máxima dos N candles ANTERIORES (sem o atual)',
  Minima: 'periodo — mínima dos N candles ANTERIORES (sem o atual)',
  FVG: 'linha: alta | baixa — 1 quando há gap de 3 candles (preparado para a Fase 2)',
  Trap123: 'janela (10), validade (3) — 1 no candle que perde a mínima do último 1-2-3 de fundo (setup do Stormer)',
  MinimoN: 'periodo, de: INDICADOR — menor valor do indicador nos últimos N candles, com o atual',
  MaximoN: 'periodo, de: INDICADOR — maior valor do indicador nos últimos N candles, com o atual',
};
// Fase 2 (estrutura de mercado): entram aqui como novos casos de calcularIndicador, usando topos/fundos (pivôs)
// numa janela de 30 candles: BOS (rompe o último topo/fundo a favor), ChoCH (rompe contra), divergências de IFR/MACD.
export const FASE2 = ['BOS', 'ChoCH', 'Divergencia'];

export function calcularIndicador(spec, V) {
  const nome = spec.nome, linha = spec.linha;
  const fonte = () => serieCampo(V, spec.fonte || 'fechamento');
  switch (nome) {
    case 'preco': return serieCampo(V, spec.campo || 'fechamento');
    case 'MMA': case 'MMS': return mms(fonte(), spec.periodo);
    case 'MME': return mme(fonte(), spec.periodo);
    case 'IFR': return ifr(fonte(), spec.periodo || 14);
    case 'ATR': return atr(V, spec.periodo || 14);
    case 'Bollinger': {
      const n = spec.periodo || 20, k = spec.desvios ?? 2, x = fonte(), m = mms(x, n), d = desvio(x, n);
      return m.map((v, i) => {
        if (v == null) return null;
        const sup = v + k * d[i], inf = v - k * d[i];
        if (linha === 'superior') return sup;
        if (linha === 'inferior') return inf;
        if (linha === '%b') return sup === inf ? 0.5 : (x[i] - inf) / (sup - inf);
        if (linha === 'largura') return (sup - inf) / v;
        return v;
      });
    }
    case 'MACD': {
      const x = fonte(), r = mme(x, spec.rapida || 12), l = mme(x, spec.lenta || 26);
      const macd = r.map((v, i) => v == null || l[i] == null ? null : v - l[i]);
      const sinal = mme(macd, spec.sinal || 9);
      return linha === 'sinal' ? sinal : linha === 'histograma' ? macd.map((v, i) => v == null || sinal[i] == null ? null : v - sinal[i]) : macd;
    }
    case 'Estocastico': { const e = estocastico(V, spec.periodo || 14, spec.suavizacao || 3, spec.d || 3); return linha === 'd' ? e.d : e.k; }
    case 'ADX': return adx(V, spec.periodo || 14)[linha === 'di_mais' ? 'di_mais' : linha === 'di_menos' ? 'di_menos' : 'adx'];
    case 'Supertrend': return supertrend(V, spec.periodo || 10, spec.multiplicador ?? 3)[linha === 'tendencia' ? 'tendencia' : 'valor'];
    case 'Donchian': {
      const { hh, ll } = janelaExtremos(V, spec.periodo || 20, false);
      return hh.map((h, i) => h == null ? null : linha === 'superior' ? h : linha === 'inferior' ? ll[i] : (h + ll[i]) / 2);
    }
    case 'Keltner': {
      const m = mme(serieCampo(V), spec.periodo || 20), a = atr(V, spec.atr || 10), k = spec.multiplicador ?? 2;
      return m.map((v, i) => v == null || a[i] == null ? null : linha === 'superior' ? v + k * a[i] : linha === 'inferior' ? v - k * a[i] : v);
    }
    case 'HiLo': return hilo(V, spec.periodo || 10)[linha === 'tendencia' ? 'tendencia' : 'valor'];
    case 'WilliamsR': {
      const { hh, ll } = janelaExtremos(V, spec.periodo || 14, true);
      return V.map((x, i) => hh[i] == null ? null : hh[i] === ll[i] ? -50 : -100 * (hh[i] - x.c) / (hh[i] - ll[i]));
    }
    case 'CCI': return cci(V, spec.periodo || 20);
    case 'OBV': return obv(V);
    case 'VolumeMedio': return mms(serieCampo(V, 'volume'), spec.periodo || 20);
    case 'Maxima': return janelaExtremos(V, spec.periodo || 20, false).hh;
    case 'Minima': return janelaExtremos(V, spec.periodo || 20, false).ll;
    case 'VWAP': return vwapDiario(V);
    case 'FVG': return fvg(V, linha);
    case 'Trap123': return trap123(V, spec.janela ?? 10, spec.validade ?? 3);
    case 'MinimoN': case 'MaximoN': {
      if (!spec.de) throw new Error(`${nome} precisa de "de": { "nome": ... } (o indicador de origem)`);
      const x = calcularIndicador(spec.de, V), n = spec.periodo || 10, out = nulos(V.length), menor = nome === 'MinimoN';
      for (let i = n - 1; i < V.length; i++) {
        let m = menor ? Infinity : -Infinity, ok = true;
        for (let j = i - n + 1; j <= i; j++) { if (x[j] == null) { ok = false; break; } m = menor ? Math.min(m, x[j]) : Math.max(m, x[j]); }
        if (ok) out[i] = m;
      }
      return out;
    }
    default:
      if (FASE2.includes(nome)) throw new Error(`${nome} chega na Fase 2`);
      throw new Error(`Indicador desconhecido: ${nome}. Disponíveis: ${Object.keys(INDICADORES).join(', ')}`);
  }
}

/* ================================================================ condições ==== */

function preparar(V) {
  const cache = new Map();
  return spec => {
    const k = JSON.stringify(spec);
    if (!cache.has(k)) cache.set(k, calcularIndicador(spec, V));
    return cache.get(k);
  };
}

export function avaliarCondicao(cond, i, serie) {
  const A = serie(cond.ind), a = cond.atras || 0;
  const B = typeof cond.valor === 'number' ? { fixo: cond.valor } : cond.valor;
  if (!B || (B.fixo == null && !B.ind)) throw new Error('condição sem "valor" (número ou { "ind": ... })');
  const SB = B.fixo != null ? null : serie(B.ind), bA = B.fixo != null ? 0 : (B.atras || 0);
  const val = k => SB ? SB[k] : B.fixo;
  const ia = i - a, ib = i - bA;
  if (ia < 0 || ib < 0) return false;
  const x = A[ia], y = val(ib);
  if (x == null || y == null) return false;
  switch (cond.op) {
    case '>': return x > y;
    case '<': return x < y;
    case '>=': return x >= y;
    case '<=': return x <= y;
    case 'cruza_acima': case 'cruza_abaixo': {
      if (ia < 1 || ib < 1) return false;
      const x0 = A[ia - 1], y0 = val(ib - 1);
      if (x0 == null || y0 == null) return false;
      return cond.op === 'cruza_acima' ? x0 <= y0 && x > y : x0 >= y0 && x < y;
    }
    default: throw new Error(`Operador desconhecido: ${cond.op} (use >, <, >=, <=, cruza_acima, cruza_abaixo)`);
  }
}

/** Grupo { modo: 'E' | 'OU' | 'SEQUENCIA', janela, condicoes }. Na sequência, cada condição acontece num candle
 *  POSTERIOR ao da anterior, e a última em até `janela` candles depois da primeira. Chamar em ordem (guarda estado). */
export function criarAvaliador(grupo, serie) {
  if (!grupo || !grupo.condicoes || !grupo.condicoes.length) return () => false;
  const conds = grupo.condicoes, modo = (grupo.modo || 'E').toUpperCase();
  if (modo === 'E') return i => conds.every(c => avaliarCondicao(c, i, serie));
  if (modo === 'OU') return i => conds.some(c => avaliarCondicao(c, i, serie));
  if (modo !== 'SEQUENCIA') throw new Error(`Modo desconhecido: ${grupo.modo} (use E, OU ou SEQUENCIA)`);
  const janela = grupo.janela ?? 10;
  let passo = 0, inicio = -1, ultimo = -1;
  return i => {
    if (passo > 0 && i - inicio > janela) passo = 0;
    if (passo > 0 && i > ultimo && avaliarCondicao(conds[passo], i, serie)) { passo++; ultimo = i; }
    else if (passo === 0 && avaliarCondicao(conds[0], i, serie)) { passo = 1; inicio = ultimo = i; }
    if (passo === conds.length) { passo = 0; return true; }
    return false;
  };
}

/** Junta candles em um tempo gráfico maior (alinhado em UTC). Só usado quando não vêm os candles reais dele. */
export function agregar(V, ms) {
  const out = [];
  for (const x of V) {
    const t = Math.floor(x.t / ms) * ms, u = out[out.length - 1];
    if (u && u.t === t) { u.h = Math.max(u.h, x.h); u.l = Math.min(u.l, x.l); u.c = x.c; u.v += x.v; }
    else out.push({ t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v });
  }
  return out;
}

/* ================================================================ estratégia ==== */

function normalizar(E, ativo) {
  const erros = [];
  if (!E.entrada || !E.entrada.condicoes || !E.entrada.condicoes.length) erros.push('falta "entrada.condicoes"');
  if (!['compra', 'venda'].includes(E.lado)) erros.push('"lado" deve ser "compra" ou "venda"');
  const g = (E.gatilho || {}).tipo || 'abertura';
  if (!['fechamento', 'abertura', 'rompimento'].includes(g)) erros.push('"gatilho.tipo" deve ser abertura, fechamento ou rompimento');
  const P = E.posicao || {}, alav = P.alavancagem ?? 1, max = ALAV_MAX[ativo];
  if (!(alav > 0)) erros.push('"posicao.alavancagem" deve ser maior que zero');
  if (max && alav > max) erros.push(`alavancagem ${alav}x acima do máximo da Hyperliquid para ${ativo} (${max}x)`);
  const T = { ...(P.tamanho || { tipo: 'caixa', valor: 100 }) };
  if (T.tipo === 'capital') T.tipo = 'caixa';
  if (!['risco', 'risco_valor', 'caixa', 'valor'].includes(T.tipo)) erros.push('"posicao.tamanho.tipo" deve ser risco, risco_valor, caixa ou valor');
  const S = E.saida || {};
  if ((T.tipo === 'risco' || T.tipo === 'risco_valor') && !S.stop) erros.push('tamanho por risco precisa de "saida.stop"');
  if (T.tipo === 'caixa' && T.valor > 100) erros.push('tamanho por % da caixa vai até 100 (a alavancagem multiplica)');
  const stopTipos = ['percentual', 'atr', 'trailing', 'minima_sinal'];
  if (S.stop && !stopTipos.includes(S.stop.tipo)) erros.push(`stop.tipo deve ser ${stopTipos.join(', ')}`);
  let alvos = S.alvos ? S.alvos.map(a => ({ ...a })) : S.alvo ? [{ ...S.alvo, fracao: 100 }] : [];
  if (alvos.length > MAX_ALVOS) erros.push(`no máximo ${MAX_ALVOS} alvos`);
  const soma = alvos.reduce((s, a) => s + (a.fracao ?? 100 / alvos.length), 0);
  if (soma > 100.0001) erros.push('a soma das frações dos alvos passa de 100%');
  alvos.forEach(a => {
    if (a.fracao == null) a.fracao = 100 / alvos.length;
    if (!['risco', 'percentual'].includes(a.tipo)) erros.push('alvo.tipo deve ser risco ou percentual');
    if (a.tipo === 'risco' && !S.stop) erros.push('alvo em R precisa de stop');
    if (a.depois && !['nenhuma', 'break_even', 'alvo_anterior'].includes(a.depois)) erros.push('alvo.depois deve ser nenhuma, break_even ou alvo_anterior');
  });
  if (S.break_even && S.break_even.gatilho_r != null && !S.stop) erros.push('break-even em R precisa de stop');
  const F = E.filtros || {};
  if (F.horas_utc && !(Array.isArray(F.horas_utc) && F.horas_utc.length === 2)) erros.push('filtros.horas_utc = [início, fim] em horas UTC (fim exclusivo)');
  if (erros.length) throw new Error('Estratégia inválida: ' + erros.join('; '));
  return { gat: g, alav, T, S, alvos, F, passo: P.passo_qtd ?? 0.0001 };
}

/* ================================================================ motor ==== */

/**
 * @param E   estratégia (JSON)
 * @param V   candles [{t,o,h,l,c,v}] em ordem, t = abertura em ms
 * @param opc { ativo, intervalo, funding: [{t, r}] (taxa por hora), capital, custos,
 *              refino: [{ intervalo: '5m', velas: [...] }, ...] candles menores para desempatar stop × alvo,
 *              intrabar: 'conservador' (padrão) | 'otimista' — só para medir quanto a regra do candle do rompimento pesa,
 *              maior: { intervalo: '1d', velas: [...] } candles do tempo gráfico maior (se faltar, agrega os de V) }
 */
export function rodarBacktest(E, V, opc = {}) {
  const ativo = opc.ativo || E.ativo || 'BTC';
  const N = normalizar(E, ativo);
  const ivNome = opc.intervalo || E.intervalo || '1h', iv = INTERVALO_MS[ivNome] || HORA;
  const custos = { ...CUSTOS_PADRAO, ...(opc.custos || {}) };
  const tk = custos.taker / 100, mk = custos.maker / 100, sl = custos.derrapagem / 100;
  const capital0 = opc.capital ?? E.capital ?? 10_000;
  const side = E.lado === 'compra' ? 1 : -1;
  const { gat, alav, T, S, alvos, F, passo } = N;
  const mmr = 1 / (2 * (ALAV_MAX[ativo] || 50));
  const validade = (E.gatilho || {}).validade ?? 1;
  const serie = preparar(V);
  const sinalEntrada = criarAvaliador(E.entrada, serie);
  const sinalSaida = S.sinal ? criarAvaliador(S.sinal, serie) : null;
  const atrStop = S.stop && S.stop.tipo === 'atr' ? serie({ nome: 'ATR', periodo: S.stop.periodo || 14 }) : null;
  const FUND = custos.funding ? (opc.funding || []) : [];
  const arred = q => Math.floor(q / passo + 1e-9) * passo;

  // filtro no tempo gráfico maior: só candles já fechados
  let maior = null;
  if (F.maior) {
    const ivM = INTERVALO_MS[F.maior.intervalo];
    if (!ivM || ivM <= iv) throw new Error('filtros.maior.intervalo deve ser maior que o intervalo do teste (4h ou 1d)');
    const VM = opc.maior && opc.maior.velas && opc.maior.velas.length ? opc.maior.velas : agregar(V, ivM);
    const av = criarAvaliador(F.maior, preparar(VM));
    maior = { VM, ivM, av, k: -1, res: [] };
  }
  const passaMaior = tDec => {
    if (!maior) return true;
    while (maior.k + 1 < maior.VM.length && maior.VM[maior.k + 1].t + maior.ivM <= tDec) { maior.k++; maior.res[maior.k] = maior.av(maior.k); }
    return maior.k >= 0 && maior.res[maior.k];
  };
  const passaHorario = tDec => {
    const d = new Date(tDec);
    if (F.dias && !F.dias.includes(d.getUTCDay())) return false;
    if (F.horas_utc) {
      const [a, b] = F.horas_utc, h = d.getUTCHours();
      if (a === b) return true;
      return a < b ? h >= a && h < b : h >= a || h < b;   // janela que vira a meia-noite
    }
    return true;
  };

  // candles menores para o refino (o mais fino que cobrir o candle inteiro)
  const refinos = (opc.refino || []).filter(r => r.velas && r.velas.length && INTERVALO_MS[r.intervalo] < iv)
    .sort((a, b) => INTERVALO_MS[a.intervalo] - INTERVALO_MS[b.intervalo]);
  const subvelas = t => {
    for (const r of refinos) {
      const ms = INTERVALO_MS[r.intervalo], R = r.velas, quer = iv / ms;
      let lo = 0, hi = R.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (R[m].t < t) lo = m + 1; else hi = m; }
      if (lo + quer <= R.length && R[lo].t === t && R[lo + quer - 1].t === t + iv - ms) return { velas: R.slice(lo, lo + quer), ms };
    }
    return null;
  };

  let fi = 0;
  const precoNoTempo = t => {
    let lo = 0, hi = V.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (V[m].t <= t) lo = m; else hi = m - 1; }
    return V[lo].o;
  };
  let caixa = capital0, pos = null, pend = null;
  const trades = [], curva = [];
  const ignorados = { stop_invalido: 0, sem_capital: 0, filtro: 0 };
  const empates = { total: 0, refino: 0, stop_assumido: 0 };
  let taxasTot = 0, fundTot = 0;

  const cobrarFunding = ate => {
    while (fi < FUND.length && FUND[fi].t < pos.desde) fi++;
    while (fi < FUND.length && FUND[fi].t < ate) {
      const f = FUND[fi];
      pos.funding += side * f.r * pos.qtd * precoNoTempo(f.t); fi++;
    }
  };

  function abrir(i, jGestao, precoRef, tEntrada, iEntrada) {
    const ent = precoRef * (1 + side * sl);
    let stop = null;
    if (S.stop) {
      const st = S.stop;
      if (st.tipo === 'minima_sinal') stop = side === 1 ? V[i].l : V[i].h;
      else if (st.tipo === 'percentual' || st.tipo === 'trailing') stop = ent * (1 - side * st.valor / 100);
      else if (st.tipo === 'atr') stop = atrStop[i] == null ? null : ent - side * st.valor * atrStop[i];   // ATR do candle sinal
      if (stop == null || (side === 1 ? stop >= ent : stop <= ent)) { ignorados.stop_invalido++; return; }
    }
    const R = stop == null ? null : Math.abs(ent - stop);
    let qtd;
    if (T.tipo === 'risco') qtd = caixa * T.valor / 100 / R;
    else if (T.tipo === 'risco_valor') qtd = T.valor / R;
    else if (T.tipo === 'caixa') qtd = caixa * T.valor / 100 * alav / ent;
    else qtd = T.valor / ent;                                   // valor fixo da posição (nocional) em US$
    let limitado = false;
    if (qtd * ent / alav > caixa) { qtd = caixa * alav / ent; limitado = true; }
    qtd = arred(qtd);
    if (!(qtd >= passo) || caixa <= 0) { ignorados.sem_capital++; return; }
    const nocional = qtd * ent, margem = nocional / alav, taxa = nocional * tk;
    const precoAlvo = a => a.tipo === 'risco' ? ent + side * a.valor * R : ent * (1 + side * a.valor / 100);
    // quantidade de cada alvo (arredondada); o que sobrar segue para as outras saídas
    let resta = qtd;
    const alvosPos = alvos.map(a => { const q = Math.min(resta, arred(qtd * a.fracao / 100)); resta -= q; return { ...a, preco: precoAlvo(a), qtd: q, feito: false }; })
      .filter(a => a.qtd > 0);
    const liq = side === 1 ? ent * (1 - 1 / alav) / (1 - mmr) : ent * (1 + 1 / alav) / (1 + mmr);
    caixa -= taxa; taxasTot += taxa;
    pos = { i, iEnt: iEntrada, j0: jGestao, ent, qtd, qtd0: qtd, nocional, margem, stop, stop0: stop, R, alvos: alvosPos, liq,
            be: false, proxStop: null, melhor: ent, taxas: taxa, funding: 0, bruto: 0, saidas: [], desde: tEntrada,
            caixaAntes: caixa + taxa, limitado, candles: 0, tEnt: tEntrada, rompimento: gat === 'rompimento' };
  }

  // executa uma parte da posição (alvo parcial ou saída final)
  function executar(px, qtd, motivo, maker, t) {
    const preco = maker || motivo === 'liquidação' ? px : px * (1 - side * sl);
    const taxa = motivo === 'liquidação' ? 0 : qtd * preco * (maker ? mk : tk);
    const bruto = motivo === 'liquidação' ? -pos.margem * qtd / pos.qtd0 : side * qtd * (preco - pos.ent);
    pos.bruto += bruto; pos.taxas += taxa; taxasTot += taxa;
    caixa += bruto - taxa;
    pos.saidas.push({ t, preco, qtd, motivo });
    pos.qtd = Math.max(0, pos.qtd - qtd);
    if (pos.qtd < passo / 2) pos.qtd = 0;
  }

  function encerrar(j, tSaida) {
    cobrarFunding(tSaida);
    caixa -= pos.funding; fundTot += pos.funding;
    const pnl = pos.bruto - pos.taxas - pos.funding;
    const qs = pos.saidas.reduce((s, x) => s + x.qtd, 0);
    const pm = pos.saidas.reduce((s, x) => s + x.preco * x.qtd, 0) / qs;
    const d = new Date(pos.tEnt);
    const ult = pos.saidas[pos.saidas.length - 1];
    trades.push({ n: trades.length + 1, lado: E.lado, i_sinal: pos.i, i_entrada: pos.iEnt, i_saida: j, t_entrada: pos.tEnt, t_saida: tSaida,
      entrada: pos.ent, saida: pm, stop: pos.stop0, alvo: pos.alvos.length ? pos.alvos[0].preco : null, liq: pos.liq, qtd: pos.qtd0, nocional: pos.nocional, margem: pos.margem,
      motivo: ult.motivo, parciais: pos.saidas.filter(x => x.motivo.startsWith('alvo')).length, saidas: pos.saidas,
      pnl, ret: pnl / pos.caixaAntes, r: pos.R ? pnl / (pos.qtd0 * pos.R) : null,
      taxas: pos.taxas, funding: pos.funding, candles: pos.candles, limitado: pos.limitado, hora: d.getUTCHours(), dia: d.getUTCDay() });
    pos = null;
  }

  // ação no stop depois de um alvo parcial
  function depoisDoAlvo(a, k) {
    if (a.depois === 'break_even') { if (pos.stop == null || side * (pos.ent - pos.stop) > 0) { pos.stop = pos.ent; pos.be = true; } }
    else if (a.depois === 'alvo_anterior') {
      const ant = k > 0 ? pos.alvos[k - 1].preco : pos.ent;
      if (pos.stop == null || side * (ant - pos.stop) > 0) { pos.stop = ant; pos.be = true; }
    }
  }

  /* Um trecho de preço (o candle inteiro ou um candle menor do refino). Devolve true se a posição acabou.
   * Ordem dentro do trecho: caminho adverso primeiro (stop/liquidação); se tocou o stop, os alvos do mesmo trecho
   * não valem (conservador). `podeAlvo` = false no candle em que o rompimento foi executado. */
  function trecho(b, podeAlvo, tFim, favoravelPrimeiro = false) {
    const adv = side === 1 ? b.l : b.h, fav = side === 1 ? b.h : b.l, abre = b.o;
    const alem = (px, nivel) => side === 1 ? px <= nivel : px >= nivel;
    const niveis = [{ px: pos.liq, tipo: 'liq' }];
    if (pos.stop != null) niveis.push({ px: pos.stop, tipo: 'stop' });
    niveis.sort((x, y) => side === 1 ? y.px - x.px : x.px - y.px);
    const nv = niveis[0], meio = b.t + (tFim - b.t) / 2;
    const adverso = () => {
      if (!alem(adv, nv.px)) return false;
      const motivo = S.stop && S.stop.tipo === 'trailing' && pos.stop !== pos.stop0 ? 'trailing' : pos.be ? 'break-even' : 'stop';
      if (nv.tipo === 'liq' || alem(abre, pos.liq)) executar(pos.liq, pos.qtd, 'liquidação', false, alem(abre, nv.px) ? b.t : meio);
      else executar(alem(abre, nv.px) ? abre : nv.px, pos.qtd, motivo, false, alem(abre, nv.px) ? b.t : meio);
      return true;
    };
    if (!favoravelPrimeiro && adverso()) return true;
    if (podeAlvo) {
      pos.alvos.forEach((a, k) => {
        if (a.feito || pos.qtd <= 0) return;
        if (side === 1 ? fav >= a.preco : fav <= a.preco) {
          const px = side === 1 ? Math.max(a.preco, abre) : Math.min(a.preco, abre);
          a.feito = true;
          executar(px, Math.min(a.qtd, pos.qtd), `alvo ${k + 1}`, true, meio);
          depoisDoAlvo(a, k);
        }
      });
      if (pos.qtd <= 0) return true;
    }
    if (favoravelPrimeiro && adverso()) return true;
    return false;
  }

  const tocaAdverso = b => {
    const adv = side === 1 ? b.l : b.h;
    return (pos.stop != null && (side === 1 ? adv <= pos.stop : adv >= pos.stop)) || (side === 1 ? adv <= pos.liq : adv >= pos.liq);
  };
  const tocaAlvo = b => pos.alvos.some(a => !a.feito && (side === 1 ? b.h >= a.preco : b.l <= a.preco));

  for (let j = 0; j < V.length; j++) {
    const c = V[j], fimT = c.t + iv;

    // 1) ordem de rompimento pendente
    if (!pos && pend) {
      if (j > pend.ate) pend = null;
      else if (side === 1 ? c.h >= pend.nivel : c.l <= pend.nivel) {
        const ref = side === 1 ? Math.max(pend.nivel, c.o) : Math.min(pend.nivel, c.o);
        const i = pend.i; pend = null;
        abrir(i, j, ref, c.t + iv / 2, j);
      }
    }

    // 2) posição aberta
    if (pos && j >= pos.j0) {
      pos.candles++;
      if (pos.proxStop != null) { pos.stop = pos.proxStop; pos.proxStop = null; }   // break-even/trailing do candle anterior
      const noRompimento = pos.rompimento && j === pos.j0;
      let acabou;
      if (noRompimento && opc.intrabar === 'otimista') {
        // cenário otimista (só para medir o efeito da regra conservadora): no candle da execução, a mínima veio ANTES
        // do rompimento; depois o preço foi à máxima e terminou no fechamento. Stop só se o fechamento passou dele.
        const b = side === 1 ? { t: c.t, o: pos.ent, h: c.h, l: c.c, c: c.c } : { t: c.t, o: pos.ent, h: c.c, l: c.l, c: c.c };
        acabou = trecho(b, true, fimT, true);
      } else if (!noRompimento && tocaAdverso(c) && tocaAlvo(c)) {
        // empate dentro do candle: candles menores decidem; sem eles, vale o stop
        empates.total++;
        const sub = subvelas(c.t);
        if (sub) {
          empates.refino++;
          acabou = false;
          for (let k = 0; k < sub.velas.length && !acabou; k++) acabou = trecho(sub.velas[k], true, sub.velas[k].t + sub.ms);
        } else { empates.stop_assumido++; acabou = trecho(c, false, fimT); }
      } else acabou = trecho(c, !noRompimento, fimT);

      if (acabou) encerrar(j, pos.saidas[pos.saidas.length - 1].t);
      else {
        // break-even e trailing: decididos neste candle, valem a partir do próximo
        const fav = side === 1 ? c.h : c.l;
        if (side * (fav - pos.melhor) > 0) pos.melhor = fav;
        let novo = pos.stop;
        const be = S.break_even;
        if (be && !pos.be) {
          const nivel = be.gatilho_r != null && pos.R != null ? pos.ent + side * be.gatilho_r * pos.R
            : be.gatilho_pct != null ? pos.ent * (1 + side * be.gatilho_pct / 100) : null;
          if (nivel != null && side * (pos.melhor - nivel) >= 0 && (novo == null || side * (pos.ent - novo) > 0)) { novo = pos.ent; pos.be = true; }
        }
        if (S.stop && S.stop.tipo === 'trailing') {
          const tr = pos.melhor * (1 - side * S.stop.valor / 100);
          if (novo == null || side * (tr - novo) > 0) novo = tr;
        }
        if (novo !== pos.stop) pos.proxStop = novo;
        // saídas no fechamento
        const liquido = () => pos.bruto + side * pos.qtd * (c.c * (1 - side * sl) - pos.ent) - pos.taxas - pos.qtd * c.c * tk - pos.funding;
        let motivo = null;
        if (sinalSaida && sinalSaida(j)) motivo = 'sinal de saída';
        else if (S.tempo_max && pos.candles >= S.tempo_max) motivo = 'tempo';
        else if (S.primeiro_lucro) { cobrarFunding(fimT); if (liquido() > 0) motivo = 'primeiro lucro'; }
        if (motivo) { executar(c.c, pos.qtd, motivo, false, fimT); encerrar(j, fimT); }
      }
    } else if (sinalSaida && !pos) sinalSaida(j);   // mantém o estado da sequência de saída

    // 3) sinal de entrada no fechamento deste candle
    const sinal = sinalEntrada(j);
    // "renovar": um sinal novo enquanto a ordem de rompimento espera troca a ordem por ele (ex.: trap com mínima menor)
    if (!pos && sinal && caixa > 0 && (!pend || (gat === 'rompimento' && (E.gatilho || {}).renovar))) {
      const tDec = fimT;
      if (!passaHorario(tDec) || !passaMaior(tDec)) ignorados.filtro++;
      else if (gat === 'fechamento') abrir(j, j + 1, c.c, fimT, j);
      else if (gat === 'abertura') { if (j + 1 < V.length) abrir(j, j + 1, V[j + 1].o, V[j + 1].t, j + 1); }
      else pend = { i: j, nivel: side === 1 ? c.h : c.l, ate: j + validade };
    }

    // curva de patrimônio (marcada a mercado no fechamento)
    let eq = caixa;
    if (pos) {
      cobrarFunding(fimT);
      eq = caixa + Math.max(-pos.margem * pos.qtd / pos.qtd0, side * pos.qtd * (c.c - pos.ent)) - pos.funding;
    }
    curva.push({ t: fimT, eq });
  }
  if (pos) {
    const u = V[V.length - 1];
    executar(u.c, pos.qtd, 'fim dos dados', false, u.t + iv);
    encerrar(V.length - 1, u.t + iv);
    curva[curva.length - 1].eq = caixa;
  }
  return { trades, curva, capital0, final: caixa, taxas: taxasTot, funding: fundTot, ignorados, empates,
           inicio: V.length ? V[0].t : null, fim: V.length ? V[V.length - 1].t + iv : null, ativo, alav, gatilho: gat };
}

/* ================================================================ métricas ==== */

export function metricas(res) {
  const T = res.trades, n = T.length, C = res.curva, E0 = res.capital0;
  const ganhos = T.filter(x => x.pnl > 0), perdas = T.filter(x => x.pnl <= 0);
  const media = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const gMed = media(ganhos.map(x => x.pnl)), pMed = media(perdas.map(x => x.pnl));
  let pico = E0, dd = 0, ddUsd = 0, abaixo = 0, maiorPeriodo = 0, inicioQueda = null;
  for (const p of C) {
    if (p.eq >= pico) { if (inicioQueda != null) maiorPeriodo = Math.max(maiorPeriodo, p.t - inicioQueda); pico = p.eq; inicioQueda = null; }
    else { abaixo++; if (inicioQueda == null) inicioQueda = p.t; dd = Math.max(dd, 1 - p.eq / pico); ddUsd = Math.max(ddUsd, pico - p.eq); }
  }
  if (inicioQueda != null && C.length) maiorPeriodo = Math.max(maiorPeriodo, C[C.length - 1].t - inicioQueda);
  // Sharpe com o patrimônio de fim de cada dia (UTC), anualizado por √365 (cripto negocia todo dia)
  const porDia = new Map();
  C.forEach(p => porDia.set(Math.floor((p.t - 1) / 86_400_000), p.eq));
  const diarios = [...porDia.values()], rets = [];
  for (let k = 1; k < diarios.length; k++) rets.push(diarios[k] / diarios[k - 1] - 1);
  const mr = media(rets), sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - mr) ** 2, 0) / (rets.length - 1)) : null;
  const anos = res.fim && res.inicio ? (res.fim - res.inicio) / (365.25 * 86_400_000) : null;
  return {
    operacoes: n, acerto: n ? ganhos.length / n : null,
    ganho_medio: gMed, perda_media: pMed, payoff: gMed != null && pMed ? gMed / Math.abs(pMed) : null,
    ganho_medio_pct: media(ganhos.map(x => x.ret)), perda_media_pct: media(perdas.map(x => x.ret)),
    retorno: res.final / E0 - 1, cagr: anos && res.final > 0 ? Math.pow(res.final / E0, 1 / anos) - 1 : null, anos,
    maior_queda: dd, maior_queda_usd: ddUsd, sharpe: sd ? mr / sd * Math.sqrt(365) : null,
    fator_recuperacao: ddUsd ? (res.final - E0) / ddUsd : null,
    tempo_em_queda: C.length ? abaixo / C.length : null, maior_periodo_queda_dias: maiorPeriodo / 86_400_000,
    taxas: res.taxas, funding: res.funding, custo_total: res.taxas + res.funding,
    expectativa_r: media(T.filter(x => x.r != null).map(x => x.r)),
    liquidacoes: T.filter(x => x.motivo === 'liquidação').length,
  };
}

/** Comprar e segurar: patrimônio de quem pôs o capital no ativo no primeiro fechamento. */
export function compraESegura(V, capital0, tempos) {
  if (!V.length) return [];
  const base = V[0].c;
  if (!tempos) return V.map(x => ({ t: x.t, eq: capital0 * x.c / base }));
  let k = 0;
  return tempos.map(t => { while (k + 1 < V.length && V[k + 1].t < t) k++; return { t, eq: capital0 * V[k].c / base }; });
}

/* ================================================================ Monte Carlo e permutação ==== */

export function rng(seed = 12345) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Sorteia `proximas` operações (sem repetir quando há operações suficientes; com repetição quando há menos) e
 *  mede a maior queda de cada caminho: chance de cair 20%, 30% e 50% e percentis do resultado. */
export function monteCarlo(trades, { rodadas = 5000, proximas = 100, seed = 7 } = {}) {
  const r = trades.map(x => x.ret).filter(x => Number.isFinite(x));
  if (!r.length) return null;
  const R = rng(seed), quedas = [], finais = [];
  const semRepetir = r.length >= proximas;
  for (let k = 0; k < rodadas; k++) {
    let eq = 1, pico = 1, dd = 0;
    const pool = semRepetir ? r.slice() : null;
    for (let m = 0; m < proximas; m++) {
      let x;
      if (semRepetir) { const idx = m + Math.floor(R() * (pool.length - m)); [pool[m], pool[idx]] = [pool[idx], pool[m]]; x = pool[m]; }
      else x = r[Math.floor(R() * r.length)];
      eq *= 1 + x;
      if (eq > pico) pico = eq; else dd = Math.max(dd, 1 - eq / pico);
      if (eq <= 0) { dd = 1; break; }
    }
    quedas.push(dd); finais.push(eq - 1);
  }
  finais.sort((a, b) => a - b);
  const pct = q => finais[Math.min(finais.length - 1, Math.floor(q * finais.length))];
  const chance = lim => quedas.filter(d => d >= lim).length / rodadas;
  return { rodadas, proximas, com_repeticao: !semRepetir, queda20: chance(0.2), queda30: chance(0.3), queda50: chance(0.5),
           final_p5: pct(0.05), final_p50: pct(0.5), final_p95: pct(0.95) };
}

/** Teste de permutação: o resultado muda com o grupo (hora UTC ou dia da semana da entrada)?
 *  Estatística = soma entre grupos n·(média do grupo − média geral)²; embaralha os rótulos `rodadas` vezes. */
export function permutacao(trades, chave, { rodadas = 2000, seed = 11 } = {}) {
  const x = trades.map(t => t.ret), g = trades.map(t => t[chave]);
  const n = x.length;
  if (n < 2) return null;
  const media = x.reduce((s, v) => s + v, 0) / n;
  const estat = rot => {
    const soma = new Map(), cont = new Map();
    rot.forEach((k, i) => { soma.set(k, (soma.get(k) || 0) + x[i]); cont.set(k, (cont.get(k) || 0) + 1); });
    let s = 0; soma.forEach((v, k) => { const m = v / cont.get(k); s += cont.get(k) * (m - media) ** 2; });
    return s;
  };
  const obs = estat(g), R = rng(seed), rot = g.slice();
  let maiores = 0;
  for (let k = 0; k < rodadas; k++) {
    for (let i = rot.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [rot[i], rot[j]] = [rot[j], rot[i]]; }
    if (estat(rot) >= obs - 1e-15) maiores++;
  }
  const grupos = {};
  g.forEach((k, i) => { const G = grupos[k] || (grupos[k] = { n: 0, soma: 0, ganhos: 0 }); G.n++; G.soma += x[i]; if (x[i] > 0) G.ganhos++; });
  Object.values(grupos).forEach(G => { G.media = G.soma / G.n; G.acerto = G.ganhos / G.n; delete G.soma; delete G.ganhos; });
  const p = (maiores + 1) / (rodadas + 1);
  return { p, rodadas, grupos, n,
           frase: n < 30 ? `Poucas operações (${n}) para dizer qualquer coisa sobre horários.`
             : p < 0.05 ? `A diferença entre os grupos parece real (p = ${p.toFixed(3)}): em só ${(p * 100).toFixed(1)}% dos embaralhamentos o acaso produziu diferença igual ou maior. Confira com mais dados antes de filtrar por isso.`
               : `A diferença entre os grupos é compatível com o acaso (p = ${p.toFixed(2)}): não filtre por isso.` };
}
