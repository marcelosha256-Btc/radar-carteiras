// Endereço público da carteira do Marcelo na Hyperliquid (só leitura: o endereço não dá acesso aos fundos).
// GET /api/minha → { carteira }   ·   POST /api/minha { carteira: '0x…' | '' }
import pg from 'pg';

const pool = new pg.Pool({ connectionString: (process.env.DATABASE_URL || '').trim(), max: 1, ssl: { rejectUnauthorized: false } });

export default async function handler(req, res) {
  const senha = (process.env.PAINEL_SENHA || '').trim();
  if (!senha || (req.headers['x-senha'] || '').trim() !== senha) { res.status(401).json({ erro: 'senha' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const c = String(b.carteira || '').trim().toLowerCase();
      if (c && !/^0x[0-9a-f]{40}$/.test(c)) { res.status(400).json({ erro: 'endereco' }); return; }
      await pool.query(`INSERT INTO kv (chave, valor, atualizado) VALUES ('minha_carteira', $1, $2)
        ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado = EXCLUDED.atualizado`, [JSON.stringify(c), Date.now()]);
      res.status(200).json({ carteira: c }); return;
    }
    const { rows } = await pool.query("SELECT valor FROM kv WHERE chave = 'minha_carteira'");
    res.status(200).json({ carteira: rows.length ? JSON.parse(rows[0].valor) : '' });
  } catch (e) {
    const q = /quota/i.test(String(e.message || e));
    res.status(q ? 503 : 500).json({ erro: q ? 'cota' : 'banco' });
  }
}
