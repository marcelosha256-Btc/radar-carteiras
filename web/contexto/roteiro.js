/* Roteiro do dia: uma faixa abaixo das abas que mostra em que passo da decisão você está e qual é o próximo.
 * 1 Posso operar? (Hoje) → 2 Tem evento? → 3 Qual lado? (RSI Mestre) → 4 Stop e alvo (Gráfico) → 5 Hora de entrar? (Liquidez ao vivo) → 6 Registrar (Meu diário).
 * A trava do dia (risco/tela.js → window.radarRisco.trava) aparece em vermelho em TODAS as telas quando manda parar. */
const PASSOS = [
  { id: 'hoje', paineis: ['p-hoje'], nome: 'Posso operar?', ir: 'hoje' },
  { id: 'eventos', paineis: ['p-a-eventos'], nome: 'Tem evento?', ir: 'a-eventos' },
  { id: 'rsi', paineis: ['p-rsi'], nome: 'Qual lado?', ir: 'rsi' },
  { id: 'grafico', paineis: ['p-grafico', 'p-a-grafico'], nome: 'Stop e alvo', ir: 'grafico-pref' },
  { id: 'aovivo', paineis: ['p-aovivo', 'p-a-aovivo'], nome: 'Hora de entrar?', ir: 'aovivo-pref' },
  { id: 'trades', paineis: ['p-trades'], nome: 'Registrar', ir: 'trades' },
];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const diaBRT = () => new Date(Date.now() - 3 * 36e5).toISOString().slice(0, 10);
function vistos() {
  try { const v = JSON.parse(localStorage.getItem('radar-roteiro') || 'null'); return v && v.dia === diaBRT() ? v.v : []; } catch (e) { return []; }
}
function marcar(id) {
  const v = vistos(); if (v.includes(id)) return;
  try { localStorage.setItem('radar-roteiro', JSON.stringify({ dia: diaBRT(), v: [...v, id] })); } catch (e) {}
}

const css = document.createElement('style');
css.textContent = `.rt{margin:8px 0 4px}
.rt-trava{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;padding:8px 12px;border-radius:8px;background:var(--down-soft);color:var(--down);border:1px solid var(--down);font-size:13.5px;margin-bottom:6px}
.rt-trava b{font-weight:700}.rt-trava button{font:inherit;font-size:12.5px;background:none;border:0;color:inherit;text-decoration:underline;cursor:pointer;padding:0}
.rt-linha{display:flex;gap:4px;align-items:center;overflow-x:auto;padding-bottom:2px}
.rt-p{font:inherit;font-size:12.5px;white-space:nowrap;display:inline-flex;gap:5px;align-items:center;padding:4px 9px;border-radius:999px;border:1px solid var(--line);background:none;color:var(--muted);cursor:pointer}
.rt-p i{font-style:normal;font-weight:700;min-width:16px;height:16px;line-height:16px;border-radius:50%;text-align:center;font-size:11px;background:var(--line);color:var(--fg)}
.rt-p[aria-current="step"]{color:var(--fg);border-color:var(--accent);font-weight:600}
.rt-p[aria-current="step"] i{background:var(--accent);color:#fff}
.rt-p.ok i{background:var(--up);color:#fff}.rt-p.pare i{background:var(--down);color:#fff}.rt-p .rt-av{color:var(--warn);font-weight:600}
.rt-seta{color:var(--faint,var(--muted));font-size:11px}
.rt-prox{margin-left:auto;font:inherit;font-size:12.5px;font-weight:600;white-space:nowrap;padding:5px 12px;border-radius:6px;border:0;background:var(--accent);color:#fff;cursor:pointer}
.rt-prox.pare{background:var(--down)}`;
document.head.appendChild(css);

const box = document.createElement('div'); box.className = 'rt'; box.id = 'roteiro';
box.innerHTML = '<div class="rt-trava" hidden></div><nav class="rt-linha" aria-label="Roteiro do dia"></nav>';
const ancora = document.querySelector('.tabs-scroll');
if (ancora) ancora.after(box);

