// Aba "Liquidez ao vivo": dados da Coinversa (pagos, chave só aqui no servidor) + detalhes públicos da Hyperliquid.
// GET /api/liquidez?q=mapa|liqs|press&coin=BTC   (header x-senha = PAINEL_SENHA)
// A resposta vai para o cache da Vercel (s-maxage), então o consumo da Coinversa não cresce com o número de visitas.
const CV = 'https://api.coinversa.ai/api/public/v1';
const HL = 'https://api.hyperliquid.xyz/info';
const TAKER = 0.00045;                         // taxa usada para estimar o tamanho de uma liquidação pela taxa paga
const ok = c => /^(xyz:)?[A-Z0-9]{2,12}$/.test(c);
const faixa = c => (c === 'xyz:SP500' || c === 'xyz:XYZ100') ? { R: 10, nb: 20 } : c.startsWith('xyz:') ? { R: 15, nb: 20 } : { R: 15, nb: 30 };

export async function cv(p) {
  const r = await fetch(CV + p, { headers: { 'X-API-Key': (process.env.COINVERSA_API_KEY || '').trim() } });
  if (!r.ok) throw new Error('Coinversa ' + r.status);
  return r.json();
}
export async function hl(body) {
  const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Hyperliquid ' + r.status);
  return r.json();
}

// mapa de liquidações: L = faixas abaixo do preço (longs), S = acima (shorts), em US$ milhões
// largo = ±50% em faixas de 2% (para o Gráfico de 4H e Diário enxergar a liquidez longe do preço)
export async function mapa(coin, largo = false) {
  const { R, nb } = largo ? { R: 50, nb: 50 } : faixa(coin);
  const j = await cv(`/live/liquidation-heatmap/${encodeURIComponent(coin)}?buckets=${nb}&range=${R}`);
  const b = j.buckets, h = nb / 2, m = v => +(v / 1e6).toFixed(4);
  return { coin, ts: Date.now(), p: j.currentPrice, R, nb,
    L: b.slice(0, h).map(x => m(x.longNotionalAtRisk)), S: b.slice(h).map(x => m(x.shortNotionalAtRisk)),
    LP: b.slice(0, h).map(x => x.longPositions), SP: b.slice(h).map(x => x.shortPositions) };
}

// liquidações reais da última hora: eventos da Coinversa (sem preço/lado) + até 4 maiores detalhados na Hyperliquid
async function liqs(coin) {
  const [j, s] = await Promise.all([
    cv(`/live/risk/liquidations/recent?since=1h&limit=200&coin=${encodeURIComponent(coin)}`),
    cv(`/live/risk/liquidations/summary?since=1h&coin=${encodeURIComponent(coin)}`).catch(() => null),
  ]);
  const fills = (j.events || []).length, g = new Map();
  for (const e of j.events || []) {
    const k = e.address + '|' + e.timestampMs;
    const o = g.get(k) || { t: e.timestampMs, addr: e.address, fee: 0, n: 0 };
    o.fee += e.penaltyFee || 0; o.n++; g.set(k, o);
  }
  const groups = [...g.values()];
  const det = new Map();
  for (const o of [...groups].sort((a, b) => b.fee - a.fee).slice(0, 4)) {
    try {
      const f = (await hl({ type: 'userFillsByTime', user: o.addr, startTime: o.t - 1000, endTime: o.t + 1000 }))
        .filter(x => x.coin === coin && x.liquidation && Math.abs(x.time - o.t) < 1500);
      if (f.length) { let usd = 0, sz = 0; for (const x of f) { usd += +x.px * +x.sz; sz += +x.sz; }
        det.set(o, { px: usd / sz, usd, side: /Long/.test(f[0].dir) ? 'long' : 'short' }); }
    } catch (e) { break; }
  }
  const events = groups.map(o => { const d = det.get(o);
    return { t: o.t, usd: d ? d.usd : o.fee / TAKER, px: d ? d.px : null, side: d ? d.side : null, exact: !!d, n: o.n }; })
    .sort((a, b) => b.t - a.t);
  return { coin, events, truncated: fills >= 200, oldest: events.length ? events[events.length - 1].t : null,
    sum1h: s ? { long: s.longNotional || 0, short: s.shortNotional || 0, nl: s.longEvents || 0, ns: s.shortEvents || 0 } : null };
}

