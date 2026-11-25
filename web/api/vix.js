// VIX (índice de volatilidade das ações dos EUA, Cboe) para dar contexto de medo nas telas de ações.
// GET /api/vix → { v, ont, sem, t }  (último valor, fechamento anterior, há ~5 pregões, hora do dado em ms)
// Fonte: gráfico público do Yahoo Finance (^VIX). Não oficial: se falhar, responde 502 e as telas simplesmente não mostram o VIX.
let cache = null;   // por instância, 5 min

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (cache && Date.now() - cache.t < 5 * 60e3) { res.status(200).json(cache.corpo); return; }
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1mo&interval=1d', { headers: { 'User-Agent': 'radar-carteiras' } });
    if (!r.ok) { res.status(502).json({ erro: 'fonte' }); return; }
    const j = await r.json(), x = j.chart && j.chart.result && j.chart.result[0];
    const meta = x && x.meta, cl = ((x && x.indicators && x.indicators.quote[0].close) || []).filter(v => v != null);
    const v = meta && +meta.regularMarketPrice;
    if (!isFinite(v) || !cl.length) { res.status(502).json({ erro: 'formato' }); return; }
    const antes = cl.slice(0, -1);   // fechamentos anteriores ao de hoje (o último ponto é o de hoje, em andamento)
    const corpo = { v, ont: antes.length ? antes[antes.length - 1] : null, sem: antes.length >= 5 ? antes[antes.length - 5] : null, t: (meta.regularMarketTime || 0) * 1000 };
    cache = { t: Date.now(), corpo };
    res.status(200).json(corpo);
  } catch (e) { res.status(502).json({ erro: 'fonte' }); }
}