function eventoForte() {   // dado de alto impacto nas próximas 24 h (vale para ações e cripto)
  try {
    if (typeof hojeEventos !== 'function' || typeof DADOS_HOJE === 'undefined' || !DADOS_HOJE) return null;
    const agora = Date.now();
    return hojeEventos(DADOS_HOJE).find(e => e.impacto === 'alto' && e.t >= agora - 30 * 60000 && e.t <= agora + 864e5) || null;
  } catch (e) { return null; }
}
const hhmm = t => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

let sig = '';
function desenhar() {
  const vis = document.querySelector('.panel:not([hidden])'), pid = vis ? vis.id : '';
  const atual = PASSOS.findIndex(p => p.paineis.includes(pid));
  if (atual >= 0) marcar(PASSOS[atual].id);
  const T = window.radarRisco && window.radarRisco.trava, parar = !!(T && T.parar), ev = eventoForte(), v = vistos();
  const s = [pid, parar, T ? T.motivos.join() : '', ev ? ev.nome + ev.t : '', v.join()].join('|');
  if (s === sig) return; sig = s;

  const tr = box.querySelector('.rt-trava');
  tr.hidden = !parar;
  if (parar) tr.innerHTML = `<span>⛔ <b>Dia travado — não abra posição.</b> ${esc(T.motivos.join(' · '))}.</span><button type="button" data-ir="trades">revisar no Meu diário</button>`;

  const nav = box.querySelector('.rt-linha');
  nav.hidden = atual < 0;   // nas abas de Pesquisa só a trava aparece
  if (atual < 0) return;
  nav.innerHTML = PASSOS.map((p, i) => {
    let cls = v.includes(p.id) && i !== atual ? 'ok' : '', extra = '';
    if (p.id === 'hoje' && T) { cls = parar ? 'pare' : cls; extra = parar ? ' <span style="color:var(--down)">travado</span>' : ''; }
    if (p.id === 'eventos' && ev) extra = ` <span class="rt-av" title="${esc(ev.nome)}">⚠ ${esc(ev.nome.length > 18 ? ev.nome.slice(0, 17) + '…' : ev.nome)} ${hhmm(ev.t)}</span>`;
    return `${i ? '<span class="rt-seta">›</span>' : ''}<button type="button" class="rt-p ${cls}" data-ir="${p.ir}" ${i === atual ? 'aria-current="step"' : ''}><i>${cls === 'ok' ? '✓' : cls === 'pare' ? '!' : i + 1}</i>${p.nome}${extra}</button>`;
  }).join('') + (parar
    ? (PASSOS[atual].id === 'trades' ? '' : '<button type="button" class="rt-prox pare" data-ir="trades">Dia travado: só revisar →</button>')
    : atual < PASSOS.length - 1 ? `<button type="button" class="rt-prox" data-ir="${PASSOS[atual + 1].ir}">Próximo: ${atual + 2} ${PASSOS[atual + 1].nome} →</button>` : '<span class="small muted" style="margin-left:auto">fim do roteiro · registre tudo, inclusive o que não entrou</span>');
}

box.addEventListener('click', e => {
  const b = e.target.closest('[data-ir]'); if (!b || typeof window.show !== 'function') return;
  window.show(b.dataset.ir);
  if (b.dataset.ir === 'trades') document.querySelector('.tab[data-tab="trades"]')?.dispatchEvent(new Event('click'));   // o diário carrega ao abrir a aba
  window.scrollTo(0, 0);
});
document.querySelectorAll('.panel').forEach(p => new MutationObserver(desenhar).observe(p, { attributes: true, attributeFilter: ['hidden'] }));
window.addEventListener('radar-risco', desenhar);
setInterval(desenhar, 60000);
desenhar();
