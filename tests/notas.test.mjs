import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveNotas, tokenNotas, tokenValido, variacao15 } from '../web/api/notas.js';
import handler from '../web/api/notas.js';
import { setupNota, zones, montarMapa, chanceDe } from '../web/aovivo/trava.js';

const URLBANCO = 'postgresql://radar:npg_SEGREDOx1@ep-x-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require';

test('chave = senha do banco, com ou sem pooler e com sobras coladas', () => {
  assert.equal(chaveNotas(URLBANCO), 'npg_SEGREDOx1');
  assert.equal(chaveNotas('DATABASE_URL="' + URLBANCO.replace('-pooler', '') + '"\nOUTRA=1'), 'npg_SEGREDOx1');
  assert.equal(chaveNotas(''), '');
});
test('token vale no minuto atual e nos 2 anteriores, não em outro', () => {
  const agora = Date.UTC(2026, 10, 25, 19, 0, 30), m = Math.floor(agora / 60000);
  assert.ok(tokenValido('k', tokenNotas('k', m), agora));
  assert.ok(tokenValido('k', tokenNotas('k', m - 2), agora));
  assert.ok(!tokenValido('k', tokenNotas('k', m - 5), agora));
  assert.ok(!tokenValido('outra', tokenNotas('k', m), agora));
  assert.ok(!tokenValido('', tokenNotas('', m), agora));
  assert.ok(!tokenValido('k', 'abc', agora));
});
test('token igual ao do Python (mesma conta HMAC)', () => {
  // valor fixo calculado com: hmac.new(b"npg_SEGREDOx1", b"notas:29926000", hashlib.sha256).hexdigest()
  assert.equal(tokenNotas('npg_SEGREDOx1', 29926000), 'bea0f4f0770647eeea53da5786c37ca03016984fa6566939db56e8f9238954d7');
});
test('variação de 15 min pelas velas de 1 min', () => {
  const agora = 1_000_000_000_000, c1m = Array.from({ length: 25 }, (_, i) => ({ t: agora - (25 - i) * 60e3, c: 100 + i }));
  // vela que fechou até agora-15min: t + 60s <= agora - 900s → i = 9 (t = agora-16min) → c = 109
  assert.ok(Math.abs(variacao15(c1m, 109 * 1.01, agora) - 1) < 1e-9);
  assert.equal(variacao15([], 100, agora), 0);
});

/* ---------- servidor de ponta a ponta com a rede simulada ---------- */
function velasSint(n, ms, fim, base, passo) {
  return Array.from({ length: n }, (_, i) => { const c = base + Math.sin(i / 5) * passo + i * passo * 0.01;
    return { t: fim - (n - i) * ms, o: String(c - passo / 4), c: String(c), h: String(c + passo / 2), l: String(c - passo / 2), v: '1' }; });
}
function redeFalsa(agora) {
  const p = 60000;
  return async (url, opt = {}) => {
    const ok = j => ({ ok: true, status: 200, json: async () => j });
    if (String(url).startsWith('https://api.hyperliquid.xyz')) {
      const b = JSON.parse(opt.body);
      if (b.type === 'allMids') return ok({ BTC: String(p) });
      if (b.type === 'candleSnapshot') { const ms = { '1m': 6e4, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5, '1w': 6048e5 }[b.req.interval];
        const n = Math.min(5000, Math.round((b.req.endTime - b.req.startTime) / ms)); return ok(velasSint(n, ms, agora, p, p * 0.004)); }
      if (b.type === 'metaAndAssetCtxs') return ok([{ universe: [{ name: 'BTC' }] }, [{ funding: '0.0000125', openInterest: '1000', markPx: String(p) }]]);
      if (b.type === 'fundingHistory') return ok([{ fundingRate: '0.0000125' }]);
    }
    const u = String(url);
    if (u.includes('liquidation-heatmap')) return ok({ currentPrice: p, buckets: Array.from({ length: 30 }, (_, i) => ({
      longNotionalAtRisk: i === 11 ? 5e7 : 1e6, shortNotionalAtRisk: i === 17 ? 4e7 : 1e6, longPositions: 10, shortPositions: 10 })) });
    if (u.includes('oi-history')) return ok({ history: [] });
    if (u.includes('long-short')) return ok({ longAccounts: 100, shortAccounts: 100, longUnrealizedPnl: 1, shortUnrealizedPnl: 1 });
    if (u.includes('cohort-bias')) return ok([]);
    if (u.includes('liquidations/summary')) return ok({ longNotional: 0, shortNotional: 0 });
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
function resFalsa() { const r = { code: 0, body: null, headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = c => { r.code = c; return r; }; r.json = j => { r.body = j; return r; }; return r; }

test('api/notas: sem token → 401; com token → 4 notas (day/swing × compra/venda) da vela', async () => {
  const fetch0 = globalThis.fetch, env0 = { ...process.env }, agora = Date.now();
  globalThis.fetch = redeFalsa(agora);
  process.env.DATABASE_URL = URLBANCO; process.env.COINVERSA_API_KEY = 'x';
  try {
    let res = resFalsa(); await handler({ query: { coin: 'BTC' }, headers: {} }, res); assert.equal(res.code, 401);
    res = resFalsa(); await handler({ query: { coin: 'DOGE' }, headers: { 'x-token': tokenNotas('npg_SEGREDOx1', Math.floor(Date.now() / 60000)) } }, res); assert.equal(res.code, 400);
    res = resFalsa(); await handler({ query: { coin: 'BTC' }, headers: { 'x-token': tokenNotas('npg_SEGREDOx1', Math.floor(Date.now() / 60000)) } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    const N = res.body.notas;
    assert.equal(N.length, 4);
    assert.deepEqual(N.map(n => n.modo + '/' + n.lado).sort(), ['day/compra', 'day/venda', 'swing/compra', 'swing/venda']);
    for (const n of N) { assert.equal(n.t % 9e5, 0); assert.equal(n.moeda, 'BTC'); assert.ok(n.nota >= 0 && n.nota <= 100); assert.ok(n.stop > 0 && n.alvo > 0); JSON.parse(n.itens); }
    const v = N.find(n => n.modo === 'day' && n.lado === 'venda'); assert.ok(v.stop > 60000 && v.alvo < 60000);
  } finally { globalThis.fetch = fetch0; process.env = env0; }
});

test('setupNota: a nota é a mesma com as mesmas entradas (página = servidor)', () => {
  const agora = Date.UTC(2026, 10, 25, 19), m = montarMapa({ p: 100, R: 15, nb: 30,
    L: Array.from({ length: 15 }, (_, i) => i === 11 ? 50 : 1), S: Array.from({ length: 15 }, (_, i) => i === 2 ? 40 : 1) });
  const v = (n, ms) => velasSint(n, ms, agora, 100, 0.4).map(x => ({ t: x.t, o: +x.o, c: +x.c, h: +x.h, l: +x.l }));
  const ent = { k: 'BTC', cur: 100, zn: zones(m, 100), c15: 0.4, cand: { '15m': v(110, 9e5), '4h': v(110, 144e5), '1d': v(110, 864e5), '1w': v(110, 6048e5) },
    chance: chanceDe(v(2000, 36e5), agora), press: null, sum1h: null, modo: 'day', lado: 'venda', agora };
  const a = setupNota(ent), b = setupNota(JSON.parse(JSON.stringify(ent)));
  assert.equal(a.sc, b.sc); assert.deepEqual(a.pros, b.pros); assert.equal(a.stop, b.stop);
  assert.ok(a.stop > 100 && a.alvo < 100);
});
