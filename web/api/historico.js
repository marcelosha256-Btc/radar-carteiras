// Histórico gravado no banco (candles e funding da Hyperliquid) para a aba Backtest. Só com a senha.
// GET /api/historico?coin=BTC&intervalo=1h  →  { candles: [[t,o,h,l,c,v], ...], funding: [[t, taxa], ...] }
import pg from 'pg';

const pool = new pg.Pool({ connectionString: (process.env.DATABASE_URL || '').trim(), max: 1, ssl: { rejectUnauthorized: false } });
const cache = new Map();   // por instância, 10 min: o histórico só muda uma vez por dia
const INTERVALOS = new Set(['5m', '15m', '1h', '4h', '1d']);

export default async function handler(req, res) {
  const senha = (process.env.PAINEL_SENHA || '').trim();
  if (!senha || (req.headers['x-senha'] || '').trim() !== senha) { res.status(401).json({ erro: 'senha' }); return; }
  const coin = String(req.query.coin || '').toUpperCase(), iv = String(req.query.intervalo || '');
  if (!/^[A-Z0-9]{1,15}$/.test(coin) || !INTERVALOS.has(iv)) { res.status(400).json({ erro: 'parametros' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  const semFunding = req.query.sem_funding === '1';
  const chave = coin + '|' + iv + (semFunding ? '|v' : ''), c = cache.get(chave);
  if (c && Date.now() - c.t < 10 * 60e3) { res.status(200).json(c.corpo); return; }
  try {
    const v = await pool.query('SELECT ts, o, h, l, c, v FROM candles WHERE coin = $1 AND "interval" = $2 ORDER BY ts', [coin, iv]);
    const ini = v.rows.length ? Number(v.rows[0].ts) : 0;
    const f = semFunding ? { rows: [] } : await pool.query('SELECT ts, rate FROM funding WHERE coin = $1 AND ts >= $2 ORDER BY ts', [coin, ini]);
    const corpo = { candles: v.rows.map(r => [Number(r.ts), r.o, r.h, r.l, r.c, r.v]), funding: f.rows.map(r => [Number(r.ts), r.rate]) };
    cache.set(chave, { t: Date.now(), corpo });
    res.status(200).json(corpo);
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/quota/i.test(msg) ? 503 : 500).json({ erro: /quota/i.test(msg) ? 'cota' : 'banco' });
  }
}
