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

let S = { pos: null, conta: null, erro: '', t: 0 };

async function estado(user, dex) {
  const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user }) });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
async function buscar() {
  const user = lerEnd();
  if (!user) return;
  try {
    const [a, b] = await Promise.all([estado(user), estado(user, 'xyz').catch(() => null)]);   // cripto e ações (grupo xyz)
    const pos = [];
    for (const st of [a, b]) if (st) for (const x of st.assetPositions || []) {
      const p = x.position, szi = +p.szi;
      if (!szi) continue;
      const mark = Math.abs(+p.positionValue / szi), liq = p.liquidationPx ? +p.liquidationPx : null;
      pos.push({ coin: p.coin, lado: szi > 0 ? 'compra' : 'venda', valor: +p.positionValue, pnl: +p.unrealizedPnl, roe: +p.returnOnEquity,
        entrada: +p.entryPx, mark, liq, dist: liq ? Math.abs(mark - liq) / mark : null });
    }
    const conta = (+a.marginSummary.accountValue) + (b ? +b.marginSummary.accountValue : 0);
    const margem = (+a.marginSummary.totalMarginUsed) + (b ? +b.marginSummary.totalMarginUsed : 0);
    S = { pos: pos.sort((x, y) => y.valor - x.valor), conta: { valor: conta, margem }, erro: '', t: Date.now() };
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
    const linhas = P.map(p => {
      const perigo = p.dist != null && p.dist < 0.08, atencao = p.dist != null && p.dist < 0.15;
      return `<tr><td><b>${esc(p.coin.replace('xyz:', ''))}</b> <span class="${p.lado === 'compra' ? 'pos' : 'neg'}">${p.lado}</span></td>
        <td>US$ ${num(p.valor)}</td><td class="${p.pnl >= 0 ? 'pos' : 'neg'}">${sinal(p.pnl)} <span class="muted small">(${sinal(p.roe * 100, 1)}%)</span></td>
        <td>${p.liq ? `<span ${perigo ? 'class="neg"' : atencao ? 'style="color:var(--warn)"' : ''}>${p.dist > 1 ? 'longe' : num(p.dist * 100, 1) + '%'}</span> <span class="muted small">${px(p.liq)}</span>` : '<span class="muted small">sem risco de liquidação</span>'}</td></tr>`;
    }).join('');
    el.innerHTML = `<div class="box"><div class="box-head"><h2>Minhas posições</h2>
      <span class="small muted">conta US$ ${num(S.conta.valor)} · margem em uso ${num(uso * 100, 0)}% · PnL aberto <b class="${tot >= 0 ? 'pos' : 'neg'}">${sinal(tot)}</b> · <button class="hj-link" data-act="pos-trocar">trocar carteira</button></span></div>
      ${P.length ? `<div class="tbl-wrap"><table><thead><tr><th>Posição</th><th>Tamanho</th><th>PnL (US$)</th><th>Liquidação a</th></tr></thead><tbody>${linhas}</tbody></table></div>` : '<p class="muted small">Nenhuma posição aberta agora.</p>'}</div>`;
  }
}

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-act^="pos-"]');
  if (!el) return;
  if (el.dataset.act === 'pos-trocar') { gravarEnd(''); S = { pos: null, conta: null, erro: '', t: 0 }; if (senha()) fetch('api/minha', { method: 'POST', headers: { 'x-senha': senha(), 'Content-Type': 'application/json' }, body: JSON.stringify({ carteira: '' }) }).catch(() => {}); return desenhar(); }
  if (el.dataset.act === 'pos-salvar') {
    const box = el.closest('.box'), v = box.querySelector('[data-end]').value.trim().toLowerCase(), msg = box.querySelector('[data-msg]');
    if (!/^0x[0-9a-f]{40}$/.test(v)) { msg.textContent = 'Endereço inválido (0x e 40 caracteres).'; return; }
    gravarEnd(v); msg.textContent = 'Conectando…';
    if (senha()) fetch('api/minha', { method: 'POST', headers: { 'x-senha': senha(), 'Content-Type': 'application/json' }, body: JSON.stringify({ carteira: v }) }).catch(() => {});   // para os alertas
    S = { pos: null, conta: null, erro: '', t: 0 }; desenhar(); buscar();
  }
});

desenhar();
if (lerEnd()) buscar();
else if (senha()) fetch('api/minha', { headers: { 'x-senha': senha() } }).then(r => r.ok ? r.json() : null).then(j => { if (j && j.carteira) { gravarEnd(j.carteira); buscar(); } }).catch(() => {});
setInterval(() => { if (lerEnd() && !document.hidden && document.querySelector('#p-hoje:not([hidden]), #p-a-hoje:not([hidden])')) buscar(); }, 20000);
