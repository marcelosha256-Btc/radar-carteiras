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
  let c = 0, v = 0;
  for (const t of buffer) if (agora - t.t <= janelaMs) { if (t.lado === 'B') c += t.usd; else v += t.usd; }
  return { compra: c, venda: v, total: c + v, pctCompra: c + v > 0 ? c / (c + v) : null };
}
export function percentil(serie, x) { return serie.length ? serie.filter(v => v <= x).length / serie.length : null; }

/* OI: a Hyperliquid só informa o valor de agora. O cartão guarda uma leitura a cada 10 min neste navegador (3 dias) e compara. */
export function variacaoOI(hist, agora, oiAgora, minMs = 30 * 60000) {
  const ref = hist.find(h => agora - h.t >= minMs && agora - h.t <= 3 * 864e5);   // a leitura mais antiga ainda dentro da janela
  return ref && ref.oi > 0 ? { pct: (oiAgora / ref.oi - 1) * 100, horas: (agora - ref.t) / 36e5 } : null;
}
function guardarOI(coin, oi) {
  const k = 'radar-merc-oi-' + coin, agora = Date.now();
  let h = [];
  try { h = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) {}
  h = h.filter(x => agora - x.t <= 3 * 864e5);
  const v = variacaoOI(h, agora, oi);
  if (!h.length || agora - h[h.length - 1].t >= 10 * 60000) h.push({ t: agora, oi });
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
      b.itens.push({ t: x.time, usd: +x.px * +x.sz, lado: x.side });
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
function spark(serie) {
  if (serie.length < 3) return '';
  const W = 120, H = 28, mn = Math.min(...serie, 0), mx = Math.max(...serie, 0), amp = (mx - mn) || 1;
  const pts = serie.map((v, i) => `${(i * W / (serie.length - 1)).toFixed(1)},${(H - (v - mn) / amp * H).toFixed(1)}`).join(' ');
  const z = (H - (0 - mn) / amp * H).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" width="120" height="28" aria-label="Funding dos últimos 20 dias"><line x1="0" x2="${W}" y1="${z}" y2="${z}" stroke="var(--line)" stroke-dasharray="3 3"/><polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="${pts}"/></svg>`;
}
function tamanhoCalc() {
  try { if (typeof hojeCalcular === 'function') { const r = hojeCalcular(); if (r && !r.erro && r.notional > 0) return { v: r.notional, calc: true }; } } catch (e) {}
  return { v: 10000, calc: false };
}
function blocos(modo) {
  const e = E[modo];
  if (!e.book) return `<p class="muted small">${esc(e.erro || 'Lendo o livro de ordens…')}</p>`;
  const { bids, asks, largoBids, largoAsks } = e.book;
  const mid = (+bids[0].px + +asks[0].px) / 2, spread = (+asks[0].px - +bids[0].px) / mid * 1e4;
  const dp = profundidade(largoBids, largoAsks, mid), tam = tamanhoCalc();
  const sc = derrapagem(asks, mid, tam.v, 'compra'), sv = derrapagem(bids, mid, tam.v, 'venda');
  const pior = Math.max(sc ? sc.bps : 99, sv ? sv.bps : 99), incompleto = (sc && !sc.completo) || (sv && !sv.completo);
  const veredito = incompleto || pior > 15 ? ['down', 'liquidez fraca para este tamanho'] : pior > 5 ? ['warn', 'dá para entrar, com algum custo'] : ['up', 'liquidez boa para este tamanho'];
  const buf = buffers[e.coin], agora = Date.now(), fl = buf ? fluxo(buf.itens, agora) : null, min = buf ? (agora - buf.desde) / 60000 : 0;
  const fluxoTxt = !fl || min < 1 ? '<span class="muted small">coletando as negociações ao vivo…</span>'
    : fl.total === 0 ? '<span class="muted small">sem negociações nos últimos minutos</span>'
    : `<div style="height:8px;border-radius:4px;background:var(--down);overflow:hidden"><div style="height:100%;width:${(fl.pctCompra * 100).toFixed(0)}%;background:var(--up)"></div></div>
       <div class="small" style="display:flex;justify-content:space-between"><span class="pos">compra ${num(fl.pctCompra * 100, 0)}%</span><span class="neg">venda ${num((1 - fl.pctCompra) * 100, 0)}%</span></div>
       <div class="small muted">${usd(fl.total)} em ${num(Math.min(5, min), 0)} min · ${fl.pctCompra > 0.6 ? 'compradores agredindo' : fl.pctCompra < 0.4 ? 'vendedores agredindo' : 'equilibrado'}</div>`;
  const c = e.ctx, f = e.fund || [];
  let fundoTxt = '<span class="muted small">sem dados de funding</span>';
  if (c) {
    const fr = +c.funding, ano = fr * 24 * 365 * 100, perc = percentil(f, fr), oi = +c.openInterest * +c.markPx;
    const dOI = guardarOI(e.coin, oi);
    const caro = perc != null && perc > 0.9 && Math.abs(ano) > 20, quem = fr > 0 ? 'quem está comprado paga' : fr < 0 ? 'quem está vendido paga' : 'neutro';
    const var24 = +c.prevDayPx > 0 ? (+c.markPx / +c.prevDayPx - 1) * 100 : null;
    fundoTxt = `<div><b class="${caro ? 'neg' : ''}">${ano > 0 ? '+' : ''}${num(ano, 0)}% ao ano</b> <span class="muted small">(${(fr * 100).toFixed(4).replace('.', ',')}% por hora)</span></div>
      <div class="small muted">${quem}${perc != null ? ` · mais alto que ${num(perc * 100, 0)}% dos últimos 20 dias` : ''}${caro ? ' · <b style="color:var(--warn)">caro para segurar</b>' : ''}</div>
      <div>${spark(f)}</div>
      <div class="small muted">Posições abertas (OI): ${usd(oi)}${dOI ? ` (${dOI.pct > 0 ? '+' : ''}${num(dOI.pct, 1)}% em ${dOI.horas < 48 ? num(dOI.horas, 0) + ' h' : num(dOI.horas / 24, 0) + ' dias'})` : ' <span title="o histórico começa a ser guardado agora neste navegador">(guardando histórico…)</span>'} · volume 24h ${usd(+c.dayNtlVlm)}${var24 != null ? ` · preço 24h ${var24 > 0 ? '+' : ''}${num(var24, 1)}%` : ''}</div>`;
  }
  const lado = (x, nome) => x ? `<div>${nome}: <b class="${x.bps > 15 ? 'neg' : ''}">${x.completo ? num(Math.max(x.bps, 0), 1) + ' pontos-base' : 'o livro não comporta'}</b></div>` : '';
  return `<div class="grid-3" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px">
    <div><h3 class="hj-sub">Execução</h3>
      <div class="small">spread <b>${num(spread, 1)}</b> pontos-base · profundidade a 1%: <b>${usd(dp.bid)}</b> compra / <b>${usd(dp.ask)}</b> venda${dp.cobreBid && dp.cobreAsk ? '' : ' <span class="muted">(mínimo)</span>'}</div>
      <div class="small muted" style="margin-top:6px">Custo de entrar a mercado com US$ ${num(tam.v)}${tam.calc ? ' (tamanho da calculadora)' : ' (exemplo; use a calculadora para o seu)'}:</div>
      <div class="small">${lado(sc, 'comprando')}${lado(sv, 'vendendo')}</div>
      <span class="chip ${veredito[0]}" style="margin-top:6px">${veredito[1]}</span></div>
    <div><h3 class="hj-sub">Quem está agredindo (5 min)</h3>${fluxoTxt}</div>
    <div><h3 class="hj-sub">Funding e alavancagem</h3>${fundoTxt}</div></div>`;
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
