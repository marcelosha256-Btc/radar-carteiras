// Devolve os dados do painel (gravados pela coleta no banco), só com a senha certa.
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  max: 1,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  const senha = (process.env.PAINEL_SENHA || '').trim();
  if (!senha || (req.headers['x-senha'] || '').trim() !== senha) {
    res.status(401).json({ erro: 'senha' });
    return;
  }
  try {
    // painel de cripto + ações (grupo xyz), gravados em chaves separadas pela coleta
    const { rows } = await pool.query("SELECT chave, valor FROM kv WHERE chave IN ('painel', 'painel_acoes')");
    const por = Object.fromEntries(rows.map(r => [r.chave, r.valor]));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!por.painel) { res.status(200).send('null'); return; }
    if (!por.painel_acoes) { res.status(200).send(por.painel); return; }
    const dados = JSON.parse(por.painel);
    dados.acoes = JSON.parse(por.painel_acoes);
    res.status(200).send(JSON.stringify(dados));
  } catch (e) {
    res.status(500).json({ erro: 'banco', detalhe: String(e.message || e) });
  }
}
