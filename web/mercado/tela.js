/* "Mercado agora" na tela Hoje: para UM ativo por vez, só o que ajuda a decidir se vale entrar agora.
 *   Execução: spread, profundidade até 1% e quanto custa entrar com o tamanho da sua calculadora (derrapagem).
 *   Fluxo: quem está agredindo o book nos últimos 5 min (compradores ou vendedores). Conta desde que a página abriu.
 *   Funding e OI: quem paga para segurar posição, se o funding está caro frente aos últimos 20 dias, e o OI.
 * Tudo direto da Hyperliquid, no navegador (sem banco). */
const HL = 'https://api.hyperliquid.xyz/info', WS = 'wss://api.hyperliquid.xyz/ws';
const ALVOS = { cripto: 'mercCripto', acoes: 'mercAcoes' };
const num = (v, d = 0) => (+v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = v => v >= 1e9 ? 'US$ ' + num(v / 1e9, 2) + ' bi' : v >= 1e6 ? 'US$ ' + num(v / 1e6, 1) + ' mi' : 'US$ ' + num(v / 1e3, 0) + ' mil';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lerPref = (k, d) => { try { return localStorage.getItem('radar-merc-' + k) || d; } catch (e) { return d; } };
const gravarPref = (k, v) => { try { localStorage.setItem('radar-merc-' + k, v); } catch (e) {} };
const hl = async corpo => { const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }); if (!r.ok) throw new Error(r.status); return r.json(); };

const E = { cripto: { coin: null, book: null, ctx: null, fund: null, erro: '' }, acoes: { coin: null, book: null, ctx: null, fund: null, erro: '' } };
const ativos = modo => (typeof DADOS_HOJE !== 'undefined' && DADOS_HOJE && typeof hojeLinhas === 'function' ? hojeLinhas(DADOS_HOJE) : [])
  .filter(r => (modo === 'acoes') === (r.mercado === 'acoes')).map(r => modo === 'acoes' ? r.id : r.t);

/* ---------------------------------------------------------------- cálculos (puros) ---- */
export function derrapagem(niveis, mid, notional, lado) {
  // anda no book até completar o valor; devolve o preço médio contra o meio e se o book acabou antes
  let resta = notional, custo = 0, qtd = 0;
  for (const n of niveis) {
    const px = +n.px, sz = +n.sz, cabe = px * sz;
    const pega = Math.min(resta, cabe);
    custo += pega; qtd += pega / px; resta -= pega;
    if (resta <= 1e-9) break;
  }
  if (!qtd) return null;
  const medio = custo / qtd;
  return { bps: (lado === 'compra' ? medio - mid : mid - medio) / mid * 1e4, completo: resta <= 1e-9, medio };
}
export function profundidade(bids, asks, mid, frac = 0.01) {
  const soma = (L, ok) => L.filter(n => ok(+n.px)).reduce((s, n) => s + n.px * n.sz, 0);
  const b = soma(bids, p => p >= mid * (1 - frac)), a = soma(asks, p => p <= mid * (1 + frac));
  return { bid: b, ask: a, cobreBid: bids.length && +bids[bids.length - 1].px <= mid * (1 - frac), cobreAsk: asks.length && +asks[asks.length - 1].px >= mid * (1 + frac) };
}
export function fluxo(buffer, agora, janelaMs = 300000) {
  let c = 0, v = 0, p0 = null, p1 = null;
  for (const t of buffer) if (agora - t.t <= janelaMs) { if (t.lado === 'B') c += t.usd; else v += t.usd; if (t.px > 0) { if (p0 == null) p0 = t.px; p1 = t.px; } }
  return { compra: c, venda: v, total: c + v, pctCompra: c + v > 0 ? c / (c + v) : null, dPx: p0 && p1 ? (p1 / p0 - 1) * 100 : null };
}
export function percentil(serie, x) { return serie.length ? serie.filter(v => v <= x).length / serie.length : null; }

