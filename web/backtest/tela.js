/* Aba Backtest do Radar de Carteiras: formulário + editor de JSON, dados, resultados.
 * Dados: primeiro o banco do radar (/api/historico, com a senha); o que faltar vem direto da Hyperliquid pelo
 * navegador (os 5.000 candles mais recentes e o funding, guardado no navegador para não baixar de novo). */
import { rodarBacktest, metricas, compraESegura, monteCarlo, permutacao, CUSTOS_PADRAO, ALAV_MAX, INTERVALO_MS, INDICADORES, HORA } from './motor.js';

const ATIVOS = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'NEAR'];
const HL = 'https://api.hyperliquid.xyz/info';
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/* ---------------------------------------------------------------- modelos ---- */
const MODELOS = {
  'Cruzamento de médias (MME 9 × 21)': {
    nome: 'Cruzamento MME 9 x 21', lado: 'compra',
    entrada: { modo: 'E', condicoes: [
      { ind: { nome: 'MME', periodo: 9 }, op: 'cruza_acima', valor: { ind: { nome: 'MME', periodo: 21 } } }] },
    gatilho: { tipo: 'abertura' },
    saida: { stop: { tipo: 'atr', valor: 2, periodo: 14 }, alvos: [{ fracao: 100, tipo: 'risco', valor: 2 }], tempo_max: 48 },
    posicao: { alavancagem: 3, tamanho: { tipo: 'risco', valor: 1 } } },
  'Tendência com saídas parciais, trailing e filtro no diário': {
    nome: 'Donchian + parciais', lado: 'compra',
    entrada: { modo: 'E', condicoes: [
      { ind: { nome: 'preco', campo: 'fechamento' }, op: 'cruza_acima', valor: { ind: { nome: 'Donchian', periodo: 20, linha: 'superior' } } },
      { ind: { nome: 'ADX', periodo: 14 }, op: '>', valor: 20 }] },
    filtros: { maior: { intervalo: '1d', modo: 'E', condicoes: [
      { ind: { nome: 'preco', campo: 'fechamento' }, op: '>', valor: { ind: { nome: 'MME', periodo: 50 } } }] } },
    gatilho: { tipo: 'abertura' },
    saida: { stop: { tipo: 'trailing', valor: 3 },
             alvos: [{ fracao: 50, tipo: 'risco', valor: 1, depois: 'break_even' }, { fracao: 25, tipo: 'risco', valor: 2, depois: 'alvo_anterior' }],
             tempo_max: 60 },
    posicao: { alavancagem: 3, tamanho: { tipo: 'risco', valor: 1 } } },
  'Tendência (diário): Donchian 20, saída na mínima de 10 dias': {
    nome: 'Tendência Donchian + mínima de 10 dias', lado: 'compra',
    entrada: { modo: 'E', condicoes: [
      { ind: { nome: 'preco', campo: 'fechamento' }, op: 'cruza_acima', valor: { ind: { nome: 'Donchian', periodo: 20, linha: 'superior' } } },
      { ind: { nome: 'ADX', periodo: 14 }, op: '>', valor: 20 },
      { ind: { nome: 'preco', campo: 'fechamento' }, op: '>', valor: { ind: { nome: 'MME', periodo: 50 } } }] },
    gatilho: { tipo: 'abertura' },
    saida: { sinal: { modo: 'E', condicoes: [{ ind: { nome: 'preco', campo: 'fechamento' }, op: '<', valor: { ind: { nome: 'Donchian', periodo: 10, linha: 'inferior' } } }] },
             stop: { tipo: 'atr', valor: 3, periodo: 14 }, tempo_max: 400 },
    posicao: { alavancagem: 3, tamanho: { tipo: 'risco', valor: 1 } } },
  'Stormer: trap no 1-2-3 com estocástico sobrevendido': {
    nome: 'Stormer: trap no 1-2-3', lado: 'compra',
    entrada: { modo: 'E', condicoes: [
      { ind: { nome: 'Trap123', janela: 10, validade: 3 }, op: '>', valor: 0.5 },
      { ind: { nome: 'MinimoN', periodo: 10, de: { nome: 'Estocastico', periodo: 14, suavizacao: 3, linha: 'k' } }, op: '<', valor: 20 },
      { ind: { nome: 'MME', periodo: 70 }, op: '>', valor: { ind: { nome: 'MME', periodo: 70 }, atras: 1 } }] },
    gatilho: { tipo: 'rompimento', validade: 3, renovar: true },
    saida: { stop: { tipo: 'minima_sinal' }, alvos: [{ fracao: 100, tipo: 'risco', valor: 2 }] },
    posicao: { alavancagem: 1, tamanho: { tipo: 'caixa', valor: 100 } } },
  'IFR 2 sobrevendido em tendência de alta': {
    nome: 'IFR2 em tendência de alta', lado: 'compra',
    entrada: { modo: 'E', condicoes: [
      { ind: { nome: 'preco', campo: 'fechamento' }, op: '>', valor: { ind: { nome: 'MMS', periodo: 200 } } },
      { ind: { nome: 'IFR', periodo: 2 }, op: '<', valor: 10 }] },
    gatilho: { tipo: 'fechamento' },
    saida: { sinal: { modo: 'E', condicoes: [{ ind: { nome: 'IFR', periodo: 2 }, op: '>', valor: 70 }] },
             stop: { tipo: 'atr', valor: 3, periodo: 14 }, tempo_max: 10 },
    posicao: { alavancagem: 2, tamanho: { tipo: 'risco', valor: 1 } } },
  'Rompimento da máxima de 20 candles': {
    nome: 'Rompimento de 20', lado: 'compra',
    entrada: { modo: 'E', condicoes: [
      { ind: { nome: 'preco', campo: 'fechamento' }, op: '>', valor: { ind: { nome: 'Maxima', periodo: 20 } } }] },
    gatilho: { tipo: 'rompimento', validade: 1 },
    saida: { stop: { tipo: 'minima_sinal' }, alvos: [{ fracao: 100, tipo: 'risco', valor: 3 }], break_even: { gatilho_r: 1 } },
    posicao: { alavancagem: 3, tamanho: { tipo: 'risco', valor: 1 } } },
  'Sequência: IFR 14 abaixo de 30, depois fecha acima da MME 9': {
    nome: 'Sequência IFR + MME', lado: 'compra',
    entrada: { modo: 'SEQUENCIA', janela: 6, condicoes: [
      { ind: { nome: 'IFR', periodo: 14 }, op: '<', valor: 30 },
      { ind: { nome: 'preco', campo: 'fechamento' }, op: 'cruza_acima', valor: { ind: { nome: 'MME', periodo: 9 } } }] },
    gatilho: { tipo: 'abertura' },
    saida: { stop: { tipo: 'percentual', valor: 3 }, alvos: [{ fracao: 100, tipo: 'percentual', valor: 6 }], break_even: { gatilho_pct: 3 }, tempo_max: 24 },
    posicao: { alavancagem: 2, tamanho: { tipo: 'caixa', valor: 50 } } },
  'Venda: perde a VWAP com HiLo em baixa': {
    nome: 'Venda VWAP + HiLo', lado: 'venda',
    entrada: { modo: 'E', condicoes: [
      { ind: { nome: 'preco', campo: 'fechamento' }, op: 'cruza_abaixo', valor: { ind: { nome: 'VWAP' } } },
      { ind: { nome: 'HiLo', periodo: 10, linha: 'tendencia' }, op: '<', valor: 0 }] },
    filtros: { horas_utc: [12, 21], dias: [1, 2, 3, 4, 5] },
    gatilho: { tipo: 'abertura' },
    saida: { stop: { tipo: 'atr', valor: 1.5, periodo: 14 }, alvos: [{ fracao: 100, tipo: 'risco', valor: 1.5 }], tempo_max: 12 },
    posicao: { alavancagem: 3, tamanho: { tipo: 'risco', valor: 0.5 } } },
};

