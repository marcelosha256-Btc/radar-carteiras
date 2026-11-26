/* "Minhas posições" na tela Hoje: só o essencial de cada posição aberta na Hyperliquid (leitura pelo endereço público).
 * Uma linha por posição: lado, PnL e a que distância do preço está a liquidação. Sem endereço, só um convite discreto. */
const HL = 'https://api.hyperliquid.xyz/info';
const ALVOS = ['posCripto', 'posAcoes'];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => (+v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const sinal = (v, d = 0) => (v > 0 ? '+' : '') + num(v, d);
const senha = () => { try { return localStorage.getItem('radar-senha') || ''; } catch (e) { return ''; } };
const lerEnd = () => { try { return localStorage.getItem('radar-carteira') || ''; } catch (e) { return ''; } };
const gravarEnd = v => { try { localStorage.setItem('radar-carteira', v); } catch (e) {} };
const px = v => typeof fmtPx === 'function' ? fmtPx(v) : num(v, 2);

const ESTAVEIS = new Set(['USDC', 'USDT0', 'USDH', 'USDE']);
const hl2 = async corpo => { const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }); if (!r.ok) throw new Error(r.status); return r.json(); };
let S = { pos: null, conta: null, erro: '', t: 0, fills: null, fillsT: 0 };

/* "25/11 14:32 (há 2 h)": data e hora locais + relativo, para "quando foi a entrada". */
function quando(t) {
  const d = new Date(t), dt = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const s = (Date.now() - t) / 1000, rel = s < 3600 ? Math.max(1, Math.round(s / 60)) + ' min' : s < 86400 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' dias';
  return `${dt} (há ${rel})`;
}

async function estado(user, dex) {
  const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user }) });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
/* Ordens abertas (para achar o stop/alvo de cada posição): uma chamada por dex, a cada atualização (peso leve na API pública da Hyperliquid). */
const ordens = (user, dex) => hl2(dex ? { type: 'frontendOpenOrders', user, dex } : { type: 'frontendOpenOrders', user }).catch(() => []);
/* Execuções recentes (para achar quando foi a última entrada): só a cada 2 min, é a chamada mais pesada da Hyperliquid. */
async function fillsCache(user) {
  if (S.fills && Date.now() - S.fillsT < 120000) return S.fills;
  try { S.fills = await hl2({ type: 'userFills', user }); S.fillsT = Date.now(); } catch (e) { /* mantém o que já tinha */ }
  return S.fills || [];
}
async function buscar() {
  const user = lerEnd();
  if (!user) return;
  try {
    const [a, b, sp, ordA, ordB, fills] = await Promise.all([estado(user), estado(user, 'xyz').catch(() => null),
      hl2({ type: 'spotClearinghouseState', user }).catch(() => null),   // cripto, ações (grupo xyz) e saldo spot
      ordens(user), ordens(user, 'xyz'), fillsCache(user)]);
    const ord = [...ordA, ...ordB].filter(o => o.reduceOnly && o.isTrigger);   // só o que fecha a posição: stop ou alvo
    const pos = [];
    for (const st of [a, b]) if (st) for (const x of st.assetPositions || []) {
      const p = x.position, szi = +p.szi;
      if (!szi) continue;
      const mark = Math.abs(+p.positionValue / szi), liq = p.liquidationPx ? +p.liquidationPx : null, compra = szi > 0;
      const meus = ord.filter(o => o.coin === p.coin).map(o => +o.triggerPx);
      const stops = meus.filter(v => compra ? v < mark : v > mark).sort((x, y) => compra ? y - x : x - y);   // mais perto do preço primeiro
      const alvos = meus.filter(v => compra ? v > mark : v < mark).sort((x, y) => compra ? x - y : y - x);
      // última execução que abriu/aumentou esta posição (não uma redução): "quando foi a entrada"
      const entEm = fills.find(f => f.coin === p.coin && f.dir === (compra ? 'Open Long' : 'Open Short'));
      pos.push({ coin: p.coin, lado: compra ? 'compra' : 'venda', valor: +p.positionValue, pnl: +p.unrealizedPnl, roe: +p.returnOnEquity,
        entrada: +p.entryPx, entradaEm: entEm ? entEm.time : null, stops, alvos, mark, liq, dist: liq ? Math.abs(mark - liq) / mark : null });
    }
    const perp = (+a.marginSummary.accountValue) + (b ? +b.marginSummary.accountValue : 0);
    const margem = (+a.marginSummary.totalMarginUsed) + (b ? +b.marginSummary.totalMarginUsed : 0);
    const bal = sp && sp.balances ? sp.balances.filter(x => +x.total > 0) : [];
    const spot = bal.filter(x => ESTAVEIS.has(x.coin)).reduce((t, x) => t + +x.total, 0);   // stablecoins valem 1; outros tokens não entram na soma
    const outros = bal.filter(x => !ESTAVEIS.has(x.coin)).map(x => x.coin);
    const valor = perp + spot;
    S = { ...S, pos: pos.sort((x, y) => y.valor - x.valor), conta: { valor, perp, spot, outros, livre: Math.max(0, valor - margem), margem }, erro: '', t: Date.now() };
  } catch (e) { S.erro = 'Não consegui ler a carteira agora.'; }
  desenhar();
}

