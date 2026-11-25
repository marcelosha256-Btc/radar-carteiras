/* Faixa de direção: para que lado o preço ESTÁ andando em cada tempo (o que já aconteceu, não previsão).
 * Regra única: topos e fundos subindo (alta pela estrutura) E preço acima da média de 20 fechamentos = alta;
 * topos e fundos descendo E preço abaixo da média = baixa; qualquer mistura = lateral. */
import { estrutura } from '../grafico/calc.js';

export const TEMPOS_DIRECAO = [['15m', '15m'], ['1H', '1h'], ['4H', '4h'], ['D', '1d']];

export function direcaoTempo(velas, cur) {
  if (!velas || velas.length < 30) return null;   // as últimas 110 velas: o Gráfico guarda mais que a Liquidez ao vivo, e a leitura tem de sair igual nas duas
  const v = velas.slice(-110), px = cur || v[v.length - 1].c;
  const fech = v.slice(-20).map(x => x.c), media = fech.reduce((s, x) => s + x, 0) / fech.length;
  const t = estrutura(v).tendencia;
  if (t === 'alta' && px > media) return 'alta';
  if (t === 'baixa' && px < media) return 'baixa';
  return 'lateral';
}

/** lista = [['15m','alta'], ...] → { alta, baixa, lateral, n, lado: 'alta'|'baixa'|null, txt } */
export function resumoDirecao(lista) {
  const ok = lista.filter(([, d]) => d), n = ok.length, c = { alta: 0, baixa: 0, lateral: 0 };
  for (const [, d] of ok) c[d]++;
  let lado = null, txt;
  if (!n) txt = 'carregando…';
  else if (c.alta >= 3) { lado = 'alta'; txt = `alta em ${c.alta} de ${n} tempos`; }
  else if (c.baixa >= 3) { lado = 'baixa'; txt = `baixa em ${c.baixa} de ${n} tempos`; }
  else if (c.alta && c.baixa) txt = 'tempos divergindo';
  else if (c.lateral >= 3) txt = `lateral em ${c.lateral} de ${n} tempos`;
  else txt = c.alta ? `alta em ${c.alta} de ${n}, resto lateral` : c.baixa ? `baixa em ${c.baixa} de ${n}, resto lateral` : 'sem direção clara';
  return { ...c, n, lado, txt };
}

/** o plano (compra/venda) vai contra a maioria? */
export function contraMaioria(lado, R) {
  if (!R || !R.lado) return false;
  return (lado === 'compra' && R.lado === 'baixa') || (lado === 'venda' && R.lado === 'alta');
}
