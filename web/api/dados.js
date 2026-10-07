// Devolve os dados do painel (gravados pela coleta no Supabase), só com a senha certa.
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  const senha = process.env.PAINEL_SENHA;
  if (!senha || req.headers['x-senha'] !== senha) {
    res.status(401).json({ erro: 'senha' });
    return;
  }
  try {
    const { rows } = await pool.query("SELECT valor FROM kv WHERE chave = 'painel'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(rows.length ? rows[0].valor : 'null');
  } catch (e) {
    res.status(500).json({ erro: 'banco', detalhe: String(e.message || e) });
  }
}
