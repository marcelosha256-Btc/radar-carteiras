// Nota de setup da Trava, gravada a cada 15 min para medir depois se ela funciona (só os 6 cripto: a Coinversa é paga).
// GET /api/notas?coin=BTC   header x-token = HMAC-SHA256(senha do DATABASE_URL, "notas:<minuto>")  → { t, notas: [...] }  (não grava nada)
// Quem chama é o laço de alertas no GitHub (coletor/alertas.py), que já abre o banco a cada 20 min e grava as notas junto:
// assim o banco (Neon grátis, cota apertada) não acorda nenhuma vez a mais. O cálculo é o mesmo da página (aovivo/trava.js).
import crypto from 'node:crypto';
import { cv, hl, mapa, press } from './liquidez.js';
import { montarMapa, zones, setupNota, chanceDe } from '../aovivo/trava.js';

export const config = { maxDuration: 30 };
export const ATIVOS_NOTAS = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'NEAR'];
const VELA = 9e5;

/** chave = senha do usuário do banco: o site e o GitHub têm o DATABASE_URL (talvez um com pooler e outro sem), então não
 *  precisa de segredo novo. Mesma regra do coletor/alertas.py (chave_notas). */
export function chaveNotas(url) {
  if (!url) return '';
  let u = String(url).trim().split(/\s+/)[0].replace(/^['"]|['"]$/g, '');
  if (u.startsWith('DATABASE_URL=')) u = u.slice(13).replace(/^['"]|['"]$/g, '');
  try { return new URL(u).password || ''; } catch (e) { return ''; }
}
/** token do minuto */
export function tokenNotas(chave, minuto) {
  return crypto.createHmac('sha256', chave).update('notas:' + minuto).digest('hex');
}
export function tokenValido(chave, token, agora = Date.now()) {
  if (!chave || !token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const m = Math.floor(agora / 60000);
  return [m, m - 1, m - 2, m + 1].some(x => crypto.timingSafeEqual(Buffer.from(tokenNotas(chave, x)), Buffer.from(token)));
}

const velas = (coin, interval, ms, n, agora) => hl({ type: 'candleSnapshot', req: { coin, interval, startTime: agora - n * ms, endTime: agora } })
  .then(a => a.map(x => ({ t: x.t, o: +x.o, c: +x.c, h: +x.h, l: +x.l })));

/** preço de 15 min atrás pelas velas de 1 min (a página usa o mesmo: preço agora ÷ preço de 15 min atrás) */
export function variacao15(c1m, cur, agora) {
  const alvo = agora - VELA; let p = null;
  for (const x of c1m || []) { if (x.t + 60e3 <= alvo) p = x.c; else break; }
  return p ? (cur / p - 1) * 100 : 0;
}

async function notasDe(coin, cur, agora) {
  const [m, P, s, c15, c4h, c1d, c1w, c1h, c1m] = await Promise.all([
    mapa(coin), press(coin),
    cv(`/live/risk/liquidations/summary?since=1h&coin=${encodeURIComponent(coin)}`).catch(() => null),
    velas(coin, '15m', 9e5, 110, agora), velas(coin, '4h', 144e5, 110, agora), velas(coin, '1d', 864e5, 110, agora), velas(coin, '1w', 7 * 864e5, 110, agora),
    velas(coin, '1h', 36e5, 5000, agora), velas(coin, '1m', 6e4, 25, agora),
  ]);
  const zn = zones(montarMapa(m), cur), chance = chanceDe(c1h, agora), c15p = variacao15(c1m, cur, agora);
  const sum1h = s ? { long: s.longNotional || 0, short: s.shortNotional || 0 } : null;
  const cand = { '15m': c15, '4h': c4h, '1d': c1d, '1w': c1w }, t = Math.floor(agora / VELA) * VELA, out = [];
  for (const modo of ['day', 'swing']) for (const lado of ['compra', 'venda']) {
    const r = setupNota({ k: coin, cur, zn, c15: c15p, cand, chance, press: P, sum1h, modo, lado, agora });
    out.push({ t, moeda: coin, modo, lado, nota: r.sc, bloqueado: r.blocks.length ? 1 : 0, preco: cur, stop: r.stop, alvo: r.alvo, rr: r.rr,
      itens: JSON.stringify({ pros: r.pros, cons: r.cons, bloq: r.blocks }) });
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!tokenValido(chaveNotas(process.env.DATABASE_URL), String(req.headers['x-token'] || ''))) { res.status(401).json({ erro: 'token' }); return; }
  if (!(process.env.COINVERSA_API_KEY || '').trim()) { res.status(503).json({ erro: 'sem chave da Coinversa' }); return; }
  // um ativo por chamada: as 5.000 velas de 1 h de cada um pesam no limite da Hyperliquid; o laço chama um de cada vez, espaçado
  const coin = String(req.query.coin || '');
  if (!ATIVOS_NOTAS.includes(coin)) { res.status(400).json({ erro: 'coin' }); return; }
  const agora = Date.now();
  try {
    const mids = await hl({ type: 'allMids' }), cur = +mids[coin];
    if (!(cur > 0)) throw new Error('sem preço');
    res.status(200).json({ t: Math.floor(agora / VELA) * VELA, notas: await notasDe(coin, cur, agora) });
  } catch (e) {
    res.status(502).json({ erro: String(e.message || e) });
  }
}