/* OI: a Hyperliquid só informa o valor de agora. O cartão guarda uma leitura a cada 10 min neste navegador (3 dias) e compara. */
export function variacaoOI(hist, agora, oiAgora, minMs = 30 * 60000, maxMs = 3 * 864e5, pxAgora = null) {
  const ref = hist.find(h => agora - h.t >= minMs && agora - h.t <= maxMs);   // a leitura mais antiga ainda dentro da janela
  return ref && ref.oi > 0 ? { pct: (oiAgora / ref.oi - 1) * 100, horas: (agora - ref.t) / 36e5, dPx: pxAgora > 0 && ref.px > 0 ? (pxAgora / ref.px - 1) * 100 : null } : null;
}
function guardarOI(coin, oi, px) {
  const k = 'radar-merc-oi-' + coin, agora = Date.now();
  let h = [];
  try { h = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) {}
  h = h.filter(x => agora - x.t <= 3 * 864e5);
  const v = variacaoOI(h, agora, oi, 30 * 60000, 4 * 36e5, px);   // compara com 30 min a 4 h atrás: leitura de agora, não de dias
  if (!h.length || agora - h[h.length - 1].t >= 10 * 60000) h.push({ t: agora, oi, px });
  try { localStorage.setItem(k, JSON.stringify(h)); } catch (e) {}
  return v;
}

/* ---------------------------------------------------------------- dados ---- */
const buffers = {};   // coin -> trades agressivos recentes (WebSocket)
let ws = null, wsCoins = new Set(), wsTimer = null;
function wsAbrir() {
  if (ws && ws.readyState <= 1) return;
  try { ws = new WebSocket(WS); } catch (e) { return; }
  ws.onopen = () => { wsCoins.forEach(c => ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: c } }))); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.channel !== 'trades' || !Array.isArray(m.data)) return;
    const agora = Date.now();
    for (const x of m.data) {
      const b = buffers[x.coin] || (buffers[x.coin] = { desde: agora, itens: [] });
      b.itens.push({ t: x.time, usd: +x.px * +x.sz, lado: x.side, px: +x.px });
    }
    for (const b of Object.values(buffers)) { const lim = agora - 15 * 60000; while (b.itens.length && b.itens[0].t < lim) b.itens.shift(); }
  };
  ws.onclose = () => { clearTimeout(wsTimer); wsTimer = setTimeout(() => { if (wsCoins.size) wsAbrir(); }, 3000); };
}
function assinar(coin) {
  if (wsCoins.has(coin)) return;
  wsCoins.add(coin);
  if (!buffers[coin]) buffers[coin] = { desde: Date.now(), itens: [] };
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
  else wsAbrir();
}
setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ method: 'ping' })); }, 50000);

const ctxCache = {};   // dex -> { t, meta }
async function ctxDe(coin) {
  const dex = coin.startsWith('xyz:') ? 'xyz' : '';
  const c = ctxCache[dex];
  let dados = c && Date.now() - c.t < 45000 ? c.dados : null;
  if (!dados) { dados = await hl(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }); ctxCache[dex] = { t: Date.now(), dados }; }
  const i = dados[0].universe.findIndex(u => u.name === coin);
  return i >= 0 ? dados[1][i] : null;
}
const fundCache = {};
async function fundDe(coin) {
  const c = fundCache[coin];
  if (c && Date.now() - c.t < 10 * 60000) return c.serie;
  const h = await hl({ type: 'fundingHistory', coin, startTime: Date.now() - 20 * 864e5 });
  const serie = h.map(x => +x.fundingRate);
  fundCache[coin] = { t: Date.now(), serie };
  return serie;
}
async function atualizar(modo) {
  const e = E[modo];
  if (!e.coin) return;
  try {
    const [b, fino, ctx, fund] = await Promise.all([hl({ type: 'l2Book', coin: e.coin }), hl({ type: 'l2Book', coin: e.coin, nSigFigs: 3 }), ctxDe(e.coin), fundDe(e.coin)]);
    e.book = { bids: b.levels[0], asks: b.levels[1], largoBids: fino.levels[0], largoAsks: fino.levels[1] };
    e.ctx = ctx; e.fund = fund; e.erro = '';
  } catch (x) { e.erro = 'Não consegui ler o mercado agora.'; }
  desenhar(modo);
}

