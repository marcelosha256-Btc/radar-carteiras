/* "Leia mais" automático: em qualquer aba, parágrafo longo mostra só 2 linhas e ganha um botão para abrir.
 * Não mexe no conteúdo (o HTML fica inteiro, só corta a altura com CSS), então funciona com textos que as telas redesenham.
 * O que você abriu continua aberto enquanto a página estiver aberta (lembrado pelo começo do texto). */
const MIN = 240;                       // caracteres para considerar "longo"
const abertos = new Set();
const chave = el => (el.textContent || '').trim().slice(0, 60);

const css = document.createElement('style');
css.textContent = `.lm-c{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lm-b{font:inherit;font-size:12px;background:none;border:0;padding:0;margin:2px 0 6px;color:var(--accent,#7f77dd);cursor:pointer;display:block}
.lm-b:hover{text-decoration:underline}`;
document.head.appendChild(css);

function elegivel(p) {
  if (p.dataset.lm === 'nao' || p.closest('details, svg, table, form, [contenteditable], .lm-nao')) return false;
  if (p.querySelector('button, input, select, textarea, table')) return false;
  return (p.textContent || '').trim().length >= MIN;
}
function botao(p) {
  let b = p.nextElementSibling;
  if (!b || !b.classList.contains('lm-b')) { b = document.createElement('button'); b.type = 'button'; b.className = 'lm-b'; p.after(b); }
  return b;
}
function aplicar(p) {
  if (!elegivel(p)) { if (p.classList.contains('lm-c')) p.classList.remove('lm-c'); return; }
  const k = chave(p), aberto = abertos.has(k);
  p.classList.toggle('lm-c', !aberto);
  // só põe o botão se o texto realmente passa de 2 linhas (no aberto, mede fechando por um instante)
  if (!aberto && p.scrollHeight <= p.clientHeight + 2) { const b = p.nextElementSibling; if (b && b.classList.contains('lm-b')) b.remove(); p.classList.remove('lm-c'); return; }
  const b = botao(p), t = aberto ? 'mostrar menos ▴' : 'leia mais ▾';
  if (b.textContent !== t) b.textContent = t;   // só escreve se mudou (senão o observador dispara de novo sem fim)
  b.setAttribute('aria-expanded', String(aberto));
}
function varrer(raiz = document) {
  if (!raiz.querySelectorAll) return;
  raiz.querySelectorAll('.panel:not([hidden]) p').forEach(p => { if (p.offsetParent !== null) aplicar(p); });
}

document.addEventListener('click', e => {
  const b = e.target.closest('.lm-b'); if (!b) return;
  const p = b.previousElementSibling; if (!p) return;
  const k = chave(p); if (abertos.has(k)) abertos.delete(k); else abertos.add(k);
  aplicar(p);
});
// as telas trocam o HTML o tempo todo: reaplica já no callback do observador (roda antes de a tela ser pintada, então não pisca)
new MutationObserver(() => varrer())
  .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
window.addEventListener('resize', () => varrer());
varrer();
