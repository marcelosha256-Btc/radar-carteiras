// Radar da manhã: janela da noite (22h→8h de Brasília) e métricas, com candles sintéticos.  Rodar: node --test tests/manha.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.document = { getElementById: () => null, hidden: true, querySelector: () => null };
globalThis.setInterval = () => 0; globalThis.setTimeout = () => 0;
const { janelaNoite, resumo, atrPct } = await import('../web/manha/tela.js');
const H = 36e5, D = 24 * H;
const perto = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `esperado ${b}, veio ${a}`);

test('janela da noite: 8h de Brasília = 11h UTC; antes das 8h usa a noite anterior', () => {
  const dia = 20000 * D;                       // um dia qualquer, 00:00 UTC
  const depois = janelaNoite(dia + 14 * H);    // 11h BRT
  assert.equal(depois.fim, dia + 11 * H); assert.equal(depois.ini, dia + H);   // 22h BRT = 01h UTC
  const antes = janelaNoite(dia + 9 * H);      // 06h BRT: a noite de hoje ainda não acabou
  assert.equal(antes.fim, dia - D + 11 * H);
});

test('resumo: noite +5%, desde as 8h +2%, volume da noite 2× o normal', () => {
  const dia = 20000 * D, agora = dia + 14 * H + 10 * 60000;   // 11h10 BRT
  const V = [];
  for (let t = dia - 9 * D; t <= dia + 14 * H; t += H) {
    const k = Math.floor((t - (dia + H)) / D);                  // dia relativo à noite de hoje
    const dentroNoite = ((t - H) % D + D) % D < 10 * H;         // 01h..11h UTC
    let o = 100, c = 100;
    if (t === dia + H) o = 100;                                 // abre a noite
    if (t >= dia + 11 * H) { o = 105; c = 105; }                // depois das 8h o preço está em 105
    if (t === dia + 14 * H) { o = 105; c = 107.1; }             // último candle fecha 2% acima das 8h
    V.push({ t, o, c, v: dentroNoite && t >= dia + H && t < dia + 11 * H ? 2000 : 1000 });
  }
  const r = resumo(V, agora);
  perto(r.noite, 5); perto(r.desde8, 2);
  perto(r.rvolNoite, 2);                                        // 10 velas de 2000 contra 10 velas de 1000 nos dias anteriores
  assert.equal(resumo(V.filter(x => x.t > dia + H), agora), null);  // sem o início da noite não há resumo
});

test('amplitude diária normal: média de (máx−mín)/fechamento dos últimos 14 dias, sem o dia em formação', () => {
  const D = Array.from({ length: 20 }, () => ({ h: 102, l: 98, c: 100 }));   // 4% por dia
  D.push({ h: 150, l: 50, c: 100 });                                          // dia em formação não conta
  perto(atrPct(D), 4);
  assert.equal(atrPct(D.slice(0, 5)), null);                                  // histórico curto demais
});
