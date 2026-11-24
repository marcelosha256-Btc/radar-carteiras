/* Dados da sua conta na Hyperliquid (só leitura, pelo endereço público), compartilhados pelo cartão de regras e pelo Meu diário. */
import { consolidarFills } from './regras.js';

const HL = 'https://api.hyperliquid.xyz/info';
const ESTAVEIS = new Set(['USDC', 'USDT0', 'USDH', 'USDE']);
export const carteira = () => { try { return localStorage.getItem('radar-carteira') || ''; } catch (e) { return ''; } };
const hl = async (corpo, tent = 0) => {
  const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  if (r.status === 429 && tent < 3) { await new Promise(ok => setTimeout(ok, 1500 * (tent + 1))); return hl(corpo, tent + 1); }   // limite da API: espera e tenta de novo
  if (!r.ok) throw new Error(r.status);
  return r.json();
};

const cache = {};
function memo(chave, ms, f) {
  const c = cache[chave];
  if (c && Date.now() - c.t < ms) return c.p;
  const p = f().catch(e => { delete cache[chave]; throw e; });
  cache[chave] = { t: Date.now(), p };
  return p;
}

/** operações reconstruídas das suas execuções dos últimos 30 dias */
export function operacoes(forcar) {
  const user = carteira();
  if (!user) return Promise.resolve([]);
  if (forcar) delete cache['ops' + user];
  return memo('ops' + user, 60000, async () => {
    const fills = await hl({ type: 'userFillsByTime', user, startTime: Date.now() - 30 * 864e5, aggregateByTime: true });
    return consolidarFills(Array.isArray(fills) ? fills : []);
  });
}

/** saldo (conta de trading + spot em stablecoins) e PnL aberto agora */
export function conta() {
  const user = carteira();
  if (!user) return Promise.resolve(null);
  return memo('conta' + user, 20000, async () => {
    const [a, b, sp] = await Promise.all([hl({ type: 'clearinghouseState', user }), hl({ type: 'clearinghouseState', user, dex: 'xyz' }).catch(() => null),
      hl({ type: 'spotClearinghouseState', user }).catch(() => null)]);
    const est = [a, b].filter(Boolean);
    const perp = est.reduce((s, x) => s + +x.marginSummary.accountValue, 0);
    const spot = sp && sp.balances ? sp.balances.filter(x => ESTAVEIS.has(x.coin)).reduce((s, x) => s + +x.total, 0) : 0;
    const aberto = est.reduce((s, x) => s + (x.assetPositions || []).reduce((t, p) => t + +p.position.unrealizedPnl, 0), 0);
    return { saldo: perp + spot, aberto };
  });
}
