/* Aba "RSI Mestre" (Pesquisa): RSI 14 em 15 min, 1H, 4H, Dia e Semana para a cripto e as ações mais negociadas.
 * Velas direto da Hyperliquid no navegador: 3 pedidos por ativo (15m, 1h → 4H agrupado, 1d → Semana agrupada),
 * em lotes pequenos para não levar 429. Guarda 10 min no navegador. */
import { rsiWilder, agrupar, faixa, resumo, mediaSimples, regime } from './calc.js';
import { medo, frase, medidorMedo } from '../contexto/medo.js';
import { medidor } from '../contexto/medidor.js';
import { vix, fraseVix, medidorVix } from '../contexto/vix.js';

const HL = 'https://api.hyperliquid.xyz/info';
const CRIPTO = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'NEAR'];
const TFS = [['15m', '15 min'], ['1h', '1H'], ['4h', '4H'], ['1d', 'Dia'], ['1w', 'Semana']];
const H = 36e5, D = 864e5, CACHE = 'radar-rsi-cache', VALIDADE = 10 * 60e3;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = v => v == null ? '—' : v.toFixed(1).replace('.', ',');
const ler = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const pausa = ms => new Promise(r => setTimeout(r, ms));

async function velas(coin, intervalo, desde) {
  for (let t = 0; t < 4; t++) {
    const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: intervalo, startTime: desde, endTime: Date.now() } }) });
    if (r.status === 429) { await pausa(1500 * (t + 1)); continue; }
    if (!r.ok) throw new Error('erro ' + r.status);
    return (await r.json()).map(v => ({ t: v.t, c: +v.c }));
  }
  throw new Error('limite da Hyperliquid');
}
async function medir(coin) {
  const agora = Date.now();
  const v15 = await velas(coin, '15m', agora - 300 * 9e5);
  const v1h = await velas(coin, '1h', agora - 700 * H);
  const v1d = await velas(coin, '1d', agora - 1500 * D);
  const c = arr => arr.map(v => v.c);
  return {
    coin, px: v15.length ? v15[v15.length - 1].c : null,
    ch24: v1h.length > 24 ? (v1h[v1h.length - 1].c / v1h[v1h.length - 25].c - 1) * 100 : null,
    m200: { d: mediaSimples(c(v1d), 200), w: mediaSimples(c(agrupar(v1d, 7 * D)), 200) },
    r: { '15m': rsiWilder(c(v15)), '1h': rsiWilder(c(v1h)), '4h': rsiWilder(c(agrupar(v1h, 4 * H))), '1d': rsiWilder(c(v1d)), '1w': rsiWilder(c(agrupar(v1d, 7 * D))) },
  };
}

function ativosAcoes() {
  try {
    if (typeof DADOS_HOJE === 'undefined' || !DADOS_HOJE || typeof hojeLinhas !== 'function') return [];
    return hojeLinhas(DADOS_HOJE).filter(r => r.mercado === 'acoes' && r.vol > 0).sort((a, b) => b.vol - a.vol).slice(0, 10).map(r => r.id);
  } catch (e) { return []; }
}

const S = { medo: null, vix: null, linhas: ler(CACHE, { t: 0, d: {} }), carregando: false, erro: '', filtro: ler('radar-rsi-filtro', 'tudo') };

const reg = l => { const g = regime(l.r['1d']), cor = g.lado < 0 ? 'var(--warn)' : g.lado > 0 ? 'var(--down)' : 'var(--muted)';
  return `<span class="chip" style="color:${cor};border-color:${cor};font-weight:${g.nivel === 3 ? 800 : 600}">${g.t}</span>`; };
// distância do preço até a média de 200 dias / 200 semanas (referência de suporte de prazo maior)
const medias = l => { if (!l.m200 || l.px == null) return '';
  const p = [['200 d', l.m200.d], ['200 sem', l.m200.w]].filter(x => x[1]).map(([n, m]) => `${n} ${(l.px / m - 1) * 100 >= 0 ? '+' : ''}${f1((l.px / m - 1) * 100)}%`);
  return p.length ? `<br><span class="muted">média ${p.join(' · ')}</span>` : ''; };