/* ---------------------------------------------------------------- desenho ---- */
/* ---------------------------------------------------------------- leituras (puras) ---- */
/** execução: só chama a atenção quando o custo de entrar a mercado importa */
export function leituraExecucao(bpsPior, completo) {
  if (!completo || bpsPior > 15) return ['ruim', 'liquidez fraca para este tamanho: use ordem limitada ou reduza'];
  if (bpsPior > 5) return ['aviso', 'entrar a mercado custa caro: prefira ordem limitada'];
  return ['ok', 'ok'];
}
/** fluxo agressivo junto com o que o preço fez na mesma janela (dPx em %) */
export function leituraFluxo(pctCompra, dPx) {
  if (pctCompra == null) return ['neutro', 'sem negociações suficientes'];
  const parado = dPx == null || Math.abs(dPx) < 0.1;
  if (pctCompra <= 0.35) return dPx != null && dPx >= -0.1 ? ['alerta', 'venda forte sem derrubar o preço: possível absorção (alguém grande comprando)'] : ['venda', 'vendedores no controle'];
  if (pctCompra >= 0.65) return dPx != null && dPx <= 0.1 ? ['alerta', 'compra forte sem subir o preço: possível exaustão (alguém grande vendendo)'] : ['compra', 'compradores no controle'];
  return ['neutro', parado ? 'equilibrado' : 'equilibrado, preço andando sem agressão forte'];
}
/** posicionamento: funding (percentil nos últimos 20 dias) e OI contra o preço no mesmo período */
export function leituraPosicao({ fundPerc, fundAno, dOI, dPx }) {
  const partes = [];
  if (fundPerc != null && fundPerc <= 0.1 && fundAno < 0) partes.push(['alerta', 'vendidos lotados (funding no ponto mais baixo em 20 dias): risco de alta forçada']);
  else if (fundPerc != null && fundPerc >= 0.9 && fundAno > 20) partes.push(['alerta', 'comprados lotados e pagando caro: risco de queda forçada']);
  if (dOI != null && dPx != null && Math.abs(dOI) >= 0.5) {
    const sobeOI = dOI > 0;
    if (Math.abs(dPx) < 0.2) partes.push(['neutro', sobeOI ? 'posições sendo abertas com o preço parado: energia acumulando' : 'posições sendo fechadas com o preço parado']);
    else if (dPx < 0) partes.push(sobeOI ? ['venda', 'queda com vendidos novos entrando: queda com convicção'] : ['neutro', 'queda com comprados saindo: a queda perde força']);
    else partes.push(sobeOI ? ['compra', 'alta com compra nova entrando'] : ['neutro', 'alta feita de vendidos fechando: costuma ser frágil']);
  }
  return partes.length ? partes : [['neutro', 'sem desequilíbrio']];
}

/* ---------------------------------------------------------------- desenho ---- */
const COR = { ok: 'var(--up)', compra: 'var(--up)', venda: 'var(--down)', ruim: 'var(--down)', aviso: 'var(--warn)', alerta: 'var(--warn)', neutro: 'var(--muted)' };
function tamanhoCalc() {
  try { if (typeof hojeCalcular === 'function') { const r = hojeCalcular(); if (r && !r.erro && r.notional > 0) return { v: r.notional, calc: true }; } } catch (e) {}
  return { v: 1000, calc: false };   // sem calculadora preenchida: exemplo de US$ 1.000, o tamanho típico da sua conta
}
const linha = (rotulo, itens, dica) => `<div style="display:grid;grid-template-columns:130px minmax(0,1fr);gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line)">
  <span class="hj-sub" style="margin:0">${rotulo}</span><span class="small"${dica ? ` title="${esc(dica)}" style="cursor:help"` : ''}>${itens.map(([n, t]) => `<span style="color:${COR[n]};${n !== 'neutro' && n !== 'ok' ? 'font-weight:600' : ''}">${t}</span>`).join(' · ')}</span></div>`;
