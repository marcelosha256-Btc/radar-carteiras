/* "Radar da manhã" na tela Hoje: onde olhar primeiro. Mostra quem mais se mexeu na noite (22h → 8h, Brasília), se já voltou
 * ou seguiu desde as 8h, e se o volume está fora do normal. É um filtro de ATENÇÃO, não de direção: no teste de 208 dias o
 * movimento da noite não previu o lado do dia, mas previu o tamanho do movimento. Dados direto da Hyperliquid, no navegador. */
const HL = 'https://api.hyperliquid.xyz/info', H = 36e5, BRT = 3 * H;   // Brasília = UTC−3 o ano todo
const ALVOS = { cripto: 'manhaCripto', acoes: 'manhaAcoes' };
/* critérios para entrar no ranking (quem está na sua lista de observação ou no painel entra sempre, marcado com ★) */
const CRIT = { cripto: { volMin: 50e6, levMin: 5, dias: 90, max: 30 }, acoes: { volMin: 5e6, levMin: 5, dias: 90, max: 30 } };
const NAO_INDIVIDUAIS = new Set(['XYZ100', 'SP500', 'GOLD', 'SILVER', 'BRENTOIL', 'CL', 'JPY', 'EWY', 'KORU', 'SOXL']);   // índices, commodities, câmbio e ETFs
const lerPref = (k, d) => { try { const v = localStorage.getItem('radar-manha-' + k); return v == null ? d : v; } catch (e) { return d; } };
const gravarPref = (k, v) => { try { localStorage.setItem('radar-manha-' + k, v); } catch (e) {} };
/* volume típico por hora de Brasília (1,0 = média do dia), medido em 208 dias na Hyperliquid */
const PERFIL = {
  cripto: [.81, .77, .81, .72, .74, .88, .81, .79, .82, 1.10, 1.40, 1.67, 1.57, 1.35, 1.14, 1.09, .97, .98, 1.02, .92, .81, 1.00, .91, .93],
  acoes: [.57, .50, .61, .60, .50, .73, .62, .56, .64, .86, 2.60, 2.55, 1.75, 1.36, 1.10, .94, 1.18, 1.08, .77, .68, .88, 1.26, 1.00, .69],
};
const num = (v, d = 1) => (+v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = v => v == null ? '—' : (v > 0 ? '+' : '') + num(v, 1) + '%';
const cls = v => v == null ? 'muted' : v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dormir = ms => new Promise(r => setTimeout(r, ms));
const hl = async (corpo, tent = 0) => {
  const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  if (r.status === 429 && tent < 3) { await dormir(1500 * (tent + 1)); return hl(corpo, tent + 1); }   // limite de requisições: espera e tenta de novo
  if (!r.ok) throw new Error(r.status);
  return r.json();
};

/* ---------------------------------------------------------------- cálculo (puro) ---- */
/* a noite termina às 8h de Brasília (11h UTC) mais recente que já passou e começa 10 h antes */
export function janelaNoite(agora) {
  const dia = Math.floor(agora / (24 * H)) * 24 * H;
  let fim = dia + 11 * H;
  if (fim > agora) fim -= 24 * H;
  return { ini: fim - 10 * H, fim };
}
/* V = candles de 1h {t,o,c,v em US$}; devolve movimento da noite, desde as 8h e volume contra o normal */
export function resumo(V, agora) {
  const { ini, fim } = janelaNoite(agora), por = new Map(V.map(x => [x.t, x]));
  const a = por.get(ini), b = por.get(fim);
  if (!a || !b) return null;
  const ultimo = V[V.length - 1];
  const soma = (t0) => { let s = 0, n = 0; for (let t = t0; t < t0 + 10 * H; t += H) { const x = por.get(t); if (x) { s += x.v; n++; } } return n >= 8 ? s : null; };
  const volNoite = soma(ini);
  const tip = [1, 2, 3, 4, 5, 6, 7].map(k => soma(ini - k * 24 * H)).filter(x => x != null);
  const hora = Math.floor(agora / H) * H - H, vh = por.get(hora);
  const tipH = [1, 2, 3, 4, 5, 6, 7].map(k => por.get(hora - k * 24 * H)).filter(Boolean).map(x => x.v);
  const media = L => L.reduce((s, x) => s + x, 0) / L.length;
  return {
    noite: (b.o / a.o - 1) * 100,
    desde8: agora - fim >= H && ultimo ? (ultimo.c / b.o - 1) * 100 : null,
    rvolNoite: volNoite != null && tip.length >= 3 ? volNoite / media(tip) : null,
    rvolAgora: vh && tipH.length >= 3 ? vh.v / media(tipH) : null,
  };
}

/* amplitude diária média (em % do preço) dos últimos 14 dias fechados: o "normal" de movimento do ativo */
export function atrPct(D, n = 14) {
  const L = D.slice(0, -1).slice(-n);   // descarta o dia em formação
  return L.length >= 7 ? L.reduce((s, x) => s + (x.h - x.l) / x.c, 0) / L.length * 100 : null;
}

/* ---------------------------------------------------------------- dados ---- */
function fixos(modo, universo) {
  let obs = []; try { obs = JSON.parse(localStorage.getItem('radar-hoje-obs') || '[]'); } catch (e) {}
  let painel = [];
  if (modo === 'cripto' && typeof DADOS_HOJE !== 'undefined' && DADOS_HOJE && DADOS_HOJE.ativos) painel = DADOS_HOJE.ativos.map(a => a.t);
  const nomes = [...obs, ...painel].map(t => modo === 'acoes' ? (String(t).startsWith('xyz:') ? t : 'xyz:' + t) : t);
  return new Set(nomes.filter(n => universo.has(n)));
}
/* a última leitura fica guardada no navegador: a tabela aparece na hora e se atualiza por trás. Só vale dentro da mesma noite e por até 30 min. */
function lerGuardado(modo) {
  try {
    const c = JSON.parse(localStorage.getItem('radar-manha-cache-' + modo) || 'null');
    if (c && Date.now() - c.t < 30 * 60000 && c.fim === janelaNoite(Date.now()).fim && c.individuais === lerPref('individuais', '1')) return c;
  } catch (e) {}
  return null;
}
const cache = { cripto: lerGuardado('cripto'), acoes: lerGuardado('acoes') };
async function carregar(modo) {
  const dex = modo === 'acoes' ? 'xyz' : '', C = CRIT[modo], soIndiv = modo === 'acoes' && lerPref('individuais', '1') === '1';
  const [meta, ctx] = await hl(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' });
  const todos = meta.universe.map((u, i) => ({ n: u.name, v: +ctx[i].dayNtlVlm, lev: u.maxLeverage, morto: u.isDelisted }));
  const fx = fixos(modo, new Set(todos.map(x => x.n)));
  const bom = x => !x.morto && x.v >= C.volMin && x.lev >= C.levMin && !(soIndiv && NAO_INDIVIDUAIS.has(x.n.replace('xyz:', '')));
  const lista = [...new Set([...todos.filter(bom).sort((a, b) => b.v - a.v).slice(0, C.max).map(x => x.n), ...fx])];
  const agora = Date.now(), linhas = [];
  for (let i = 0; i < lista.length; i += 3) {   // em lotes pequenos, para não estourar o limite de requisições
    if (i) await dormir(400);
    const lote = await Promise.all(lista.slice(i, i + 3).map(async coin => {
      try {
        const [h1, d1] = await Promise.all([
          hl({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: agora - 9 * 24 * H, endTime: agora } }),
          hl({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: agora - 100 * 24 * H, endTime: agora } })]);
        const V = h1.map(x => ({ t: x.t, o: +x.o, c: +x.c, v: +x.v * +x.c })), D = d1.map(x => ({ h: +x.h, l: +x.l, c: +x.c }));
        const r = resumo(V, agora), atr = atrPct(D), fixo = fx.has(coin);
        if (!r || (!fixo && D.length < C.dias)) return null;   // sem histórico suficiente: fora (exceto os seus)
        return { coin, fixo, atr, forca: atr ? Math.abs(r.noite) / atr : null, ...r };
      } catch (e) { return null; }
    }));
    linhas.push(...lote.filter(Boolean));
  }
  cache[modo] = { t: agora, linhas, soIndiv };
  try { localStorage.setItem('radar-manha-cache-' + modo, JSON.stringify({ t: agora, linhas, fim: janelaNoite(agora).fim, individuais: lerPref('individuais', '1') })); } catch (e) {}
  return cache[modo];
}