function desenhar() {
  const user = lerEnd();
  for (const id of ALVOS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (!user) {
      el.innerHTML = `<div class="box"><div class="box-head"><h2>Minhas posições</h2></div>
        <p class="small muted">Cole o endereço público da sua carteira da Hyperliquid para ver aqui, ao vivo, o que está aberto e a que distância está a liquidação. É só leitura: o endereço não dá acesso aos seus fundos.</p>
        <div class="hj-acoes"><input data-end placeholder="0x…" size="44" style="font:inherit;padding:6px 8px;border-radius:6px;border:1px solid var(--line);background:var(--surface-2);color:var(--fg)">
        <button class="hj-btn" data-act="pos-salvar">Conectar</button><span class="small muted" data-msg></span></div></div>`;
      continue;
    }
    if (!S.pos) { el.innerHTML = `<div class="box"><div class="box-head"><h2>Minhas posições</h2></div><p class="muted small">${esc(S.erro || 'Lendo a carteira…')}</p></div>`; continue; }
    const P = S.pos, tot = P.reduce((s, p) => s + p.pnl, 0), uso = S.conta.valor > 0 ? S.conta.margem / S.conta.valor : 0;
    const fecha = (arr, cor) => !arr.length ? '<span class="muted small">—</span>'
      : arr.map(v => `<span style="color:var(--${cor})">${px(v)}</span>`).join(' · ') + (arr.length > 1 ? ' <span class="muted small">(escalonado)</span>' : '');
    const linhas = P.map(p => {
      const perigo = p.dist != null && p.dist < 0.08, atencao = p.dist != null && p.dist < 0.15;
      return `<tr><td><b>${esc(p.coin.replace('xyz:', ''))}</b> <span class="${p.lado === 'compra' ? 'pos' : 'neg'}">${p.lado}</span></td>
        <td>${px(p.entrada)}${p.entradaEm ? `<br><span class="muted small">${quando(p.entradaEm)}</span>` : '<br><span class="muted small" title="Fora das execuções recentes lidas, ou a posição foi aberta aos poucos">sem data recente</span>'}</td>
        <td>stop ${fecha(p.stops, p.lado === 'compra' ? 'down' : 'up')}${p.alvos.length ? `<br><span class="small">alvo ${fecha(p.alvos, p.lado === 'compra' ? 'up' : 'down')}</span>` : ''}</td>
        <td>US$ ${num(p.valor)}</td><td class="${p.pnl >= 0 ? 'pos' : 'neg'}">${sinal(p.pnl)} <span class="muted small">(${sinal(p.roe * 100, 1)}%)</span></td>
        <td>${p.liq ? `<span ${perigo ? 'class="neg"' : atencao ? 'style="color:var(--warn)"' : ''}>${p.dist > 1 ? 'longe' : num(p.dist * 100, 1) + '%'}</span> <span class="muted small">${px(p.liq)}</span>` : '<span class="muted small">sem risco de liquidação</span>'}</td></tr>`;
    }).join('');
    el.innerHTML = `<div class="box"><div class="box-head"><h2>Minhas posições</h2>
      <span class="small muted"><b style="color:var(--fg);font-size:15px" title="Conta de trading US$ ${num(S.conta.perp, 2)} + spot US$ ${num(S.conta.spot, 2)}${S.conta.outros.length ? ' (fora da soma: ' + esc(S.conta.outros.join(', ')) + ')' : ''}">Saldo US$ ${num(S.conta.valor, 2)}</b> · livre US$ ${num(S.conta.livre, 2)} · margem em uso ${num(S.conta.valor > 0 ? S.conta.margem / S.conta.valor * 100 : 0, 0)}% · PnL aberto <b class="${tot >= 0 ? 'pos' : 'neg'}">${sinal(tot)}</b> · <button class="hj-link" data-act="pos-trocar">trocar carteira</button></span></div>
      ${P.length ? `<div class="tbl-wrap"><table><thead><tr><th>Posição</th><th>Entrada</th><th>Stop / alvo</th><th>Tamanho</th><th>PnL (US$)</th><th>Liquidação a</th></tr></thead><tbody>${linhas}</tbody></table></div>
        <p class="small muted" style="margin-top:6px">Stop/alvo: ordens de redução com gatilho já colocadas na Hyperliquid (lidas, não criadas por aqui). Sem nenhuma: a posição está sem stop na corretora. Entrada: preço médio (exato) e data da última execução que abriu ou aumentou a posição (só nas execuções recentes; se não achar, mostra "sem data recente").</p>` : '<p class="muted small">Nenhuma posição aberta agora.</p>'}</div>`;
  }
}

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-act^="pos-"]');
  if (!el) return;
  if (el.dataset.act === 'pos-trocar') { gravarEnd(''); S = { pos: null, conta: null, erro: '', t: 0, fills: null, fillsT: 0 }; if (senha()) fetch('api/minha', { method: 'POST', headers: { 'x-senha': senha(), 'Content-Type': 'application/json' }, body: JSON.stringify({ carteira: '' }) }).catch(() => {}); return desenhar(); }
  if (el.dataset.act === 'pos-salvar') {
    const box = el.closest('.box'), v = box.querySelector('[data-end]').value.trim().toLowerCase(), msg = box.querySelector('[data-msg]');
    if (!/^0x[0-9a-f]{40}$/.test(v)) { msg.textContent = 'Endereço inválido (0x e 40 caracteres).'; return; }
    gravarEnd(v); msg.textContent = 'Conectando…';
    if (senha()) fetch('api/minha', { method: 'POST', headers: { 'x-senha': senha(), 'Content-Type': 'application/json' }, body: JSON.stringify({ carteira: v }) }).catch(() => {});   // para os alertas
    S = { pos: null, conta: null, erro: '', t: 0, fills: null, fillsT: 0 }; desenhar(); buscar();
  }
});

desenhar();
if (lerEnd()) buscar();
else if (senha()) fetch('api/minha', { headers: { 'x-senha': senha() } }).then(r => r.ok ? r.json() : null).then(j => { if (j && j.carteira) { gravarEnd(j.carteira); buscar(); } }).catch(() => {});
setInterval(() => { if (lerEnd() && !document.hidden && document.querySelector('#p-hoje:not([hidden])')) buscar(); }, 20000);
