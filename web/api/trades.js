// Diário de operações do próprio trader (em R). Só com a senha.
// GET  /api/trades                       → { trades: [...] }
// POST /api/trades {acao:'add'|'update'|'apagar', ...campos}
import pg from 'pg';
import { limpar, calcR } from '../diario/calculo.js';

const pool = new pg.Pool({ connectionString: (process.env.DATABASE_URL || '').trim(), max: 1, ssl: { rejectUnauthorized: false } });
let pronto = false;
async function garantirTabela() {
  if (pronto) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS diario_trades (
    id SERIAL PRIMARY KEY, criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    ativo TEXT NOT NULL, mercado TEXT NOT NULL DEFAULT 'cripto', lado TEXT NOT NULL, tf TEXT, setup TEXT,
    tipo TEXT NOT NULL DEFAULT 'papel', status TEXT NOT NULL DEFAULT 'aberto',
    entrada DOUBLE PRECISION NOT NULL, stop DOUBLE PRECISION NOT NULL, alvo1 DOUBLE PRECISION, alvo2 DOUBLE PRECISION,
    qtd DOUBLE PRECISION, risco_usd DOUBLE PRECISION, abertura BIGINT, fechamento BIGINT,
    saida DOUBLE PRECISION, taxas_usd DOUBLE PRECISION, motivo TEXT, r DOUBLE PRECISION, resultado_usd DOUBLE PRECISION,
    emocao TEXT, nota TEXT)`);
  pronto = true;
}
export default async function handler(req, res) {
  const senha = (process.env.PAINEL_SENHA || '').trim();
  if (!senha || (req.headers['x-senha'] || '').trim() !== senha) { res.status(401).json({ erro: 'senha' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  try {
    await garantirTabela();
    if (req.method === 'GET') {
      const { rows } = await pool.query('SELECT * FROM diario_trades ORDER BY COALESCE(abertura, EXTRACT(EPOCH FROM criado_em) * 1000) DESC, id DESC LIMIT 2000');
      res.status(200).json({ trades: rows }); return;
    }
    if (req.method !== 'POST') { res.status(405).json({ erro: 'metodo' }); return; }
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.acao === 'apagar') {
      await pool.query('DELETE FROM diario_trades WHERE id = $1', [Number(b.id)]);
      res.status(200).json({ ok: true }); return;
    }
    if (b.acao === 'add') {
      const t = limpar(b);
      if (!t.ativo || !t.lado || !(t.entrada > 0) || !(t.stop > 0) || t.entrada === t.stop) { res.status(400).json({ erro: 'campos' }); return; }
      if ((t.lado === 'compra') !== (t.stop < t.entrada)) { res.status(400).json({ erro: 'stop_lado' }); return; }
      Object.assign(t, calcR(t));
      const ks = Object.keys(t);
      const { rows } = await pool.query(`INSERT INTO diario_trades (${ks.join(',')}) VALUES (${ks.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, ks.map(k => t[k]));
      res.status(200).json({ trade: rows[0] }); return;
    }
    if (b.acao === 'update') {
      const id = Number(b.id);
      const atual = (await pool.query('SELECT * FROM diario_trades WHERE id = $1', [id])).rows[0];
      if (!atual) { res.status(404).json({ erro: 'nao_achei' }); return; }
      const t = { ...atual, ...limpar(b) };
      if ((t.lado === 'compra') !== (t.stop < t.entrada)) { res.status(400).json({ erro: 'stop_lado' }); return; }
      const novo = { ...limpar(b), ...calcR(t) };
      const ks = Object.keys(novo);
      const { rows } = await pool.query(`UPDATE diario_trades SET ${ks.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...ks.map(k => novo[k])]);
      res.status(200).json({ trade: rows[0] }); return;
    }
    res.status(400).json({ erro: 'acao' });
  } catch (e) {
    const msg = String(e.message || e);
    if (/quota/i.test(msg)) { res.status(503).json({ erro: 'cota' }); return; }
    const ruim = /^(lado|mercado|tipo)$/.test(msg);
    res.status(ruim ? 400 : 500).json({ erro: ruim ? msg : 'banco' });
  }
}