/* ---------------------------------------------------------------- desenho ---- */
function faixaHoras(modo, agora) {
  const hBRT = new Date(agora - BRT).getUTCHours(), P = PERFIL[modo], mx = Math.max(...P);
  const cel = P.map((v, h) => `<div title="${String(h).padStart(2, '0')}h — volume típico ${num(v, 1)}×" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
      <div style="width:100%;height:${Math.max(3, v / mx * 34)}px;border-radius:2px;background:${v >= 1.3 ? 'var(--up)' : v >= 0.9 ? 'var(--accent)' : 'var(--line)'};${h === hBRT ? 'outline:2px solid var(--fg);outline-offset:1px' : ''}"></div>
      <span style="font-size:9px;color:${h === hBRT ? 'var(--fg)' : 'var(--faint)'};font-weight:${h === hBRT ? 700 : 400}">${h % 3 === 0 || h === hBRT ? String(h).padStart(2, '0') : ''}</span></div>`).join('');
  const bom = P[hBRT] >= 1.3, fino = P[hBRT] < 0.8;
  return `<div style="display:flex;align-items:flex-end;gap:2px;height:56px">${cel}</div>
    <p class="small muted" style="margin:4px 0 0">Agora são <b style="color:var(--fg)">${String(hBRT).padStart(2, '0')}h</b> em Brasília: ${bom ? '<b class="pos">janela boa de liquidez</b>' : fino ? '<b style="color:var(--warn)">horário fino</b>, custo de entrada maior e movimentos menos confiáveis' : 'liquidez normal'}. Barras = volume típico por hora (verde: acima de 1,3×).</p>`;
}
function tabela(modo, linhas) {
  const ord = (x, y) => (y.forca || 0) - (x.forca || 0);
  const top = [...linhas.filter(r => r.fixo).sort(ord).slice(0, 8), ...linhas.filter(r => !r.fixo).sort(ord).slice(0, 6)];
  if (!top.length) return '<p class="muted small">Nenhum ativo passou nos critérios agora (ou os candles não carregaram).</p>';
  const rv = v => v == null ? '<span class="muted">—</span>' : `<span ${v >= 1.5 ? 'class="pos"' : v < 0.7 ? 'class="muted"' : ''}>${num(v, 1)}×</span>`;
  const fr = v => v == null ? '<span class="muted">—</span>' : `<span ${v >= 1.5 ? 'style="color:var(--warn);font-weight:600"' : ''}>${num(v, 1)}×</span>`;
  return `<div class="tbl-wrap"><table><thead><tr><th>Ativo</th><th>Noite (22h→8h)</th><th title="Movimento da noite dividido pela amplitude diária normal do ativo">Força (× normal)</th><th>Desde as 8h</th><th>Volume da noite</th><th>Volume agora</th></tr></thead><tbody>${
    top.map(r => `<tr data-coin="${esc(r.coin)}" style="cursor:pointer" title="Ver execução e funding deste ativo"><td>${r.fixo ? '<span title="Na sua lista" style="color:var(--warn)">★</span> ' : ''}<b>${esc(r.coin.replace('xyz:', ''))}</b></td>
      <td class="${cls(r.noite)}"><b>${pct(r.noite)}</b></td><td>${fr(r.forca)}</td><td class="${cls(r.desde8)}">${pct(r.desde8)}</td><td>${rv(r.rvolNoite)}</td><td>${rv(r.rvolAgora)}</td></tr>`).join('')}</tbody></table></div>`;
}
function desenhar(modo) {
  const root = document.getElementById(ALVOS[modo]);
  if (!root) return;
  const c = cache[modo], agora = Date.now();
  root.innerHTML = `<div class="box"><div class="box-head"><h2>Radar da manhã</h2><p>Onde olhar primeiro. Filtro de atenção, não de direção.</p></div>
    ${faixaHoras(modo, agora)}
    <h3 class="hj-sub" style="margin-top:12px">Quem mais se mexeu na noite ${modo === 'acoes' ? '(ações)' : '(cripto)'}</h3>
    ${modo === 'acoes' ? `<label class="small muted" style="display:inline-flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" data-indiv ${lerPref('individuais', '1') === '1' ? 'checked' : ''}> só ações individuais (sem índices, commodities e ETFs)</label>` : ''}
    ${c ? tabela(modo, c.linhas) : '<p class="muted small">Lendo os candles da Hyperliquid… (leva até 40 s na primeira vez)</p>'}
    ${c ? `<p class="small muted" style="margin:4px 0 0">Atualizado há ${Math.max(0, Math.round((agora - c.t) / 60000))} min${emCurso[modo] ? ' · atualizando…' : ''}</p>` : ''}
    <p class="small muted" style="margin-top:6px">Entram só ativos com volume de pelo menos US$ ${CRIT[modo].volMin / 1e6} mi em 24 h, alavancagem máxima de ${CRIT[modo].levMin}x ou mais e ${CRIT[modo].dias} dias de histórico. ★ = da sua lista (entram sempre). Força = movimento da noite ÷ amplitude diária normal; acima de 1,5× é fora do comum.</p>
    <p class="small muted" style="margin-top:8px">Volume = quanto negociou contra o normal do mesmo horário (1,0× é o normal). No teste de 208 dias, quem se mexeu muito na noite tendeu a se mexer muito de dia, mas o <b>lado</b> do dia não ficou previsível. Escolha a direção pela estrutura (diário, 4H) e use o stop da calculadora.</p></div>`;
  const ck = root.querySelector('[data-indiv]');
  if (ck) ck.addEventListener('change', () => { gravarPref('individuais', ck.checked ? '1' : '0'); cache.acoes = null; ciclo('acoes'); desenhar('acoes'); });
  root.querySelectorAll('tr[data-coin]').forEach(tr => tr.addEventListener('click', () => {   // leva o ativo para o cartão "Mercado agora"
    const sel = document.querySelector(`#${modo === 'acoes' ? 'mercAcoes' : 'mercCripto'} [data-merc]`);
    if (sel && [...sel.options].some(o => o.value === tr.dataset.coin)) { sel.value = tr.dataset.coin; sel.dispatchEvent(new Event('change')); sel.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }));
}
const emCurso = {};
async function ciclo(modo) {
  const c = cache[modo];
  if (emCurso[modo] || (c && Date.now() - c.t < 5 * 60000)) return;
  emCurso[modo] = true; if (c) desenhar(modo);
  try { await carregar(modo); } catch (e) { cache[modo] = { t: Date.now() - 4 * 60000, linhas: c ? c.linhas : [] }; }   // falhou: tenta de novo em 1 min, sem martelar a API
  emCurso[modo] = false;
  desenhar(modo);
}
const visivel = modo => !document.hidden && !!document.querySelector(modo === 'acoes' ? '#p-a-hoje:not([hidden])' : '#p-hoje:not([hidden])');
for (const m of Object.keys(ALVOS)) desenhar(m);
/* só carrega o modo que está na tela (e só de novo quando os dados têm mais de 5 min) */
setInterval(() => {
  const ms = Object.keys(ALVOS), vis = ms.filter(visivel);
  vis.forEach(m => ciclo(m));
  // com a tela livre, o outro modo carrega em segundo plano (um de cada vez, para não bater no limite da API)
  if (vis.length && !ms.some(m => emCurso[m])) { const o = ms.find(m => !vis.includes(m) && !cache[m]); if (o) ciclo(o); }
}, 5000);
for (const m of Object.keys(ALVOS)) if (cache[m]) desenhar(m);
