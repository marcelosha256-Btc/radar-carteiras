/* Link para o gráfico do ativo na Hyperliquid (abre em aba nova). Cripto: /trade/BTC; ações do grupo xyz: /trade/xyz:NVDA.
 * Também fica em window.hlLink para o script da tela Hoje, que não é módulo. */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function urlHL(coin) { return 'https://app.hyperliquid.xyz/trade/' + encodeURIComponent(String(coin)).replace('%3A', ':'); }

export function hlLink(coin) {
  if (!coin || !/^(xyz:)?[A-Za-z0-9._-]{1,20}$/.test(String(coin))) return '';
  estilo();
  return `<a class="hl-link" href="${esc(urlHL(coin))}" target="_blank" rel="noopener noreferrer" title="Abrir o gráfico de ${esc(String(coin).replace('xyz:', ''))} na Hyperliquid (aba nova)">↗ Hyperliquid</a>`;
}

function estilo() {
  if (typeof document === 'undefined' || document.getElementById('estilo-hl')) return;
  const s = document.createElement('style'); s.id = 'estilo-hl';
  s.textContent = '.hl-link{display:inline-block;margin-left:6px;padding:1px 7px;border:1px solid var(--line);border-radius:999px;font:500 11px/1.5 var(--f-body,inherit);color:var(--muted);text-decoration:none;white-space:nowrap;vertical-align:middle}.hl-link:hover{color:var(--fg);border-color:var(--fg)}';
  document.head.appendChild(s);
}
if (typeof window !== 'undefined') { window.hlLink = hlLink; window.dispatchEvent(new Event('hl-pronto')); }