function desenhar() {
  const root = document.getElementById('rsiMestre'); if (!root) return;
  const lista = Object.values(S.linhas.d).filter(l => S.filtro === 'tudo' || (S.filtro === 'acoes') === l.coin.startsWith('xyz:'));
  const comRes = lista.map(l => ({ ...l, res: resumo(TFS.map(([k]) => l.r[k])) }))
    .sort((a, b) => b.res.n - a.res.n || (b.res.ext || 0) - (a.res.ext || 0) || a.coin.localeCompare(b.coin));
  const cel = v => { const f = faixa(v);
    const bg = f.lado < 0 ? 'var(--warn-soft)' : f.lado > 0 ? 'var(--down-soft)' : 'transparent', cor = f.lado < 0 ? 'var(--warn)' : f.lado > 0 ? 'var(--down)' : 'var(--fg)';
    return `<td class="num" title="${f.txt}" style="text-align:center;background:${bg};color:${cor};${f.nivel === 2 ? 'font-weight:800' : ''}">${f1(v)}</td>`; };
  const filtro = [['tudo', 'Tudo'], ['acoes', 'Ações'], ['cripto', 'Cripto']].map(([v, n]) =>
    `<button class="hj-link" data-f="${v}" style="${S.filtro === v ? 'font-weight:700;text-decoration:none' : ''}">${n}</button>`).join(' · ');
  const quando = S.linhas.t ? new Date(S.linhas.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
  root.innerHTML = `<div class="box-head"><h2>RSI Mestre</h2><p>RSI 14 (Wilder) em cinco tempos gráficos, das velas da Hyperliquid. Laranja = sobrevenda (≤30), vermelho = sobrecompra (≥70), negrito = extremo (≤20 ou ≥80). Regime pelo RSI do dia (≤30 capitulação, ≤35 queda forte, ≤45 queda; espelho em cima). Clique numa linha para abrir o ativo na Liquidez ao vivo.</p></div>
    <p class="small" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center"><span class="facts">${filtro}</span><span style="flex:1"></span>
      <span class="muted">${S.carregando ? 'atualizando…' : 'atualizado às ' + quando}</span> <button class="hj-link" data-act="rsi-atualizar">atualizar</button></p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:10px;margin:8px 0">
      ${S.vix && S.filtro !== 'cripto' ? medidor(medidorVix(S.vix)) : ''}${S.medo && S.filtro !== 'acoes' ? medidor(medidorMedo(S.medo)) : ''}</div>
    ${S.erro ? `<p class="small" style="color:var(--warn)">${esc(S.erro)}</p>` : ''}
    <div class="tbl-wrap"><table><thead><tr><th>Ativo</th><th>Preço · 24 h</th><th>Regime</th>${TFS.map(([, n]) => `<th style="text-align:center">${n}</th>`).join('')}<th>Leitura</th></tr></thead><tbody>
    ${comRes.length ? comRes.map(l => `<tr class="rsi-lin" data-coin="${esc(l.coin)}" title="Abrir na Liquidez ao vivo" style="cursor:pointer"><td><b>${esc(l.coin.replace('xyz:', ''))}</b>${l.coin.startsWith('xyz:') ? ' <span class="small muted">ação</span>' : ''}</td>
      <td class="num">${l.px != null ? l.px.toLocaleString('pt-BR', { maximumFractionDigits: l.px < 10 ? 4 : 2 }) : '—'}${l.ch24 != null ? ` <span class="small ${l.ch24 >= 0 ? 'pos' : 'neg'}">${l.ch24 >= 0 ? '+' : ''}${f1(l.ch24)}%</span>` : ''}</td>
      <td>${reg(l)}</td>
      ${TFS.map(([k]) => cel(l.r[k])).join('')}<td class="small ${l.res.n ? '' : 'muted'}">${l.res.txt}${medias(l)}</td></tr>`).join('')
      : `<tr><td colspan="9" class="muted">${S.carregando ? 'Buscando as velas…' : 'Sem dados ainda.'}</td></tr>`}
    </tbody></table></div>
    <p class="small muted" style="margin-top:8px">4H vem do agrupamento das velas de 1H e Semana do agrupamento das diárias, em blocos de tempo UTC: pode diferir alguns décimos do gráfico. Fora do pregão de NY, as velas das ações são só negócios da Hyperliquid (finos). RSI esticado sozinho não prevê direção: no estudo do Connors RSI (11/2026), comprar sobrevenda não teve vantagem clara sobre entrar em qualquer dia do mesmo regime. Use como contexto e para o "RSI se chegar lá" da Liquidez ao vivo.</p>`;
}

async function carregar(forcar) {
  if (S.carregando) return;
  medo().then(m => { if (m) { S.medo = m; desenhar(); } });
  vix().then(m => { if (m) { S.vix = m; desenhar(); } });
  if (!forcar && Date.now() - S.linhas.t < VALIDADE && Object.keys(S.linhas.d).length) return desenhar();
  const lista = [...CRIPTO, ...ativosAcoes()];
  S.carregando = true; S.erro = ''; desenhar();
  const novo = { t: Date.now(), d: {} }, falhas = [];
  for (let i = 0; i < lista.length; i += 2) {   // 2 ativos (6 pedidos) por vez
    const lote = lista.slice(i, i + 2);
    const res = await Promise.allSettled(lote.map(medir));
    res.forEach((r, j) => { if (r.status === 'fulfilled') novo.d[lote[j]] = r.value; else falhas.push(lote[j].replace('xyz:', '')); });
    S.linhas = { t: novo.t, d: { ...S.linhas.d, ...novo.d } }; desenhar();
    await pausa(600);
  }
  if (!lista.some(c => c.startsWith('xyz:'))) novo.t = Date.now() - VALIDADE + 60e3;   // painel do Hoje ainda não chegou: tenta as ações de novo em 1 min
  S.linhas = novo; gravar(CACHE, novo);
  S.carregando = false; S.erro = falhas.length ? `Sem dados agora para: ${falhas.join(', ')}.` : ''; desenhar();
}

const painel = document.getElementById('p-rsi');
if (painel) {
  document.getElementById('rsiMestre').addEventListener('click', ev => {
    const lin = ev.target.closest('.rsi-lin'); if (lin && !ev.target.closest('button')) {
      const coin = lin.dataset.coin, acao = coin.startsWith('xyz:');
      try { localStorage.setItem('lv-' + (acao ? 'acoes' : 'cripto') + '-sel', coin); } catch (e) {}   // se a Liquidez ainda não abriu, ela já nasce neste ativo
      window.dispatchEvent(new CustomEvent('radar-abrir-ativo', { detail: { coin, mercado: acao ? 'acoes' : 'cripto' } }));
      if (typeof window.show === 'function') window.show(acao ? 'a-aovivo' : 'aovivo');
      return;
    }
    const f = ev.target.closest('[data-f]'); if (f) { S.filtro = f.dataset.f; gravar('radar-rsi-filtro', S.filtro); return desenhar(); }
    if (ev.target.closest('[data-act="rsi-atualizar"]')) carregar(true);
  });
  const abrir = () => { if (!painel.hidden) carregar(false); };
  new MutationObserver(abrir).observe(painel, { attributes: true, attributeFilter: ['hidden'] });
  // as ações dependem do painel do Hoje (DADOS_HOJE): se a aba abriu antes dele chegar, tenta de novo
  window.addEventListener('load', () => setTimeout(abrir, 1500));
  setInterval(() => { if (!painel.hidden && !document.hidden) carregar(false); }, 60e3);
  abrir();
}
