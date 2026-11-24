/* Telas "Meu diário" (Cripto e Ações): registro das operações do próprio trader, medidas em R.
 * Dados: /api/trades (banco, com a senha). Operações em "papel" (simuladas) e "reais" ficam separadas nas estatísticas. */
import { metricas, porGrupo, rAberto, confianca, ordemFechamento } from './metricas.js';

const MODOS = { cripto: 'diarioCripto', acoes: 'diarioAcoes' };
const TFS = [['1h', '1H'], ['4h', '4H'], ['1d', 'Diário'], ['1w', 'Semanal']];
const MOTIVOS = [['alvo', 'Alvo'], ['stop', 'Stop'], ['manual', 'Saída manual'], ['tempo', 'Tempo'], ['invalidou', 'Setup invalidou']];
const EMOCOES = [['', '—'], ['calmo', 'Calmo'], ['ansioso', 'Ansioso'], ['fomo', 'FOMO'], ['revenge', 'Revanche'], ['entediado', 'Entediado'], ['confiante', 'Confiante demais']];

const S = { lista: null, erro: '', carregando: false };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 2) => v == null || !Number.isFinite(+v) ? '—' : (+v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const sinal = (v, d = 2) => v == null || !Number.isFinite(+v) ? '—' : (v > 0 ? '+' : '') + num(v, d);
const cls = v => v == null ? 'muted' : v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted';
const dh = ms => ms ? new Date(+ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + new Date(+ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
const senha = () => { try { return localStorage.getItem('radar-senha') || ''; } catch (e) { return ''; } };
const lerPref = (k, d) => { try { return localStorage.getItem('radar-diario-' + k) || d; } catch (e) { return d; } };
const gravarPref = (k, v) => { try { localStorage.setItem('radar-diario-' + k, v); } catch (e) {} };
const px = v => typeof fmtPx === 'function' ? fmtPx(v) : num(v, 4);
const preco = (ativo) => { try { return typeof ultimosMids !== 'undefined' && ultimosMids ? +(ultimosMids[ativo] || ultimosMids['xyz:' + ativo]) || null : null; } catch (e) { return null; } };

async function api(corpo) {
  if (!senha()) throw new Error('senha');
  const r = await fetch('api/trades', corpo
    ? { method: 'POST', headers: { 'x-senha': senha(), 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }
    : { headers: { 'x-senha': senha() } });
  if (!r.ok) { const e = new Error(String(r.status)); e.status = r.status; try { e.detalhe = (await r.json()).erro; } catch (x) {} throw e; }
  return r.json();
}
function msgErro(e) {
  if (e.message === 'senha' || e.status === 401) return 'Digite a senha do radar no topo da página para abrir o diário.';
  if (e.status === 503) return 'Banco em pausa (cota do plano gratuito). Tente de novo mais tarde.';
  if (e.detalhe === 'stop_lado') return 'Na compra o stop fica abaixo da entrada; na venda, acima.';
  if (e.detalhe === 'campos') return 'Preencha ativo, lado, entrada e stop.';
  return 'Não consegui falar com o banco agora (erro ' + (e.status || 'rede') + ').';
}
async function carregar() {
  S.carregando = true; S.erro = '';
  try { S.lista = (await api()).trades; } catch (e) { S.erro = msgErro(e); }
  S.carregando = false; desenhar();
}

/* ---------------------------------------------------------------- desenho ---- */
function curvaSVG(c) {
  if (!c || c.length < 2) return '<p class="muted small">A curva aparece a partir da 2ª operação fechada.</p>';
  const W = 640, H = 170, p = 14, pts = [0, ...c], mn = Math.min(0, ...pts), mx = Math.max(0, ...pts), amp = (mx - mn) || 1;
  const x = i => p + i * (W - 2 * p) / (pts.length - 1), y = v => H - p - (v - mn) * (H - 2 * p) / amp;
  const linha = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const fim = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:220px" role="img" aria-label="Curva de capital em R">
    <line x1="${p}" x2="${W - p}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)" stroke-dasharray="4 4"/>
    <polyline fill="none" stroke="${fim >= 0 ? 'var(--up, #3fb68b)' : 'var(--down, #e5625e)'}" stroke-width="2" points="${linha}"/>
    <text x="${W - p}" y="${Math.max(12, y(fim) - 6)}" text-anchor="end" font-size="12" fill="var(--fg)">${sinal(fim)} R</text>
    <text x="${p}" y="12" font-size="11" fill="var(--muted)">máx ${sinal(mx)} R</text><text x="${p}" y="${H - 2}" font-size="11" fill="var(--muted)">mín ${sinal(mn)} R</text></svg>`;
}
function kpis(m) {
  if (!m.n) return '<p class="muted">Nenhuma operação fechada ainda. Registre a primeira abaixo: o diário só ganha valor com o hábito de anotar tudo.</p>';
  const k = (t, v, c = '') => `<div class="kpi"><span class="lab">${t}</span><span class="val ${c}">${v}</span></div>`;
  return `<div class="kpis">${k('Operações fechadas', m.n)}${k('Expectância', sinal(m.expectancia) + ' R', cls(m.expectancia))}${k('Acerto', num(m.acerto * 100, 0) + '%')}
    ${k('Payoff (ganho médio ÷ perda média)', m.payoff == null ? '—' : num(m.payoff))}${k('Fator de lucro', m.fatorLucro === Infinity ? '∞' : m.fatorLucro == null ? '—' : num(m.fatorLucro))}${k('Total', sinal(m.totalR) + ' R', cls(m.totalR))}
    ${k('Maior queda da curva', '−' + num(m.drawdownR) + ' R', 'neg')}${k('Maior sequência de perdas', m.maiorSequenciaPerdas)}</div>
    <p class="small muted" ${confianca(m).nivel === 'baixa' ? 'style="color:var(--warn)"' : ''}>${esc(confianca(m).texto)}</p>`;
}
function tabelaGrupo(titulo, G) {
  if (!G.length) return '';
  return `<div><h3 class="hj-sub">${titulo}</h3><div class="tbl-wrap"><table><thead><tr><th>Grupo</th><th>Op.</th><th>Acerto</th><th>Expectância</th><th>Total</th></tr></thead><tbody>${
    G.map(g => `<tr><td>${esc(g.chave)}</td><td>${g.n}</td><td>${num(g.acerto * 100, 0)}%</td><td class="${cls(g.expectancia)}">${sinal(g.expectancia)} R</td><td class="${cls(g.totalR)}">${sinal(g.totalR)} R</td></tr>`).join('')}</tbody></table></div></div>`;
}
function linhaAberta(t) {
  const p = preco(t.ativo), r = rAberto(t, p);
  return `<tr><td><b>${esc(t.ativo)}</b> <span class="${t.lado === 'compra' ? 'pos' : 'neg'}">${esc(t.lado)}</span> <span class="muted small">${esc((TFS.find(x => x[0] === t.tf) || [0, t.tf || ''])[1])} · ${t.tipo === 'real' ? 'real' : 'papel'}${t.setup ? ' · ' + esc(t.setup) : ''}</span></td>
    <td>${px(t.entrada)}</td><td>${px(t.stop)}</td><td>${t.alvo1 ? px(t.alvo1) : '—'}</td>
    <td>${p ? px(p) : '—'}</td><td class="${cls(r)}">${r == null ? '—' : sinal(r) + ' R'}</td>
    <td><div class="facts"><input data-sai="${t.id}" inputmode="decimal" placeholder="saída" size="8" ${p ? `value="${px(p).replace(/\./g, '').replace(',', '.')}"` : ''} style="width:90px">
      <input data-tax="${t.id}" inputmode="decimal" placeholder="taxas US$" size="7" style="width:80px">
      <select data-mot="${t.id}">${MOTIVOS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select>
      <button class="hj-btn" data-act="tr-fechar" data-id="${t.id}">Fechar</button>
      <button class="hj-link" data-act="tr-apagar" data-id="${t.id}">excluir</button></div></td></tr>`;
}
function linhaFechada(t) {
  return `<tr><td>${dh(t.fechamento || t.abertura)}</td><td><b>${esc(t.ativo)}</b> <span class="${t.lado === 'compra' ? 'pos' : 'neg'}">${esc(t.lado)}</span> <span class="muted small">${esc((TFS.find(x => x[0] === t.tf) || [0, t.tf || ''])[1])} · ${t.tipo === 'real' ? 'real' : 'papel'}</span></td>
    <td>${esc(t.setup || '—')}</td><td>${px(t.entrada)} → ${px(t.saida)}</td><td class="${cls(t.r)}"><b>${sinal(t.r)} R</b></td>
    <td class="${cls(t.resultado_usd)}">${t.resultado_usd == null ? '—' : 'US$ ' + sinal(t.resultado_usd)}</td><td class="muted small">${esc(t.motivo || '')}${t.emocao ? ' · ' + esc(t.emocao) : ''}${t.nota ? ' · ' + esc(t.nota) : ''}</td>
    <td><button class="hj-link" data-act="tr-apagar" data-id="${t.id}">excluir</button></td></tr>`;
}
function formulario(modo) {
  const opt = ['<option value="">—</option>'].concat((typeof DADOS_HOJE !== 'undefined' && DADOS_HOJE && typeof hojeLinhas === 'function' ? hojeLinhas(DADOS_HOJE) : [])
    .filter(r => modo === 'acoes' ? r.mercado === 'acoes' : r.mercado !== 'acoes').map(r => `<option value="${esc(r.t)}">${esc(r.t)}</option>`));
  return `<div class="box"><div class="box-head"><h2>Nova operação</h2><button class="hj-link" data-act="tr-calc">preencher com a calculadora de risco</button></div>
    <div class="hj-form" data-form>
      <label>Ativo<select data-k="ativo">${opt.join('')}</select></label>
      <label>Lado<select data-k="lado"><option value="compra">compra</option><option value="venda">venda</option></select></label>
      <label>Tempo gráfico<select data-k="tf">${TFS.map(([v, n]) => `<option value="${v}" ${v === '4h' ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Tipo<select data-k="tipo"><option value="papel">papel (simulada)</option><option value="real">real</option></select></label>
      <label>Setup<input data-k="setup" list="trSetups" placeholder="ex.: pullback semanal 4H" maxlength="80"></label>
      <label>Entrada<input data-k="entrada" inputmode="decimal"></label>
      <label>Stop<input data-k="stop" inputmode="decimal"></label>
      <label>Alvo 1<input data-k="alvo1" inputmode="decimal"></label>
      <label>Risco em US$<input data-k="risco_usd" inputmode="decimal" placeholder="valor em risco"></label>
      <label>Quantidade<input data-k="qtd" inputmode="decimal"></label>
      <label>Como eu estava<select data-k="emocao">${EMOCOES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
      <label style="grid-column:1/-1">Por que entrei (a tese, em uma frase)<input data-k="nota" maxlength="300"></label>
    </div>
    <div class="hj-acoes"><button class="hj-btn" data-act="tr-add">Registrar operação</button><span class="small muted" data-msg></span></div></div>`;
}
function desenhar() {
  for (const modo of Object.keys(MODOS)) {
    const root = document.getElementById(MODOS[modo]);
    if (!root) continue;
    if (!root.dataset.pronto) {
      root.dataset.pronto = '1';
      root.innerHTML = `<datalist id="trSetups${modo}"></datalist><div data-slot="topo"></div>${formulario(modo)}<div data-slot="dyn"></div>`;
      root.querySelector('[list="trSetups"]').setAttribute('list', 'trSetups' + modo);
      ligar(root, modo);
    }
    const dyn = root.querySelector('[data-slot="dyn"]'), topo = root.querySelector('[data-slot="topo"]');
    if (S.erro) { topo.innerHTML = ''; dyn.innerHTML = `<div class="box"><p class="chip down" style="white-space:normal">${esc(S.erro)}</p></div>`; continue; }
    if (!S.lista) { dyn.innerHTML = '<p class="muted">Carregando o diário…</p>'; continue; }
    const filtro = lerPref('tipo-' + modo, 'todos');
    const mine = S.lista.filter(t => (t.mercado || 'cripto') === modo);
    const L = mine.filter(t => filtro === 'todos' || t.tipo === filtro);
    const m = metricas(L), abertas = L.filter(t => t.status !== 'fechado'), fechadas = ordemFechamento(L).reverse();
    root.querySelector('datalist').innerHTML = [...new Set(mine.map(t => t.setup).filter(Boolean))].map(s => `<option value="${esc(s)}">`).join('');
    topo.innerHTML = `<div class="box"><div class="box-head"><h2>Meu diário em R</h2>
      <span class="facts">${[['todos', 'Todas'], ['papel', 'Papel'], ['real', 'Reais']].map(([v, n]) => `<button class="hj-link" data-act="tr-filtro" data-f="${v}" style="${filtro === v ? 'font-weight:700;text-decoration:none' : ''}">${n}</button>`).join(' · ')}
      <button class="hj-link" data-act="tr-recarregar">atualizar</button></span></div>
      <p class="small muted">R é o lucro medido em múltiplos do risco da operação: +2 R é ganhar o dobro do que arriscou. O que importa é a expectância (média em R) depois de dezenas de operações, não o resultado de uma.</p>
      ${kpis(m)}${m.n >= 2 ? `<div>${curvaSVG(m.curva)}</div>` : ''}</div>`;
    dyn.innerHTML = `
      <div class="box"><div class="box-head"><h2>Em aberto (${abertas.length})</h2><p>O R atual usa o preço ao vivo da Hyperliquid.</p></div>
        ${abertas.length ? `<div class="tbl-wrap"><table><thead><tr><th>Operação</th><th>Entrada</th><th>Stop</th><th>Alvo 1</th><th>Preço</th><th>R agora</th><th>Fechar</th></tr></thead><tbody>${abertas.map(linhaAberta).join('')}</tbody></table></div>` : '<p class="muted small">Nenhuma operação aberta.</p>'}</div>
      <div class="box"><div class="box-head"><h2>Fechadas (${fechadas.length})</h2></div>
        ${fechadas.length ? `<div class="tbl-wrap"><table><thead><tr><th>Quando</th><th>Operação</th><th>Setup</th><th>Preço</th><th>R</th><th>US$</th><th>Notas</th><th></th></tr></thead><tbody>${fechadas.slice(0, 60).map(linhaFechada).join('')}</tbody></table></div>` : '<p class="muted small">Nada fechado ainda.</p>'}</div>
      ${m.n >= 5 ? `<div class="box"><div class="box-head"><h2>Onde estou ganhando e perdendo</h2><p>Só vale olhar depois de uma amostra decente: grupos com poucas operações enganam.</p></div>
        <div class="grid-2">${tabelaGrupo('Por setup', porGrupo(L, 'setup'))}${tabelaGrupo('Por ativo', porGrupo(L, 'ativo'))}${tabelaGrupo('Por tempo gráfico', porGrupo(L, t => (TFS.find(x => x[0] === t.tf) || [0, t.tf])[1]))}${tabelaGrupo('Por estado emocional', porGrupo(L, 'emocao'))}${tabelaGrupo('Por lado', porGrupo(L, 'lado'))}${tabelaGrupo('Papel × real', porGrupo(mine, 'tipo'))}</div></div>` : ''}`;
  }
}

/* ---------------------------------------------------------------- ações ---- */
function lerForm(root) {
  const o = {};
  root.querySelectorAll('[data-form] [data-k]').forEach(el => { o[el.dataset.k] = el.value.trim(); });
  return o;
}
function ligar(root, modo) {
  root.addEventListener('click', async ev => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, msg = root.querySelector('[data-msg]'), id = Number(el.dataset.id);
    try {
      if (act === 'tr-filtro') { gravarPref('tipo-' + modo, el.dataset.f); return desenhar(); }
      if (act === 'tr-recarregar') { return carregar(); }
      if (act === 'tr-calc') {
        if (typeof hojeCalcular !== 'function') return;
        const r = hojeCalcular();
        if (!r || r.erro) { msg.textContent = r && r.erro ? r.erro : 'Preencha a calculadora na tela Hoje primeiro.'; return; }
        const set = (k, v) => { const i = root.querySelector(`[data-form] [data-k="${k}"]`); if (i && v != null) i.value = v; };
        const c = r.c || {};
        set('ativo', c.ativo); set('lado', r.lado); set('tf', r.tf); set('entrada', c.entrada); set('stop', c.stop); set('alvo1', c.alvo1);
        set('risco_usd', r.risco != null ? Math.round(r.risco * 100) / 100 : null);
        set('qtd', r.notional && +c.entrada ? parseFloat((r.notional / +c.entrada).toPrecision(5)) : null);
        msg.textContent = 'Preenchido com a calculadora. Revise e registre.'; return;
      }
      if (act === 'tr-add') {
        const f = lerForm(root); f.mercado = modo; f.acao = 'add'; f.abertura = Date.now();
        if (!f.ativo) { msg.textContent = 'Escolha o ativo.'; return; }
        el.disabled = true; msg.textContent = 'Salvando…';
        const { trade } = await api(f);
        S.lista = [trade, ...(S.lista || [])];
        root.querySelectorAll('[data-form] input').forEach(i => { if (i.dataset.k !== 'setup') i.value = ''; });
        msg.textContent = 'Registrada.'; el.disabled = false; return desenhar();
      }
      if (act === 'tr-fechar') {
        const q = s => root.querySelector(`[${s}="${id}"]`);
        const saida = parseFloat(String(q('data-sai').value).replace(',', '.'));
        if (!(saida > 0)) { alert('Informe o preço de saída.'); return; }
        el.disabled = true;
        const { trade } = await api({ acao: 'update', id, saida, taxas_usd: q('data-tax').value, motivo: q('data-mot').value, fechamento: Date.now() });
        S.lista = S.lista.map(t => t.id === id ? trade : t); return desenhar();
      }
      if (act === 'tr-apagar') {
        if (!confirm('Excluir esta operação do diário? Não dá para desfazer.')) return;
        await api({ acao: 'apagar', id });
        S.lista = S.lista.filter(t => t.id !== id); return desenhar();
      }
    } catch (e) { el.disabled = false; if (msg) msg.textContent = msgErro(e); else alert(msgErro(e)); }
  });
}

/* ---------------------------------------------------------------- início ---- */
let iniciou = false;
function abrir() { if (!iniciou) { iniciou = true; desenhar(); carregar(); } else if (S.lista) desenhar(); }
document.querySelectorAll('.tab[data-tab="trades"], .tab[data-tab="a-trades"]').forEach(b => b.addEventListener('click', abrir));
window.addEventListener('hashchange', () => { if (/^#(a-)?trades$/.test(location.hash)) abrir(); });
setTimeout(() => { const p = document.querySelector('.panel:not([hidden])'); if (p && /^p-(a-)?trades$/.test(p.id)) abrir(); }, 600);
setInterval(() => {   // atualiza o R ao vivo das abertas, sem atrapalhar quem está digitando
  const p = document.querySelector('.panel:not([hidden])'), foco = document.activeElement;
  if (S.lista && p && /^p-(a-)?trades$/.test(p.id) && !document.hidden && !(foco && foco.closest && foco.closest('[data-slot="dyn"]'))) desenhar();
}, 30000);
