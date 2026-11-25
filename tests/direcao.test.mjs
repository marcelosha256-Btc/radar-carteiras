import { test } from 'node:test';
import assert from 'node:assert/strict';
import { direcaoTempo, resumoDirecao, contraMaioria } from '../web/aovivo/direcao.js';

// zigue-zague com topos e fundos subindo (passo>0) ou descendo (passo<0)
function zz(n, passo) {
  const out = []; let base = 100;
  for (let i = 0; i < n; i++) { const fase = i % 10, sobe = fase < 5; base += passo; const c = base + (sobe ? fase : 10 - fase) * 0.8;
    out.push({ t: i * 9e5, o: c, h: c + 0.3, l: c - 0.3, c }); }
  return out;
}
test('estrutura subindo e preço acima da média = alta; descendo = baixa', () => {
  const up = zz(120, 0.3), dn = zz(120, -0.3);
  assert.equal(direcaoTempo(up, up[up.length - 1].c + 1), 'alta');
  assert.equal(direcaoTempo(dn, dn[dn.length - 1].c - 1), 'baixa');
});
test('estrutura de alta mas preço abaixo da média = lateral', () => {
  const up = zz(120, 0.3); assert.equal(direcaoTempo(up, up[up.length - 1].c - 50), 'lateral');
});
test('poucas velas = sem leitura', () => { assert.equal(direcaoTempo(zz(10, 1), 100), null); });
test('resumo e plano contra a maioria', () => {
  const R = resumoDirecao([['15m', 'baixa'], ['1H', 'baixa'], ['4H', 'lateral'], ['D', 'baixa']]);
  assert.equal(R.txt, 'baixa em 3 de 4 tempos'); assert.equal(R.lado, 'baixa');
  assert.ok(contraMaioria('compra', R)); assert.ok(!contraMaioria('venda', R));
  assert.equal(resumoDirecao([['15m', 'alta'], ['1H', 'baixa'], ['4H', 'lateral'], ['D', 'lateral']]).txt, 'tempos divergindo');
  assert.equal(resumoDirecao([['15m', null]]).txt, 'carregando…');
  assert.equal(resumoDirecao([['15m', 'alta'], ['1H', 'alta'], ['4H', 'lateral'], ['D', 'lateral']]).txt, 'alta em 2 de 4, resto lateral');
});
