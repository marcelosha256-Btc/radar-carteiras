/* Trava em três camadas (como nos sistemas profissionais: sinal só com vela fechada, plano com números fixos, gatilho separado):
 *  1. SETUP: a nota é calculada uma vez por vela de 15 min, logo após o fechamento, e fica fixa até o próximo.
 *     Nota ≥ liberado → plano ARMADO com entrada-limite, stop e alvo congelados até o próximo fechamento.
 *  2. GATILHO (ao vivo): com o plano armado, LIBERADO só quando o preço está na zona de entrada (R:R ≥ mínimo até o alvo)
 *     e o fluxo curto confirma (último minuto ou livro a favor). O gatilho não mexe na nota.
 *  3. RISCO (ao vivo): cascata de liquidações etc. bloqueiam na hora; preço além do stop ou já no alvo desarma o plano.
 * Funções puras, testadas em tests/gatilho.test.mjs. */
export const VELA_MS = 9e5;
export const velaDe = (t, ms = VELA_MS) => Math.floor(t / ms);
export const proximoFechamento = (t, ms = VELA_MS) => (velaDe(t, ms) + 1) * ms;

/** preço-limite de entrada para ainda ter R:R mínimo até o alvo */
export const entradaLimite = (stop, alvo, rrMin) => (alvo + rrMin * stop) / (1 + rrMin);

/** Estado do gatilho de um plano armado. lado: 'compra' | 'venda'. dir: último minuto (+1 sobe, −1 cai, 0 parado).
 *  livro: desequilíbrio do livro perto do preço (−1..1, positivo = mais compra), ou null. */
export function gatilho({ lado, cur, stop, alvo, rrMin = 2, dir = 0, livro = null }) {
  const compra = lado === 'compra', s = compra ? 1 : -1;
  const eLim = entradaLimite(stop, alvo, rrMin);
  if (compra ? cur <= stop : cur >= stop) return { estado: 'stop', eLim };
  if (compra ? cur >= alvo : cur <= alvo) return { estado: 'alvo', eLim };
  const naZona = compra ? cur <= eLim : cur >= eLim;
  const porMinuto = dir === s, porLivro = livro != null && livro * s > 0.3;
  const rrAgora = Math.abs(alvo - cur) / Math.abs(cur - stop);
  if (!naZona) return { estado: 'fora', eLim, rrAgora, distPct: (eLim / cur - 1) * 100 };
  if (!porMinuto && !porLivro) return { estado: 'espera', eLim, rrAgora };
  return { estado: 'ok', eLim, rrAgora, motivo: porMinuto ? 'último minuto a favor' : 'livro a favor' };
}