function blocos(modo) {
  const e = E[modo];
  if (!e.book) return `<p class="muted small">${esc(e.erro || 'Lendo o livro de ordens…')}</p>`;
  const { bids, asks, largoBids, largoAsks } = e.book;
  const mid = (+bids[0].px + +asks[0].px) / 2, spread = (+asks[0].px - +bids[0].px) / mid * 1e4;
  const dp = profundidade(largoBids, largoAsks, mid), tam = tamanhoCalc();
  const sc = derrapagem(asks, mid, tam.v, 'compra'), sv = derrapagem(bids, mid, tam.v, 'venda');
  const pior = Math.max(sc ? sc.bps : 99, sv ? sv.bps : 99), completo = !!(sc && sc.completo && sv && sv.completo);
  const [ne, te] = leituraExecucao(pior, completo);
  const exec = linha('Execução', [[ne, ne === 'ok' ? `ok para US$ ${num(tam.v)}${tam.calc ? '' : ' (exemplo)'}` : te]],
    `Spread ${num(spread, 1)} pontos-base · custo de entrar a mercado: comprando ${sc && sc.completo ? num(Math.max(sc.bps, 0), 1) : '—'}, vendendo ${sv && sv.completo ? num(Math.max(sv.bps, 0), 1) : '—'} pontos-base · profundidade a 1%: ${usd(dp.bid)} compra / ${usd(dp.ask)} venda`);
  const buf = buffers[e.coin], agora = Date.now(), min = buf ? (agora - buf.desde) / 60000 : 0;
  let flx;
  if (!buf || min < 3) flx = linha('Fluxo (5 min)', [['neutro', `coletando as negociações ao vivo… (${num(Math.max(0, min), 0)} de 3 min)`]]);   // com menos de 3 min a leitura engana
  else {
    const fl = fluxo(buf.itens, agora);
    const [nf, tf] = leituraFluxo(fl.total > 0 ? fl.pctCompra : null, fl.dPx);
    flx = linha('Fluxo (5 min)', [[nf, tf]], fl.total > 0 ? `Compra agressiva ${num(fl.pctCompra * 100, 0)}% · venda ${num((1 - fl.pctCompra) * 100, 0)}% · ${usd(fl.total)} em ${num(Math.min(5, min), 0)} min · preço ${fl.dPx != null ? (fl.dPx > 0 ? '+' : '') + num(fl.dPx, 2) + '%' : '—'}` : '');
  }
  let pos = linha('Posicionamento', [['neutro', 'sem dados de funding']]);
  const c = e.ctx, f = e.fund || [];
  if (c) {
    const fr = +c.funding, ano = fr * 24 * 365 * 100, perc = percentil(f, fr), oi = +c.openInterest * +c.markPx;
    const v = guardarOI(e.coin, oi, +c.markPx);
    const L = leituraPosicao({ fundPerc: perc, fundAno: ano, dOI: v ? v.pct : null, dPx: v ? v.dPx : null });
    const var24 = +c.prevDayPx > 0 ? (+c.markPx / +c.prevDayPx - 1) * 100 : null;
    pos = linha('Posicionamento', L, `Funding ${ano > 0 ? '+' : ''}${num(ano, 0)}% ao ano (${fr > 0 ? 'comprados pagam' : 'vendidos pagam'}), percentil ${perc != null ? num(perc * 100, 0) : '—'} dos últimos 20 dias · OI ${usd(oi)}${v ? ` (${v.pct > 0 ? '+' : ''}${num(v.pct, 1)}% em ${num(v.horas, 1)} h, preço ${v.dPx != null ? (v.dPx > 0 ? '+' : '') + num(v.dPx, 1) + '%' : '—'})` : ' (guardando histórico)'} · volume 24h ${usd(+c.dayNtlVlm)}${var24 != null ? ` · preço 24h ${var24 > 0 ? '+' : ''}${num(var24, 1)}%` : ''}`);
  }
  return exec + flx + pos + '<p class="small muted" style="margin:6px 0 0;font-size:11.5px">Passe o mouse sobre cada leitura para ver os números.</p>';
}
function desenhar(modo) {
  const root = document.getElementById(ALVOS[modo]);
  if (!root) return;
  const lista = ativos(modo);
  if (!root.dataset.pronto) {
    if (!lista.length) return;
    root.dataset.pronto = '1';
    root.innerHTML = `<div class="box"><div class="box-head"><h2>Mercado agora</h2>
      <label class="small muted">Ativo <select data-merc style="font:inherit;color:var(--fg);background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:4px 6px"></select></label></div>
      <div data-dyn></div></div>`;
    root.querySelector('[data-merc]').addEventListener('change', ev => { gravarPref('ativo-' + modo, ev.target.value); escolher(modo, ev.target.value); });
  }
  const sel = root.querySelector('[data-merc]');
  if (lista.length && sel.options.length !== lista.length) {
    const salvo = lerPref('ativo-' + modo, '');
    sel.innerHTML = lista.map(c => `<option value="${esc(c)}">${esc(c.replace('xyz:', ''))}</option>`).join('');
    const ini = lista.includes(salvo) ? salvo : lista[0];
    sel.value = ini;
    if (E[modo].coin !== ini) escolher(modo, ini);
  }
  root.querySelector('[data-dyn]').innerHTML = blocos(modo);
}
function escolher(modo, coin) {
  Object.assign(E[modo], { coin, book: null, ctx: null, fund: null, erro: '' });
  assinar(coin);
  desenhar(modo);
  atualizar(modo);
}

/* ---------------------------------------------------------------- ciclo ---- */
function visivel(modo) { return !document.hidden && !!document.querySelector(modo === 'acoes' ? '#p-a-hoje:not([hidden])' : '#p-hoje:not([hidden])'); }
setInterval(() => { for (const m of Object.keys(ALVOS)) { if (!document.getElementById(ALVOS[m]).dataset.pronto) desenhar(m); else if (visivel(m)) atualizar(m); } }, 8000);
setTimeout(() => { for (const m of Object.keys(ALVOS)) desenhar(m); }, 1500);
