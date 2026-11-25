import fs from 'node:fs';
for (const s of ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','NEARUSDT']) {
  if (fs.existsSync(s + '.json')) continue;
  let fim = Date.now(), out = [];
  for (let i = 0; i < 48; i++) {   // ~2 anos de velas de 15 min
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=15m&limit=1500&endTime=${fim}`).then(r => r.json());
    if (!r.length) break; out = r.concat(out); fim = r[0][0] - 1; await new Promise(z => setTimeout(z, 150));
  }
  fs.writeFileSync(s + '.json', JSON.stringify(out.map(x => [x[0], +x[2], +x[3], +x[4], +x[7], +x[10]])));
  console.log(s, out.length);
}