/* ---------------------------------------------------------------- formatação ---- */
const nf = d => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const ok = v => v != null && Number.isFinite(v);
const num = (v, d = 0) => ok(v) ? nf(d).format(v) : '—';
const pct = (v, d = 1, sinal = true) => ok(v) ? (sinal && v >= 0 ? '+' : '') + nf(d).format(v * 100) + '%' : '—';
const usd = (v, sinal = false) => ok(v) ? (sinal && v >= 0 ? '+' : v < 0 ? '−' : '') + 'US$ ' + nf(Math.abs(v) >= 1000 ? 0 : 2).format(Math.abs(v)) : '—';
const preco = v => ok(v) ? nf(v >= 1000 ? 0 : v >= 10 ? 2 : 4).format(v) : '—';
const quando = ms => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear()).slice(2)} ${String(d.getUTCHours()).padStart(2, '0')}h`; };
const cls = v => !ok(v) ? 'muted' : v >= 0 ? 'pos' : 'neg';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cor = nome => getComputedStyle(document.documentElement).getPropertyValue(nome).trim() || '#888';
const guardar = { ler(k, d) { try { const v = localStorage.getItem('bt-' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
                  gravar(k, v) { try { localStorage.setItem('bt-' + k, JSON.stringify(v)); } catch (e) {} } };

/* ---------------------------------------------------------------- dados ---- */
const dormir = ms => new Promise(r => setTimeout(r, ms));
async function hl(corpo) {
  for (let k = 0; k < 5; k++) {
    const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    if (r.status === 429) { await dormir(2000 * (k + 1)); continue; }
    if (!r.ok) throw new Error('Hyperliquid ' + r.status);
    return r.json();
  }
  throw new Error('Hyperliquid limitou as consultas; tente de novo em um minuto');
}
async function velasHL(coin, iv) {
  const agora = Date.now(), dur = INTERVALO_MS[iv];
  const r = await hl({ type: 'candleSnapshot', req: { coin, interval: iv, startTime: 0, endTime: agora } });
  return r.filter(v => v.t + dur <= agora).map(v => ({ t: v.t, o: +v.o, h: +v.h, l: +v.l, c: +v.c, v: +v.v }));
}
// funding guardado no navegador (IndexedDB): só a primeira vez baixa o histórico inteiro
function idb() {
  return new Promise((ok, erro) => {
    const r = indexedDB.open('radar-backtest', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('funding', { keyPath: 'coin' });
    r.onsuccess = () => ok(r.result); r.onerror = () => erro(r.error);
  });
}
async function idbLer(coin) { try { const db = await idb(); return await new Promise(ok => { const q = db.transaction('funding').objectStore('funding').get(coin); q.onsuccess = () => ok(q.result); q.onerror = () => ok(null); }); } catch (e) { return null; } }
async function idbGravar(obj) { try { const db = await idb(); db.transaction('funding', 'readwrite').objectStore('funding').put(obj); } catch (e) {} }
async function paginasFunding(coin, de, ate, aviso) {
  let pts = [], ini = de;
  for (;;) {
    const r = await hl({ type: 'fundingHistory', coin, startTime: ini });
    if (!r.length) break;
    pts = pts.concat(r.map(p => [p.time, +p.fundingRate]));
    aviso && aviso(`funding de ${coin}: ${num(pts.length)} horas baixadas…`);
    if (r.length < 500 || r[r.length - 1].time >= ate) break;
    ini = r[r.length - 1].time + 1;
    await dormir(250);
  }
  return pts;
}
async function fundingHL(coin, desde, aviso) {
  const salvo = await idbLer(coin);
  let pts = (salvo && salvo.pts) || [];
  if (!pts.length) pts = await paginasFunding(coin, desde, Infinity, aviso);
  else {
    if (desde < pts[0][0] - HORA) pts = (await paginasFunding(coin, desde, pts[0][0], aviso)).filter(p => p[0] < pts[0][0]).concat(pts);
    const novos = await paginasFunding(coin, pts[pts.length - 1][0] + 1, Infinity, aviso);
    pts = pts.concat(novos.filter(p => p[0] > pts[pts.length - 1][0]));
  }
  idbGravar({ coin, pts });
  return pts;
}
const memo = new Map();
let bancoFora = 0;   // até quando não vale a pena perguntar ao banco do radar (ms)
async function doBanco(coin, iv, comFunding) {
  // banco do radar (histórico mais longo, gravado todo dia); fora do ar ou sem senha → segue só com a Hyperliquid
  try {
    let senha = ''; try { senha = localStorage.getItem('radar-senha') || ''; } catch (e) {}
    if (!senha || Date.now() < bancoFora) return null;   // sem senha o banco recusa (401): nem pergunta
    const r = await fetch(`api/historico?coin=${coin}&intervalo=${iv}${comFunding ? '' : '&sem_funding=1'}`, { headers: { 'x-senha': senha } });
    if (!r.ok) { bancoFora = Date.now() + 10 * 60e3; return null; }   // senha errada ou banco em pausa: não insiste por 10 min
    const j = await r.json();
    return { V: j.candles.map(x => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] })), F: j.funding || [] };
  } catch (e) { return null; }
}
async function velasUniao(coin, iv, aviso, banco) {
  const chave = 'v' + coin + iv, m = memo.get(chave);
  if (m && Date.now() - m.quando < 5 * 60e3) return m;
  const B = banco !== undefined ? banco : await doBanco(coin, iv, false);
  aviso && aviso(`baixando candles de ${coin} (${iv}) da Hyperliquid…`);
  const vh = await velasHL(coin, iv);
  const porT = new Map(((B && B.V) || []).map(x => [x.t, x]));
  vh.forEach(x => porT.set(x.t, x));
  const out = { V: [...porT.values()].sort((a, b) => a.t - b.t), fonte: [B && B.V.length ? 'banco do radar' : '', vh.length ? 'Hyperliquid' : ''].filter(Boolean).join(' + '), quando: Date.now() };
  memo.set(chave, out);
  return out;
}
async function carregar(coin, iv, aviso) {
  const chave = coin + iv, m = memo.get(chave);
  if (m && Date.now() - m.quando < 5 * 60e3) return m;
  const B = await doBanco(coin, iv, true);
  const U = await velasUniao(coin, iv, aviso, B);
  const V = U.V, F = (B && B.F) || [], fonte = [U.fonte];
  if (!V.length) throw new Error(`sem candles de ${coin}`);
  const ultF = F.length ? F[F.length - 1][0] : null;
  const fh = await fundingHL(coin, ultF != null ? ultF + 1 : V[0].t, aviso);
  const fm = new Map(F.map(p => [p[0], p[1]])); fh.forEach(p => fm.set(p[0], p[1]));
  const funding = [...fm.entries()].filter(p => p[0] >= V[0].t).sort((a, b) => a[0] - b[0]).map(([t, r]) => ({ t, r }));
  const out = { V, funding, fonte: fonte.join(' + '), quando: Date.now() };
  memo.set(chave, out);
  return out;
}

/* ---------------------------------------------------------------- execução ---- */
function lerForm() {
  const v = id => document.getElementById(id);
  return {
    ativo: v('btAtivo').value, intervalo: v('btIntervalo').value,
    capital: +v('btCapital').value || 10_000,
    custos: { taker: +v('btTaker').value, maker: +v('btMaker').value, derrapagem: +v('btSlip').value, funding: v('btFunding').checked },
  };
}
function lerJSON() {
  const txt = document.getElementById('btJson').value;
  try { return JSON.parse(txt); }
  catch (e) {
    const m = /position (\d+)/.exec(e.message), pos = m ? +m[1] : null;
    const linha = pos != null ? txt.slice(0, pos).split('\n').length : null;
    throw new Error('JSON inválido' + (linha ? ` perto da linha ${linha}` : '') + ': ' + e.message);
  }
}
function status(msg, erro = false) {
  const s = document.getElementById('btStatus');
  s.innerHTML = msg ? `<span class="${erro ? 'neg' : 'muted'}">${esc(msg)}</span>` : '';
}

// candles menores (5m e 15m) para desempatar stop x alvo, e candles do tempo gráfico maior para o filtro
async function auxiliares(E, coin, iv) {
  const refino = [];
  for (const r of ['5m', '15m']) {
    if (INTERVALO_MS[r] >= INTERVALO_MS[iv]) continue;
    try { refino.push({ intervalo: r, velas: (await velasUniao(coin, r, status)).V }); } catch (e) {}
  }
  let maior;
  const fm = (E.filtros || {}).maior;
  if (fm && INTERVALO_MS[fm.intervalo] > INTERVALO_MS[iv]) maior = { intervalo: fm.intervalo, velas: (await velasUniao(coin, fm.intervalo, status)).V };
  return { refino, maior };
}

async function rodar() {
  const botoes = [...document.querySelectorAll('#btApp button')];
  botoes.forEach(b => { b.disabled = true; });
  try {
    const E = lerJSON(), F = lerForm();
    guardar.gravar('json', document.getElementById('btJson').value);
    guardar.gravar('form', F);
    const D = await carregar(F.ativo, F.intervalo, status);
    const btc = F.ativo === 'BTC' ? D : await carregar('BTC', F.intervalo, status);
    const aux = await auxiliares(E, F.ativo, F.intervalo);
    status('calculando…');
    await dormir(10);
    const res = rodarBacktest(E, D.V, { ativo: F.ativo, intervalo: F.intervalo, funding: D.funding, capital: F.capital, custos: F.custos, ...aux });
    const m = metricas(res);
    const mc = monteCarlo(res.trades, { rodadas: 5000, proximas: 100 });
    const ph = permutacao(res.trades, 'hora', { rodadas: 2000 }), pd = permutacao(res.trades, 'dia', { rodadas: 2000 });
    desenharResultado({ E, F, D, btc, res, m, mc, ph, pd });
    status(`${num(D.V.length)} candles de ${quando(D.V[0].t)} a ${quando(D.V[D.V.length - 1].t)} UTC · fonte: ${D.fonte} · funding: ${num(D.funding.length)} horas`);
  } catch (e) {
    console.error(e);
    status(e.message, true);
  } finally { botoes.forEach(b => { b.disabled = false; }); }
}

async function rodarTodos() {
  const botoes = [...document.querySelectorAll('#btApp button')];
  botoes.forEach(b => { b.disabled = true; });
  const alvo = document.getElementById('btTodosRes');
  try {
    const E = lerJSON(), F = lerForm(), linhas = [];
    for (const a of ATIVOS) {
      try {
        const D = await carregar(a, F.intervalo, status);
        status(`calculando ${a}…`); await dormir(5);
        const alav = (E.posicao || {}).alavancagem ?? 1;
        const E2 = ALAV_MAX[a] && alav > ALAV_MAX[a] ? { ...E, posicao: { ...E.posicao, alavancagem: ALAV_MAX[a] } } : E;
        const aux = await auxiliares(E2, a, F.intervalo);
        const res = rodarBacktest(E2, D.V, { ativo: a, intervalo: F.intervalo, funding: D.funding, capital: F.capital, custos: F.custos, ...aux });
        const m = metricas(res);
        linhas.push({ a, m, bh: D.V[D.V.length - 1].c / D.V[0].c - 1, ajuste: E2 !== E ? ALAV_MAX[a] : null, desde: D.V[0].t });
      } catch (e) { linhas.push({ a, erro: e.message }); }
      desenharTodos(alvo, linhas, F);
    }
    status(`Pronto: ${F.intervalo} nos ${ATIVOS.length} ativos.`);
  } catch (e) { status(e.message, true); }
  finally { botoes.forEach(b => { b.disabled = false; }); }
}

function desenharTodos(alvo, linhas, F) {
  alvo.hidden = false;
  alvo.innerHTML = `<div class="box-head"><h2>Em todos os ativos · ${F.intervalo}</h2><p class="small muted">Mesma estratégia e mesmos custos em cada ativo. Cada um com o histórico que tiver (o 1h só cobre os últimos ~7 meses).</p></div>
    <div class="tbl-wrap"><table><thead><tr><th>Ativo</th><th class="n">Operações</th><th class="n">Acerto</th><th class="n">Payoff</th><th class="n">Retorno</th><th class="n">Comprar e segurar</th><th class="n">Maior queda</th><th class="n">Sharpe</th><th class="n">Custos</th><th>Desde</th></tr></thead><tbody>` +
    linhas.map(x => x.erro ? `<tr><td><b>${x.a}</b></td><td colspan="9" class="neg small">${esc(x.erro)}</td></tr>` :
      `<tr><td><b>${x.a}</b>${x.ajuste ? ` <span class="chip warn" title="alavancagem acima do máximo da Hyperliquid; usei ${x.ajuste}x">${x.ajuste}x</span>` : ''}</td>
       <td class="n">${num(x.m.operacoes)}${x.m.operacoes < 30 ? ' <span class="chip down" title="menos de 30 operações: diz pouco">poucas</span>' : ''}</td>
       <td class="n">${pct(x.m.acerto, 0, false)}</td><td class="n">${num(x.m.payoff, 2)}</td>
       <td class="n ${cls(x.m.retorno)}"><b>${pct(x.m.retorno)}</b></td><td class="n ${cls(x.bh)}">${pct(x.bh)}</td>
       <td class="n neg">${pct(-x.m.maior_queda)}</td><td class="n">${num(x.m.sharpe, 2)}</td><td class="n">${usd(x.m.custo_total)}</td>
       <td class="small muted">${quando(x.desde).slice(0, 8)}</td></tr>`).join('') + '</tbody></table></div>';
}

/* ---------------------------------------------------------------- resultado ---- */
function kpi(lab, val, nota = '', c = '') {
  return `<div class="kpi"><span class="lab">${lab}</span><span class="val ${c}">${val}</span><span class="note">${nota}</span></div>`;
}

function desenharResultado(X) {
  const { E, F, D, btc, res, m, mc, ph, pd } = X;
  const alvo = document.getElementById('btRes');
  alvo.hidden = false;
  const bh = compraESegura(D.V, res.capital0), bhFim = bh[bh.length - 1].eq / res.capital0 - 1;
  const tempos = res.curva.map(p => p.t);
  const bhBtc = compraESegura(btc.V.filter(x => x.t >= D.V[0].t), res.capital0, tempos);
  const T = res.trades;
  const ign = res.ignorados.stop_invalido + res.ignorados.sem_capital;
  const emp = res.empates;
  const GAT = { abertura: 'entrada na abertura seguinte', fechamento: 'entrada no fechamento do sinal', rompimento: 'entrada no rompimento' };
  alvo.innerHTML = `
    ${m.operacoes < 30 ? `<div class="bt-aviso"><b>Só ${m.operacoes} ${m.operacoes === 1 ? 'operação' : 'operações'}.</b> Com menos de 30, os números abaixo podem ser pura sorte ou azar: não tire conclusão.</div>` : ''}
    <div class="box"><div class="box-head"><h2>${esc(E.nome || 'Resultado')} · ${F.ativo} ${F.intervalo}</h2>
      <p class="small muted">${quando(res.inicio)} a ${quando(res.fim)} UTC (${num(m.anos * 12, 1)} meses) · capital inicial ${usd(res.capital0)} · ${E.lado} · ${res.alav}x · ${GAT[res.gatilho]}
      · taxas ${num(F.custos.taker, 3)}% / ${num(F.custos.maker, 3)}% · derrapagem ${num(F.custos.derrapagem, 3)}% · funding ${F.custos.funding ? 'cobrado' : 'desligado'}</p></div>
      <div class="kpis">
        ${kpi('Operações', num(m.operacoes), `${m.liquidacoes ? `<span class="neg">${m.liquidacoes} liquidação(ões)</span> · ` : ''}${ign ? `${ign} sinal(is) sem entrada` : 'acerto ' + pct(m.acerto, 0, false)}`)}
        ${kpi('Acerto · payoff', `${pct(m.acerto, 0, false)} · ${num(m.payoff, 2)}`, `ganho médio ${usd(m.ganho_medio)} (${pct(m.ganho_medio_pct)}) · perda média ${usd(m.perda_media)} (${pct(m.perda_media_pct)})`)}
        ${kpi('Retorno', pct(m.retorno), `comprar e segurar ${F.ativo}: ${pct(bhFim)} · CAGR ${pct(m.cagr)}`, cls(m.retorno))}
        ${kpi('Maior queda', pct(-m.maior_queda), `${usd(-m.maior_queda_usd)} · ${pct(m.tempo_em_queda, 0, false)} do tempo abaixo do pico · maior período ${num(m.maior_periodo_queda_dias, 0)} dias`, 'neg')}
        ${kpi('Sharpe · recuperação', `${num(m.sharpe, 2)} · ${num(m.fator_recuperacao, 2)}`, 'Sharpe anual (retornos diários, √365) · fator de recuperação = lucro ÷ maior queda')}
        ${kpi('Custos', usd(m.custo_total), `taxas ${usd(m.taxas)} · funding ${usd(m.funding)}${m.funding < 0 ? ' (recebeu)' : ''} · resultado médio ${num(m.expectativa_r, 2)}R`)}
        ${kpi('Stop e alvo no mesmo candle', num(emp.total), emp.total ? `${emp.refino} decididos por candles menores · ${emp.stop_assumido} contados como stop (sem candles menores daquela época)` : 'nenhum empate')}
        ${res.ignorados.filtro ? kpi('Sinais barrados pelos filtros', num(res.ignorados.filtro), 'horário, dia da semana ou tempo gráfico maior') : ''}
      </div></div>
    <div class="box"><div class="box-head"><h2>Patrimônio</h2><p class="small muted">Marcado a mercado no fechamento de cada candle, contra comprar e segurar ${F.ativo}${F.ativo !== 'BTC' ? ' e BTC' : ''} com o mesmo capital.</p></div>
      <div class="legend"><span><i style="background:var(--accent)"></i>estratégia</span><span><i style="background:var(--faint)"></i>comprar e segurar ${F.ativo}</span>${F.ativo !== 'BTC' ? '<span><i style="background:var(--btc)"></i>comprar e segurar BTC</span>' : ''}</div>
      <svg id="btCurva" viewBox="0 0 720 260" role="img" aria-label="Curva de patrimônio"></svg></div>
    <div class="box"><div class="box-head"><h2>Operações no gráfico</h2><p class="small muted">Arraste a barra ou clique numa operação da lista. ▲ entrada de compra, ▼ entrada de venda; a linha liga até a saída (verde = ganhou, vermelho = perdeu).</p></div>
      <canvas id="btVelas" height="340" style="width:100%;display:block"></canvas>
      <input type="range" id="btJanela" min="0" max="0" value="0" style="width:100%" aria-label="Posição no gráfico">
      <p class="small muted" id="btJanelaTxt"></p></div>
    <div class="box"><div class="box-head"><h2>Lista de operações</h2><span class="small muted">${T.length > 500 ? 'as 500 mais recentes' : `${T.length} operações`}</span></div>
      <div class="tbl-wrap" style="max-height:420px;overflow:auto"><table class="clicavel" id="btTabela"><thead><tr><th>#</th><th>Entrada (UTC)</th><th class="n">Preço</th><th>Saída</th><th class="n">Preço</th><th>Motivo</th><th class="n">Candles</th><th class="n">Resultado</th><th class="n">R</th><th class="n">Taxas</th><th class="n">Funding</th></tr></thead><tbody>
      ${T.slice(-500).reverse().map(t => `<tr data-n="${t.n}" style="cursor:pointer"><td class="muted" data-l="Operação">#${t.n}</td><td data-l="Entrada">${quando(t.t_entrada)}</td><td class="n" data-l="Preço ent.">${preco(t.entrada)}</td>
        <td data-l="Saída">${quando(t.t_saida)}</td><td class="n" data-l="Preço saída">${preco(t.saida)}</td><td data-l="Motivo"><span class="chip ${t.motivo.startsWith('alvo') ? 'up' : t.motivo === 'stop' || t.motivo === 'liquidação' ? 'down' : ''}">${t.motivo}</span>${t.parciais && !t.motivo.startsWith('alvo') ? ` <span class="small muted">${t.parciais} parcial(is)</span>` : ''}</td>
        <td class="n" data-l="Candles">${t.candles}</td><td class="n ${cls(t.pnl)}" data-l="Resultado"><b>${usd(t.pnl, true)}</b> <span class="small">${pct(t.ret)}</span></td>
        <td class="n" data-l="R">${num(t.r, 2)}</td><td class="n" data-l="Taxas">${usd(t.taxas)}</td><td class="n" data-l="Funding">${usd(t.funding)}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="box"><div class="box-head"><h2>Monte Carlo: e se a ordem das operações fosse outra?</h2></div>
      ${mc ? `<div class="kpis">
        ${kpi('Cair 20% ou mais', pct(mc.queda20, 0, false), 'nas próximas 100 operações', mc.queda20 > 0.25 ? 'neg' : '')}
        ${kpi('Cair 30% ou mais', pct(mc.queda30, 0, false), 'nas próximas 100 operações', mc.queda30 > 0.1 ? 'neg' : '')}
        ${kpi('Cair 50% ou mais', pct(mc.queda50, 0, false), 'nas próximas 100 operações', mc.queda50 > 0.02 ? 'neg' : '')}
        ${kpi('Resultado em 100 operações', pct(mc.final_p50), `5% piores: ${pct(mc.final_p5)} · 5% melhores: ${pct(mc.final_p95)}`, cls(mc.final_p50))}</div>
        <p class="small muted">${num(mc.rodadas)} sorteios de 100 operações tiradas das ${T.length} do teste${mc.com_repeticao ? ' (com menos de 100 operações, o sorteio repete operações)' : ', em ordem embaralhada'}, cada uma com o mesmo % do patrimônio que rendeu no teste. Mede o risco de sequência ruim; não corrige um teste que já está otimista.</p>`
        : '<p class="muted">Sem operações.</p>'}</div>
    <div class="box"><div class="box-head"><h2>Hora do dia e dia da semana: diferença real ou acaso?</h2></div>
      ${grade(ph, 'hora', Array.from({ length: 24 }, (_, h) => h), h => `${String(h).padStart(2, '0')}h`, 'Hora de entrada (UTC)')}
      ${grade(pd, 'dia', [1, 2, 3, 4, 5, 6, 0], d => DIAS[d], 'Dia da semana da entrada (UTC)')}
      <p class="small muted">Teste de permutação com ${num(2000)} rodadas: embaralha os horários entre as operações e vê quantas vezes o acaso produz diferença entre os grupos igual ou maior que a observada (p-valor).</p></div>`;
  desenharCurva(res.curva, bh, F.ativo !== 'BTC' ? bhBtc : null);
  montarVelas(D.V, T, F.intervalo);
}

function grade(P, chave, ordem, rot, titulo) {
  if (!P) return `<p class="muted small">${titulo}: poucas operações.</p>`;
  const maxAbs = Math.max(1e-9, ...Object.values(P.grupos).map(g => Math.abs(g.media)));
  return `<h3 style="margin:14px 0 6px;font-size:14px">${titulo} · <span class="${P.p < 0.05 && P.n >= 30 ? 'pos' : 'muted'}">p = ${num(P.p, 3)}</span></h3>
    <div class="bt-grade">${ordem.map(k => {
      const g = P.grupos[k];
      if (!g) return `<div class="bt-cel vazia"><b>${rot(k)}</b><span>—</span></div>`;
      const a = Math.min(1, Math.abs(g.media) / maxAbs) * 0.55 + 0.08;
      return `<div class="bt-cel" style="background:color-mix(in srgb, var(${g.media >= 0 ? '--up' : '--down'}) ${Math.round(a * 100)}%, transparent)" title="${rot(k)}: ${g.n} operações, média ${pct(g.media, 2)}, acerto ${pct(g.acerto, 0, false)}">
        <b>${rot(k)}</b><span>${pct(g.media, 1)}</span><span class="small">${g.n} op.</span></div>`;
    }).join('')}</div>
    <p class="small" style="margin:6px 0 0">${esc(P.frase)}</p>`;
}

function desenharCurva(curva, bh, bhBtc) {
  const svg = document.getElementById('btCurva');
  const W = 720, H = 260, x0 = 64, x1 = 712, y0 = 10, y1 = 232;
  const series = [curva, bh, bhBtc].filter(Boolean);
  const todos = series.flatMap(s => s.map(p => p.eq));
  const mn = Math.min(...todos), mx = Math.max(...todos);
  const t0 = curva[0].t, t1 = curva[curva.length - 1].t;
  const X = t => x0 + (t - t0) / Math.max(1, t1 - t0) * (x1 - x0), Y = v => y1 - (v - mn) / Math.max(1e-9, mx - mn) * (y1 - y0);
  let s = '';
  for (let k = 0; k <= 4; k++) {
    const v = mn + (mx - mn) * k / 4;
    s += `<line x1="${x0}" x2="${x1}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${x0 - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${usd(v)}</text>`;
  }
  const passo = Math.max(1, Math.floor(curva.length / 6));
  for (let k = 0; k < curva.length; k += passo) s += `<text x="${X(curva[k].t)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${quando(curva[k].t).slice(0, 8)}</text>`;
  const caminho = (serie, maxPts = 900) => { const pulo = Math.max(1, Math.floor(serie.length / maxPts)); let d = ''; serie.forEach((p, i) => { if (i % pulo && i !== serie.length - 1) return; d += (d ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.eq).toFixed(1); }); return d; };
  if (bhBtc) s += `<path d="${caminho(bhBtc)}" fill="none" stroke="var(--btc)" stroke-width="1.3" opacity=".8"/>`;
  s += `<path d="${caminho(bh)}" fill="none" stroke="var(--faint)" stroke-width="1.3"/>`;
  s += `<path d="${caminho(curva)}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  s += `<line x1="${x0}" x2="${x1}" y1="${Y(curva[0].eq)}" y2="${Y(curva[0].eq)}" stroke="var(--fg)" stroke-dasharray="3 4" opacity=".5"/>`;
  svg.innerHTML = s;
}

function montarVelas(V, T, iv) {
  const cv = document.getElementById('btVelas'), sl = document.getElementById('btJanela'), txt = document.getElementById('btJanelaTxt');
  const JAN = 180;
  sl.max = Math.max(0, V.length - JAN); sl.value = sl.max;
  const desenhar = () => {
    const ini = +sl.value, fim = Math.min(V.length, ini + JAN), parte = V.slice(ini, fim);
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 720, H = 340;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const em = T.filter(t => t.i_saida >= ini && t.i_entrada < fim);
    const precos = parte.flatMap(v => [v.h, v.l]).concat(em.flatMap(t => [t.entrada, t.saida]));
    const mn = Math.min(...precos), mx = Math.max(...precos), x0 = 8, x1 = W - 70, y0 = 10, y1 = H - 22;
    const bw = (x1 - x0) / JAN, X = i => x0 + (i - ini + 0.5) * bw, Y = p => y1 - (p - mn) / Math.max(1e-12, mx - mn) * (y1 - y0);
    const cUp = cor('--up'), cDn = cor('--down'), cLn = cor('--line'), cMu = cor('--muted'), cAc = cor('--accent');
    g.font = '11px system-ui'; g.fillStyle = cMu; g.strokeStyle = cLn; g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) { const p = mn + (mx - mn) * k / 4; g.beginPath(); g.moveTo(x0, Y(p)); g.lineTo(x1, Y(p)); g.stroke(); g.fillText(preco(p), x1 + 6, Y(p) + 4); }
    parte.forEach((v, k) => {
      const i = ini + k, sobe = v.c >= v.o, c = sobe ? cUp : cDn;
      g.strokeStyle = c; g.fillStyle = c;
      g.beginPath(); g.moveTo(X(i), Y(v.h)); g.lineTo(X(i), Y(v.l)); g.stroke();
      const top = Y(Math.max(v.o, v.c)), alt = Math.max(1, Math.abs(Y(v.o) - Y(v.c)));
      g.fillRect(X(i) - Math.max(1, bw * 0.35), top, Math.max(2, bw * 0.7), alt);
    });
    em.forEach(t => {
      const xa = X(Math.max(ini, t.i_entrada)), xb = X(Math.min(fim - 1, t.i_saida)), c = t.pnl > 0 ? cUp : cDn;
      g.setLineDash([4, 3]); g.strokeStyle = c; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(xa, Y(t.entrada)); g.lineTo(xb, Y(t.saida)); g.stroke(); g.setLineDash([]);
      if (t.i_entrada >= ini) {
        g.fillStyle = cAc; g.beginPath();
        const y = Y(t.entrada), compra = t.lado === 'compra';
        g.moveTo(xa, y + (compra ? -1 : 1) * 2); g.lineTo(xa - 6, y + (compra ? 10 : -10)); g.lineTo(xa + 6, y + (compra ? 10 : -10)); g.closePath(); g.fill();
      }
      if (t.i_saida < fim) { g.fillStyle = c; g.beginPath(); g.arc(xb, Y(t.saida), 4.5, 0, Math.PI * 2); g.fill(); }
    });
    g.fillStyle = cMu;
    [0, Math.floor(parte.length / 2), parte.length - 1].forEach(k => { if (parte[k]) g.fillText(quando(parte[k].t), Math.max(x0, Math.min(X(ini + k) - 30, x1 - 70)), H - 6); });
    txt.textContent = `${quando(V[ini].t)} a ${quando(V[fim - 1].t)} UTC · ${em.length} operação(ões) neste trecho`;
  };
  sl.oninput = desenhar;
  document.querySelectorAll('#btTabela tbody tr').forEach(tr => tr.addEventListener('click', () => {
    const t = T.find(x => x.n === +tr.dataset.n);
    sl.value = Math.max(0, Math.min(+sl.max, t.i_entrada - Math.floor(JAN / 3)));
    desenhar();
    cv.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  desenhar();
  window.addEventListener('resize', desenhar);
}

/* ---------------------------------------------------------------- montagem ---- */
function ajuda() {
  return `<details class="bt-ajuda"><summary>Como escrever a estratégia (JSON)</summary>
  <pre>{
  "nome": "texto livre",
  "lado": "compra" | "venda",
  "entrada": { "modo": "E" | "OU" | "SEQUENCIA", "janela": 10, "condicoes": [ condição, ... ] },
  "filtros": {
    "horas_utc": [12, 21],          entra só de 12h a 20h59 UTC (aceita virar a meia-noite: [22, 4])
    "dias": [1, 2, 3, 4, 5],        0 = domingo ... 6 = sábado (UTC)
    "maior": { "intervalo": "1d", "modo": "E", "condicoes": [ ... ] }   usa só o último candle JÁ FECHADO
  },
  "gatilho": { "tipo": "abertura" (padrão) | "fechamento" | "rompimento", "validade": 1 },
  "saida": {
    "sinal":  { "modo": "E", "condicoes": [ ... ] },                       sai no fechamento quando acontecer
    "stop":   { "tipo": "percentual", "valor": 2 }                         % da entrada
            | { "tipo": "atr", "valor": 2, "periodo": 14 }                 múltiplo do ATR do candle sinal
            | { "tipo": "trailing", "valor": 3 }                           % abaixo da melhor máxima (acima da melhor mínima)
            | { "tipo": "minima_sinal" },                                  mínima (compra) ou máxima (venda) do candle sinal
    "alvos": [ { "fracao": 50, "tipo": "risco" | "percentual", "valor": 1, "depois": "break_even" | "alvo_anterior" | "nenhuma" }, ... ]
                                    até 5; "fracao" = % da posição; o que sobrar segue para stop, sinal ou tempo
    "break_even": { "gatilho_r": 1 } ou { "gatilho_pct": 2 },
    "tempo_max": 20,                candles
    "primeiro_lucro": true          primeiro fechamento no lucro, já descontados os custos
  },
  "posicao": { "alavancagem": 3, "tamanho": { "tipo": ..., "valor": ... } }
      "risco"       % da caixa perdido se bater o stop
      "risco_valor" US$ perdidos se bater o stop
      "caixa"       % da caixa usado como margem (a alavancagem multiplica)
      "valor"       US$ de posição (nocional)
}

condição  = { "ind": INDICADOR, "atras": 0, "op": ">" | "<" | ">=" | "<=" | "cruza_acima" | "cruza_abaixo",
              "valor": 30  ou  { "ind": INDICADOR, "atras": 0 } }
INDICADOR = { "nome": "MME", "periodo": 9 }      "atras" = quantos candles atrás olhar</pre>
  <p class="small"><b>Indicadores</b> (fórmulas padrão de mercado; IFR, ATR e ADX pela suavização de Wilder): ${Object.entries(INDICADORES).map(([k, v]) => `<code>${k}</code> (${esc(v)})`).join(' · ')}.
  Estrutura de mercado (BOS, ChoCH e divergências) chega na Fase 2.</p>
  <p class="small"><b>Execução:</b> o sinal é lido no fechamento do candle; por padrão a entrada é na abertura do candle seguinte. "fechamento" entra no próprio fechamento do sinal; "rompimento" deixa uma ordem na máxima (compra) ou mínima (venda) do candle sinal, válida por "validade" candles. Quantidade arredondada para baixo em frações de 0,0001.
  <b>Regras conservadoras:</b> stop e alvo no mesmo candle → candles de 5 ou 15 min decidem quem veio primeiro; sem eles (a Hyperliquid só guarda os mais recentes), vale o stop. No candle em que o rompimento executa, só o stop vale. Break-even e trailing mudam o stop a partir do candle seguinte. Abertura além do stop sai na abertura. Liquidação perde a margem inteira (alavancagem máxima: ${Object.entries(ALAV_MAX).map(([a, x]) => `${a} ${x}x`).join(', ')}).
  O mesmo JSON vai servir depois para os robôs.</p></details>`;
}

export function iniciar() {
  const raiz = document.getElementById('btApp');
  if (!raiz || raiz.dataset.pronto) return;
  raiz.dataset.pronto = '1';
  const f = guardar.ler('form', {});
  const C = { ...CUSTOS_PADRAO, ...(f.custos || {}) };
  raiz.innerHTML = `
    <div class="box">
      <div class="box-head"><h2>Estratégia</h2><span class="chip warn">Fase 1 · teste no passado, não promessa</span></div>
      <div class="bt-form">
        <label>Ativo <select id="btAtivo">${ATIVOS.map(a => `<option ${a === (f.ativo || 'BTC') ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
        <label>Intervalo <select id="btIntervalo">${['1h', '4h', '1d'].map(i => `<option ${i === (f.intervalo || '4h') ? 'selected' : ''}>${i}</option>`).join('')}</select></label>
        <label>Capital (US$) <input id="btCapital" type="number" min="100" step="100" value="${f.capital || 10000}"></label>
        <label>Taxa taker % <input id="btTaker" type="number" step="0.005" min="0" value="${C.taker}"></label>
        <label>Taxa maker % <input id="btMaker" type="number" step="0.005" min="0" value="${C.maker}"></label>
        <label>Derrapagem % <input id="btSlip" type="number" step="0.01" min="0" value="${C.derrapagem}"></label>
        <label class="bt-check"><input id="btFunding" type="checkbox" ${C.funding ? 'checked' : ''}> cobrar funding</label>
      </div>
      <div class="bt-form" style="margin-top:10px">
        <label style="flex:1 1 320px">Modelo <select id="btModelo"><option value="">— escolher um exemplo —</option>${Object.keys(MODELOS).map(k => `<option>${esc(k)}</option>`).join('')}</select></label>
      </div>
      <textarea id="btJson" spellcheck="false" rows="20" aria-label="Estratégia em JSON"></textarea>
      <div class="bt-botoes"><button class="bt-primario" id="btRodar">Rodar backtest</button><button id="btTodos">Rodar em todos os ativos</button><span id="btStatus" class="small"></span></div>
      ${ajuda()}
    </div>
    <div class="box" id="btTodosRes" hidden></div>
    <div id="btRes" class="pilha" hidden></div>`;
  const ta = document.getElementById('btJson');
  ta.value = guardar.ler('json', null) || JSON.stringify(MODELOS[Object.keys(MODELOS)[0]], null, 2);
  document.getElementById('btModelo').addEventListener('change', e => { if (MODELOS[e.target.value]) ta.value = JSON.stringify(MODELOS[e.target.value], null, 2); });
  document.getElementById('btRodar').addEventListener('click', rodar);
  document.getElementById('btTodos').addEventListener('click', rodarTodos);
}

// a aba existe no HTML; monta quando ela é aberta pela primeira vez (ou já, se a página abriu nela)
const painel = document.getElementById('p-backtest');
if (painel) {
  if (!painel.hidden) iniciar();
  new MutationObserver(() => { if (!painel.hidden) iniciar(); }).observe(painel, { attributes: true, attributeFilter: ['hidden'] });
}