// quem está apertado: funding/OI oficiais (Hyperliquid) + histórico de OI, PnL aberto e grupos (Coinversa)
export async function press(coin) {
  const dex = coin.startsWith('xyz:') ? 'xyz' : null;
  const [ctx, fh, oih, ls, cb] = await Promise.all([
    hl(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }).then(([m, a]) => a[m.universe.findIndex(u => u.name === coin)] || null).catch(() => null),
    hl({ type: 'fundingHistory', coin, startTime: Date.now() - 864e5 }).catch(() => []),
    cv(`/live/oi-history/${encodeURIComponent(coin)}?hours=25`).catch(() => null),
    cv(`/live/coins/${encodeURIComponent(coin)}/long-short`).catch(() => null),
    cv(`/live/cohort-bias/${encodeURIComponent(coin)}`).catch(() => null),
  ]);
  const hst = oih && oih.history ? oih.history.map(x => ({ t: x.timestamp, oi: x.openInterest, px: x.markPx })) : [];
  const at = h => { const t = Date.now() - h * 3600e3; let v = null; for (const x of hst) { if (x.t <= t) v = x; else break; } return v; };
  const last = hst[hst.length - 1];
  const chg = h => { const a = at(h); return a && last ? { oi: last.oi / a.oi - 1, px: last.px / a.px - 1 } : null; };
  return { coin, ts: Date.now(),
    funding: ctx ? +ctx.funding : null, funding24: fh && fh.length ? fh.reduce((t, x) => t + +x.fundingRate, 0) / fh.length : null,
    oiUsd: ctx ? +ctx.openInterest * +ctx.markPx : null,
    oiChg: { h1: chg(1), h4: chg(4), h24: chg(24) },
    ls: ls ? { longAcc: ls.longAccounts, shortAcc: ls.shortAccounts, longPnl: ls.longUnrealizedPnl ?? null, shortPnl: ls.shortUnrealizedPnl ?? null,
      levL: ls.avgLongLeverage ?? null, levS: ls.avgShortLeverage ?? null } : null,
    cohorts: Array.isArray(cb) ? cb.map(x => ({ tier: x.pnlTier, L: x.longNotional, S: x.shortNotional, bias: x.netBiasByNotional })) : [] };
}

const CACHE_S = { mapa: 120, mapal: 300, liqs: 30, press: 120 };
export default async function handler(req, res) {
  const senha = (process.env.PAINEL_SENHA || '').trim();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!senha || (req.headers['x-senha'] || '').trim() !== senha) { res.setHeader('Cache-Control', 'no-store'); res.status(401).json({ erro: 'senha' }); return; }
  if (!(process.env.COINVERSA_API_KEY || '').trim()) { res.setHeader('Cache-Control', 'no-store'); res.status(503).json({ erro: 'sem chave da Coinversa (COINVERSA_API_KEY)' }); return; }
  const q = String(req.query.q || ''), coin = String(req.query.coin || '');
  if (!CACHE_S[q] || !ok(coin)) { res.setHeader('Cache-Control', 'no-store'); res.status(400).json({ erro: 'parâmetros' }); return; }
  try {
    const dados = q === 'mapa' ? await mapa(coin) : q === 'mapal' ? await mapa(coin, true) : q === 'liqs' ? await liqs(coin) : await press(coin);
    res.setHeader('Cache-Control', `public, s-maxage=${CACHE_S[q]}, stale-while-revalidate=${CACHE_S[q]}`);
    res.setHeader('Vary', 'x-senha');
    res.status(200).json(dados);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ erro: String(e.message || e) });
  }
}
