// Testes do motor de backtest com operações calculadas à mão.  Rodar: node --test tests/backtest.test.mjs
// Quantidades são arredondadas para baixo em 0,0001: 10.000/101 = 99,0099 (não 99,00990099…), por isso alguns
// valores "redondos" aparecem com tolerância de centavos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mms, mme, ifr, atr, calcularIndicador, criarAvaliador, rodarBacktest, metricas, monteCarlo, permutacao, HORA } from '../web/backtest/motor.js';

const perto = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} esperado ${b}, veio ${a}`);
const vela = (i, o, h, l, c, v = 1, ms = HORA) => ({ t: i * ms, o, h, l, c, v });
const SEM_CUSTO = { taker: 0, maker: 0, derrapagem: 0, funding: false };
const Q = 99.0099;   // 10.000 / 101 arredondado para 0,0001

// candles base: cruza acima de 100 no candle 1 (fecha 101)
const base = () => [vela(0, 99, 100, 98, 99), vela(1, 99, 101.5, 99, 101)];
const cruza100 = { modo: 'E', condicoes: [{ ind: { nome: 'preco', campo: 'fechamento' }, op: 'cruza_acima', valor: 100 }] };
const estr = (extra = {}) => ({ lado: 'compra', entrada: cruza100, gatilho: { tipo: 'fechamento' },
  saida: { stop: { tipo: 'percentual', valor: 5 }, alvo: { tipo: 'risco', valor: 2 } },
  posicao: { alavancagem: 1, tamanho: { tipo: 'caixa', valor: 100 } }, ...extra });
const rodar = (E, V, opc = {}) => rodarBacktest(E, V, { ativo: 'BTC', intervalo: '1h', capital: 10_000, custos: SEM_CUSTO, ...opc });

/* ================= indicadores ================= */
test('médias, IFR, ATR, máxima de N (sem o candle atual) e VWAP', () => {
  assert.deepEqual(mms([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(mme([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const r = ifr([10, 11, 10, 11], 2);
  perto(r[2], 50); perto(r[3], 75);
  const V = [0, 1, 2, 3].map(i => vela(i, 10, 11, 9, 10));
  perto(atr(V, 3)[2], 2); perto(atr(V, 3)[3], 2);
  const M = calcularIndicador({ nome: 'Maxima', periodo: 2 }, [vela(0, 1, 5, 1, 1), vela(1, 1, 7, 1, 1), vela(2, 1, 6, 1, 1), vela(3, 1, 9, 1, 1)]);
  assert.deepEqual(M, [null, null, 7, 7]);
  perto(calcularIndicador({ nome: 'VWAP' }, [vela(0, 10, 10, 10, 10, 1), vela(1, 20, 20, 20, 20, 3)])[1], 17.5);
  assert.deepEqual(calcularIndicador({ nome: 'MMA', periodo: 3 }, [1, 2, 3, 4].map(x => vela(0, x, x, x, x))), [null, null, 2, 3]);
});

test('estocástico lento, Williams %R, CCI, OBV, volume médio, Donchian, Keltner, FVG', () => {
  // máxima 12, mínima 8 em todos; fechamentos 9, 10, 11, 12 → %K rápido 25, 50, 75, 100
  const V = [9, 10, 11, 12].map((c, i) => vela(i, c, 12, 8, c, 10 + i));
  const k = calcularIndicador({ nome: 'Estocastico', periodo: 1, suavizacao: 2, d: 2, linha: 'k' }, V);
  assert.deepEqual(k, [null, 37.5, 62.5, 87.5]);
  assert.deepEqual(calcularIndicador({ nome: 'Estocastico', periodo: 1, suavizacao: 2, d: 2, linha: 'd' }, V), [null, null, 50, 75]);
  assert.deepEqual(calcularIndicador({ nome: 'WilliamsR', periodo: 1 }, V), [-75, -50, -25, -0]);
  const C = calcularIndicador({ nome: 'CCI', periodo: 2 }, [vela(0, 1, 1, 1, 1), vela(1, 3, 3, 3, 3)]);
  perto(C[1], (3 - 2) / (0.015 * 1));                                           // típico 3, média 2, desvio médio 1
  assert.deepEqual(calcularIndicador({ nome: 'OBV' }, [vela(0, 1, 1, 1, 10, 5), vela(1, 1, 1, 1, 11, 3), vela(2, 1, 1, 1, 9, 2), vela(3, 1, 1, 1, 9, 4)]), [0, 3, 1, 1]);
  assert.deepEqual(calcularIndicador({ nome: 'VolumeMedio', periodo: 2 }, V), [null, 10.5, 11.5, 12.5]);
  const D = [vela(0, 1, 5, 1, 1), vela(1, 1, 7, 2, 1), vela(2, 1, 6, 0, 1)];
  assert.deepEqual(calcularIndicador({ nome: 'Donchian', periodo: 2, linha: 'superior' }, D), [null, null, 7]);
  assert.deepEqual(calcularIndicador({ nome: 'Donchian', periodo: 2, linha: 'inferior' }, D), [null, null, 1]);
  const K = [0, 1, 2].map(i => vela(i, 10, 11, 9, 10));
  perto(calcularIndicador({ nome: 'Keltner', periodo: 2, atr: 2, multiplicador: 2, linha: 'superior' }, K)[2], 10 + 2 * 2);
  assert.deepEqual(calcularIndicador({ nome: 'FVG', linha: 'alta' }, [vela(0, 1, 2, 1, 2), vela(1, 2, 4, 2, 4), vela(2, 4, 5, 3, 5)]), [null, null, 1]);
});

test('ADX e Supertrend numa alta firme: DI+ > DI−, ADX alto, Supertrend comprado', () => {
  const V = Array.from({ length: 60 }, (_, i) => vela(i, 100 + i, 101.5 + i, 99.5 + i, 101 + i));
  const dip = calcularIndicador({ nome: 'ADX', linha: 'di_mais' }, V), dim = calcularIndicador({ nome: 'ADX', linha: 'di_menos' }, V);
  const a = calcularIndicador({ nome: 'ADX' }, V);
  assert.ok(dip[59] > dim[59]); assert.ok(a[59] > 50);
  assert.equal(calcularIndicador({ nome: 'Supertrend', linha: 'tendencia' }, V)[59], 1);
  assert.equal(calcularIndicador({ nome: 'HiLo', linha: 'tendencia' }, V)[59], 1);
  perto(calcularIndicador({ nome: 'Bollinger', linha: '%b' }, V)[59], 0.5 + 9.5 / (4 * Math.sqrt((20 * 20 - 1) / 12)), 1e-9);
});

test('sequência: passo 2 depois do passo 1, dentro da janela', () => {
  const seq = { modo: 'SEQUENCIA', janela: 3, condicoes: [
    { ind: { nome: 'preco' }, op: '<', valor: 100 }, { ind: { nome: 'preco' }, op: '>', valor: 102 }] };
  const serie = closes => () => closes;
  const ok = criarAvaliador(seq, serie([99, 101, 103]));
  assert.deepEqual([0, 1, 2].map(ok), [false, false, true]);
  const tarde = criarAvaliador(seq, serie([99, 101, 101, 101, 103]));
  assert.deepEqual([0, 1, 2, 3, 4].map(tarde), [false, false, false, false, false]);
});

/* ================= execução ================= */
test('padrão: sinal no fechamento, entrada na ABERTURA do candle seguinte', () => {
  const E = estr(); delete E.gatilho;
  const t = rodar(E, [...base(), vela(2, 101.2, 102, 100, 101.5)]).trades[0];
  perto(t.entrada, 101.2); assert.equal(t.i_entrada, 2); assert.equal(t.t_entrada, 2 * HORA);
});

test('alvo de 2R sem custos', () => {
  const V = [...base(), vela(2, 101, 105, 100, 104), vela(3, 104, 112, 103, 110)];
  const r = rodar(estr(), V);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  perto(t.entrada, 101); perto(t.stop, 95.95); perto(t.alvo, 111.1); assert.equal(t.motivo, 'alvo 1');
  perto(t.qtd, Q); perto(t.pnl, Q * 10.1, 1e-9); perto(t.r, 2, 1e-9);
});

test('alvo com custos: taker na entrada, maker no alvo, derrapagem só na entrada', () => {
  const V = [...base(), vela(2, 101, 105, 100, 104), vela(3, 104, 112, 103, 110)];
  const t = rodar(estr(), V, { custos: { taker: 0.1, maker: 0.05, derrapagem: 0.1, funding: false } }).trades[0];
  const ent = 101.101, q = Math.floor(10_000 / ent * 1e4) / 1e4;             // 98,9109
  perto(t.entrada, ent); perto(t.qtd, q);
  const esperado = q * ent * 0.1 - q * ent * 0.001 - q * ent * 1.1 * 0.0005;   // bruto − taxa entrada − taxa alvo
  perto(t.pnl, esperado, 1e-6); perto(t.pnl, 984.5, 0.02);
});

test('stop e alvo no mesmo candle: sem candles menores, vale o stop', () => {
  const V = [...base(), vela(2, 101, 105, 100, 104), vela(3, 104, 112, 95, 100)];
  const r = rodar(estr(), V);
  assert.equal(r.trades[0].motivo, 'stop'); perto(r.trades[0].pnl, -Q * 5.05, 1e-9);
  assert.deepEqual(r.empates, { total: 1, refino: 0, stop_assumido: 1 });
});

test('refino: candles de 15 min decidem quem veio primeiro', () => {
  const V = [...base(), vela(2, 101, 105, 100, 104), vela(3, 104, 112, 95, 100)];
  const sub = (lista) => lista.map(([o, h, l, c], k) => ({ t: 3 * HORA + k * 900_000, o, h, l, c, v: 1 }));
  // alvo (111,1) no 2º quarto de hora, stop (95,95) só no 4º
  const r1 = rodar(estr(), V, { refino: [{ intervalo: '15m', velas: sub([[104, 106, 103, 105], [105, 112, 104, 110], [110, 110, 100, 101], [101, 101, 95, 100]]) }] });
  assert.equal(r1.trades[0].motivo, 'alvo 1'); assert.deepEqual(r1.empates, { total: 1, refino: 1, stop_assumido: 0 });
  // stop primeiro
  const r2 = rodar(estr(), V, { refino: [{ intervalo: '15m', velas: sub([[104, 105, 95, 96], [96, 112, 96, 110], [110, 110, 100, 101], [101, 101, 100, 100]]) }] });
  assert.equal(r2.trades[0].motivo, 'stop');
  // os dois no mesmo quarto de hora: stop
  const r3 = rodar(estr(), V, { refino: [{ intervalo: '15m', velas: sub([[104, 112, 95, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]) }] });
  assert.equal(r3.trades[0].motivo, 'stop');
});

test('abertura além do stop: sai na abertura', () => {
  const t = rodar(estr(), [...base(), vela(2, 90, 91, 89, 90)]).trades[0];
  assert.equal(t.motivo, 'stop'); perto(t.saida, 90); perto(t.pnl, Q * (90 - 101), 1e-9);
});

test('rompimento: executa na máxima do candle sinal (ou na abertura, se abrir acima); cancela se não romper', () => {
  const E = estr({ gatilho: { tipo: 'rompimento', validade: 1 } });
  assert.equal(rodar(E, [...base(), vela(2, 101, 101.4, 100, 101), vela(3, 101, 120, 100, 101)]).trades.length, 0);
  perto(rodar(E, [...base(), vela(2, 101, 103, 100, 102)]).trades[0].entrada, 101.5);
  perto(rodar(E, [...base(), vela(2, 102, 103, 101, 102)]).trades[0].entrada, 102);
  assert.equal(rodar(E, [...base(), vela(2, 101, 130, 96, 120)]).trades[0].motivo, 'stop');   // no candle da execução, só o stop vale
});

test('liquidação: perde a margem; stop mais perto que a liquidação sai no stop', () => {
  const E = estr({ posicao: { alavancagem: 10, tamanho: { tipo: 'caixa', valor: 10 } }, saida: {} });
  const t = rodar(E, [...base(), vela(2, 100, 100, 90, 91)]).trades[0];
  assert.equal(t.motivo, 'liquidação'); perto(t.liq, 101 * 0.9 / 0.9875, 1e-9); perto(t.pnl, -Q * 101 / 10, 1e-9);
  const E2 = estr({ posicao: { alavancagem: 10, tamanho: { tipo: 'caixa', valor: 10 } }, saida: { stop: { tipo: 'percentual', valor: 10 } } });
  assert.equal(rodar(E2, [...base(), vela(2, 100, 100, 90, 91)]).trades[0].motivo, 'liquidação');
  const E3 = estr({ posicao: { alavancagem: 10, tamanho: { tipo: 'caixa', valor: 10 } }, saida: { stop: { tipo: 'percentual', valor: 5 } } });
  const t3 = rodar(E3, [...base(), vela(2, 100, 100, 90, 91)]).trades[0];
  assert.equal(t3.motivo, 'stop'); perto(t3.pnl, -Q * 5.05, 1e-9);
  assert.throws(() => rodar(estr({ posicao: { alavancagem: 50 } }), base()), /máximo/);
});

test('funding de hora em hora sobre o valor da posição; vendido recebe', () => {
  const V = [...base(), vela(2, 101, 102, 100, 101), vela(3, 101, 102, 100, 101)];
  const F = [1, 2, 3, 4].map(h => ({ t: h * HORA, r: 0.0001 }));
  const opc = { funding: F, custos: { ...SEM_CUSTO, funding: true } };
  const t = rodar(estr({ saida: {} }), V, opc).trades[0];
  perto(t.funding, 2 * 0.0001 * Q * 101, 1e-9); perto(t.pnl, -t.funding, 1e-9);
  const tv = rodar({ ...estr({ saida: {} }), lado: 'venda' }, V, opc).trades[0];
  perto(tv.funding, -2 * 0.0001 * Q * 101, 1e-9);
});

/* ================= stops e saídas ================= */
test('break-even por R e por %: volta para a entrada e sai no zero a zero', () => {
  const V = [...base(), vela(2, 101, 107, 100, 105), vela(3, 105, 105, 100, 101)];
  const r = rodar(estr({ saida: { stop: { tipo: 'percentual', valor: 5 }, break_even: { gatilho_r: 1 } } }), V).trades[0];
  assert.equal(r.motivo, 'break-even'); perto(r.saida, 101); perto(r.pnl, 0, 1e-9);
  const p = rodar(estr({ saida: { stop: { tipo: 'percentual', valor: 5 }, break_even: { gatilho_pct: 5 } } }), V).trades[0];
  assert.equal(p.motivo, 'break-even');                                         // máxima 107 ≥ 101 × 1,05
});

test('trailing de 5%: o stop sobe com a máxima e vale no candle seguinte', () => {
  const V = [...base(), vela(2, 101, 110, 101, 109), vela(3, 109, 109, 104, 105)];
  const t = rodar(estr({ saida: { stop: { tipo: 'trailing', valor: 5 } } }), V).trades[0];
  assert.equal(t.motivo, 'trailing'); perto(t.saida, 110 * 0.95); perto(t.pnl, Q * (104.5 - 101), 1e-9);
});

test('saídas parciais: metade em 1R com break-even, metade em 2R; o resto sai no zero a zero', () => {
  const E = estr({ saida: { stop: { tipo: 'percentual', valor: 5 }, alvos: [
    { fracao: 50, tipo: 'risco', valor: 1, depois: 'break_even' }, { fracao: 50, tipo: 'risco', valor: 2 }] } });
  const V = [...base(), vela(2, 101, 106.5, 100, 106), vela(3, 106, 106, 100, 101)];
  const t = rodar(E, V).trades[0];
  assert.equal(t.parciais, 1); assert.equal(t.motivo, 'break-even');
  const q1 = Math.floor(Q * 0.5 * 1e4) / 1e4;                                   // 49,5049
  perto(t.pnl, q1 * 5.05, 1e-9);                                                // 1R na metade, zero no resto
  assert.throws(() => rodar(estr({ saida: { alvos: Array.from({ length: 6 }, () => ({ fracao: 10, tipo: 'percentual', valor: 1 })) } }), V), /no máximo 5/);
});

test('tempo máximo e primeiro fechamento no lucro', () => {
  const V = [...base(), vela(2, 101, 102, 100, 100.5), vela(3, 100.5, 102, 100, 101.5), vela(4, 101, 103, 100, 102)];
  const t = rodar(estr({ saida: { tempo_max: 2 } }), V).trades[0];
  assert.equal(t.motivo, 'tempo'); perto(t.saida, 101.5); assert.equal(t.candles, 2);
  const p = rodar(estr({ saida: { primeiro_lucro: true } }), V).trades[0];
  assert.equal(p.motivo, 'primeiro lucro'); perto(p.pnl, Q * 0.5, 1e-9);
});

/* ================= tamanho da posição ================= */
test('tamanho: % de risco, risco em valor fixo, % da caixa, valor fixo; frações de 0,0001', () => {
  const V = [vela(0, 99, 99.4, 98, 99), vela(1, 99, 100.5, 99, 100), vela(2, 100, 101, 99, 100)];
  const E = tam => estr({ entrada: { condicoes: [{ ind: { nome: 'preco' }, op: 'cruza_acima', valor: 99.5 }] },
                          posicao: { alavancagem: 2, tamanho: tam }, saida: { stop: { tipo: 'percentual', valor: 5 } } });
  perto(rodar(E({ tipo: 'risco', valor: 1 }), V).trades[0].qtd, 20);          // 100 de risco / 5 por unidade
  perto(rodar(E({ tipo: 'risco_valor', valor: 50 }), V).trades[0].qtd, 10);
  perto(rodar(E({ tipo: 'caixa', valor: 30 }), V).trades[0].qtd, 60);         // margem 3.000 × 2x / 100
  perto(rodar(E({ tipo: 'valor', valor: 1234.56789 }), V).trades[0].qtd, 12.3456);   // arredonda para baixo
});

/* ================= filtros ================= */
test('filtros de horário (UTC) e dia da semana', () => {
  const sinais = Array.from({ length: 30 }, (_, i) => vela(i, 100, 101, 99, i % 2 ? 101 : 99));   // cruza acima a cada 2 candles
  const E = f => ({ ...estr({ saida: { tempo_max: 1 } }), gatilho: { tipo: 'abertura' }, filtros: f });
  const horas = rodar(E({ horas_utc: [10, 14] }), sinais).trades;
  assert.ok(horas.length > 0 && horas.every(t => t.hora >= 10 && t.hora < 14));
  const virada = rodar(E({ horas_utc: [22, 2] }), sinais).trades;                // janela que passa da meia-noite
  assert.ok(virada.every(t => t.hora >= 22 || t.hora < 2));
  assert.equal(rodar(E({ dias: [3] }), sinais).trades.length, 0);                // 01/01/1970 foi quinta: sem quarta-feira aqui
});

test('filtro no tempo gráfico maior usa só o candle JÁ FECHADO', () => {
  // candles de 1h; filtro: o candle de 4h fechou acima de 100
  const V = [], VM = [];
  for (let i = 0; i < 12; i++) V.push(vela(i, 100, 101, 99, i % 2 ? 101 : 99));
  // 4h: o candle 0–4h fechou em 99 (não passa); o 4–8h, em formação até 8h, fecharia em 105
  VM.push({ t: 0, o: 100, h: 101, l: 98, c: 99, v: 1 }, { t: 4 * HORA, o: 99, h: 106, l: 99, c: 105, v: 1 }, { t: 8 * HORA, o: 105, h: 106, l: 104, c: 105, v: 1 });
  const E = { ...estr({ saida: { tempo_max: 1 } }), gatilho: { tipo: 'abertura' },
              filtros: { maior: { intervalo: '4h', modo: 'E', condicoes: [{ ind: { nome: 'preco' }, op: '>', valor: 100 }] } } };
  const t = rodar(E, V, { maior: { intervalo: '4h', velas: VM } }).trades;
  // decisões às 5h e 7h olham o 4h de 0–4h (99): bloqueadas; a partir das 9h, o de 4–8h já fechou (105): liberadas
  assert.ok(t.length > 0 && t.every(x => x.t_entrada >= 8 * HORA), JSON.stringify(t.map(x => x.t_entrada / HORA)));
});

test('sem olhar o futuro: cortar os dados não muda nenhum valor nem operação do passado', () => {
  let p = 100, s = 3;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const V = Array.from({ length: 600 }, (_, i) => {
    const o = p, c = p * (1 + (rnd() - 0.5) * 0.03), h = Math.max(o, c) * (1 + rnd() * 0.01), l = Math.min(o, c) * (1 - rnd() * 0.01);
    p = c; return vela(i, o, h, l, c, 1 + rnd() * 10);
  });
  const specs = [{ nome: 'MMA', periodo: 20 }, { nome: 'MME', periodo: 20 }, { nome: 'IFR', periodo: 14 }, { nome: 'ATR', periodo: 14 },
    { nome: 'Bollinger', linha: 'inferior' }, { nome: 'Bollinger', linha: '%b' }, { nome: 'MACD', linha: 'histograma' }, { nome: 'Estocastico', linha: 'd' },
    { nome: 'ADX' }, { nome: 'ADX', linha: 'di_menos' }, { nome: 'Supertrend' }, { nome: 'Donchian', linha: 'superior' }, { nome: 'Keltner', linha: 'inferior' },
    { nome: 'HiLo', linha: 'tendencia' }, { nome: 'WilliamsR' }, { nome: 'CCI' }, { nome: 'OBV' }, { nome: 'VolumeMedio' },
    { nome: 'Maxima', periodo: 20 }, { nome: 'Minima', periodo: 20 }, { nome: 'VWAP' }, { nome: 'FVG', linha: 'baixa' }];
  for (const sp of specs) {
    const cheio = calcularIndicador(sp, V), cortado = calcularIndicador(sp, V.slice(0, 400));
    cortado.forEach((v, i) => assert.equal(v, cheio[i], `${sp.nome} ${sp.linha || ''} mudou no candle ${i}`));
  }
  const E = { lado: 'compra',
    entrada: { modo: 'E', condicoes: [{ ind: { nome: 'MME', periodo: 9 }, op: 'cruza_acima', valor: { ind: { nome: 'MME', periodo: 21 } } }] },
    saida: { stop: { tipo: 'atr', valor: 2, periodo: 14 }, alvos: [{ fracao: 50, tipo: 'risco', valor: 1, depois: 'break_even' }, { fracao: 50, tipo: 'risco', valor: 3 }], tempo_max: 30 },
    filtros: { maior: { intervalo: '4h', condicoes: [{ ind: { nome: 'preco' }, op: '>', valor: { ind: { nome: 'MME', periodo: 10 } } }] } },
    posicao: { alavancagem: 3, tamanho: { tipo: 'risco', valor: 1 } } };
  const opc = { custos: { taker: 0.045, maker: 0.015, derrapagem: 0.02, funding: false } };
  const cheio = rodar(E, V, opc).trades, curto = rodar(E, V.slice(0, 400), opc).trades;
  const fechadas = curto.filter(t => t.motivo !== 'fim dos dados');
  assert.ok(fechadas.length >= 3, 'poucas operações para o teste');
  fechadas.forEach((t, k) => { perto(t.pnl, cheio[k].pnl, 1e-9); assert.equal(t.t_entrada, cheio[k].t_entrada); });
});

/* ================= Trap no 1-2-3 (setup do Stormer) ================= */
// 1-2-3 nos candles 0-1-2 (fundo 9), trap no 4 (perde 9), trap mais fundo no 5; o 1-2-3 do candle 6 é ignorado
const trapV = () => [
  vela(0, 10.5, 11, 10, 10.5), vela(1, 10, 10, 9, 9.5), vela(2, 9.6, 10.5, 9.5, 10.2), vela(3, 10.1, 10.2, 9.2, 9.4),
  vela(4, 9.3, 9.8, 8.8, 9.0), vela(5, 9.0, 9.5, 8.5, 9.2), vela(6, 8.9, 9.7, 8.7, 9.6), vela(7, 9.6, 10.5, 9.5, 10.4)];

test('Trap123 marca o candle que perde o fundo do 1-2-3 (e o trap mais fundo); MinimoN', () => {
  assert.deepEqual(calcularIndicador({ nome: 'Trap123', janela: 10, validade: 3 }, trapV()), [null, null, 0, 0, 1, 1, 0, 0]);
  assert.deepEqual(calcularIndicador({ nome: 'Trap123', janela: 1, validade: 3 }, trapV()), [null, null, 0, 0, 0, 0, 0, 0]);   // passou do prazo
  const m = calcularIndicador({ nome: 'MinimoN', periodo: 2, de: { nome: 'preco', campo: 'minima' } }, trapV());
  assert.deepEqual(m.slice(0, 4), [null, 9, 9, 9.2]);
});

test('rompimento com "renovar": a ordem acompanha o trap mais fundo', () => {
  const E = renovar => ({ lado: 'compra', entrada: { condicoes: [{ ind: { nome: 'Trap123' }, op: '>', valor: 0.5 }] },
    gatilho: { tipo: 'rompimento', validade: 3, renovar }, saida: { stop: { tipo: 'minima_sinal' } },
    posicao: { alavancagem: 1, tamanho: { tipo: 'caixa', valor: 100 } } });
  const a = rodar(E(true), trapV()).trades[0];
  perto(a.entrada, 9.5); perto(a.stop, 8.5); assert.equal(a.i_entrada, 6);     // máxima do candle 5, no candle 6
  const b = rodar(E(false), trapV()).trades[0];
  perto(b.entrada, 9.8); perto(b.stop, 8.8); assert.equal(b.i_entrada, 7);     // fica na máxima do candle 4
});

test('candle do rompimento: conservador = stop se a mínima tocou; otimista = mínima veio antes, stop só pelo fechamento', () => {
  const E = estr({ gatilho: { tipo: 'rompimento', validade: 1 } });
  const V = [...base(), vela(2, 101, 130, 96, 120)];                          // entra em 101,5; stop 96,425; alvo 111,65
  assert.equal(rodar(E, V).trades[0].motivo, 'stop');
  assert.equal(rodar(E, V, { intrabar: 'otimista' }).trades[0].motivo, 'alvo 1');
  const fecha = rodar(E, [...base(), vela(2, 101, 103, 95, 95.5)], { intrabar: 'otimista' }).trades[0];
  assert.equal(fecha.motivo, 'stop'); perto(fecha.saida, 101.5 * 0.95);       // fechou abaixo do stop: o stop pegou
});

/* ================= métricas e estatística ================= */
test('maior queda e retorno', () => {
  const m = metricas({ trades: [], curva: [120, 90, 130].map((eq, i) => ({ t: (i + 1) * 86_400_000, eq })),
    capital0: 100, final: 130, taxas: 0, funding: 0, inicio: 0, fim: 3 * 86_400_000 });
  perto(m.maior_queda, 0.25); perto(m.retorno, 0.3); perto(m.maior_queda_usd, 30);
});

test('Monte Carlo: só perdas de 1% caem mais de 50% em 100 operações; só ganhos nunca caem', () => {
  const a = monteCarlo(Array.from({ length: 120 }, () => ({ ret: -0.01 })), { rodadas: 500 });
  assert.equal(a.queda20, 1); assert.equal(a.queda50, 1);
  const b = monteCarlo(Array.from({ length: 50 }, () => ({ ret: 0.01 })), { rodadas: 500 });
  assert.equal(b.queda20, 0); assert.ok(b.com_repeticao);
});

test('permutação: grupos muito diferentes dão p pequeno; grupos iguais dão p = 1', () => {
  const dif = [...Array.from({ length: 20 }, (_, i) => ({ ret: 0.05 + i * 1e-4, hora: 0 })),
               ...Array.from({ length: 20 }, (_, i) => ({ ret: -0.05 - i * 1e-4, hora: 1 }))];
  assert.ok(permutacao(dif, 'hora', { rodadas: 500 }).p < 0.01);
  const iguais = Array.from({ length: 40 }, (_, i) => ({ ret: i % 2 ? 0.01 : -0.01, hora: i < 20 ? 0 : 1 }));
  perto(permutacao(iguais, 'hora', { rodadas: 500 }).p, 1, 1e-9);
});
