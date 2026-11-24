/* Cartão "Regras do dia" no topo da tela Hoje + checklist da calculadora.
 * Junta o resultado de hoje (execuções reais da corretora e operações em papel do Meu diário), compara com as suas regras e
 * avisa "pare por hoje". A calculadora lê window.radarRisco.checklist(calc) e bloqueia o plano quando alguma regra falha. */
import { REGRAS_PADRAO, travaDoDia, checklist, pregaoNY } from './regras.js';
import { mapaDe, checarMapa } from './zonas.js';
window.radarPregao = pregaoNY;
import { carteira, operacoes, conta } from './dados.js';

const ALVOS = ['riscoCripto', 'riscoAcoes'];
const CAMPOS = [['perdaDiaPct', 'Perda máxima no dia (% do capital)'], ['perdasSeguidas', 'Parar depois de N perdas seguidas'], ['opsDia', 'Máximo de operações por dia'],
  ['janelaIni', 'Janela de entradas: início (h)'], ['janelaFim', 'Janela de entradas: fim (h)'], ['rrMin', 'R:R líquido mínimo'],
  ['noticiaMin', 'Minutos sem entrar após notícia forte'], ['heatMax', 'Risco total aberto máximo (%)']];
const num = (v, d = 2) => (+v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const ler = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const senha = () => { try { return localStorage.getItem('radar-senha') || ''; } catch (e) { return ''; } };
export const regras = () => ({ ...REGRAS_PADRAO, ...ler('radar-regras', {}) });

const S = { trava: null, real: [], papel: null, conta: null, erro: '', aberto: false };

async function carregarPapel() {
  if (!senha()) return;
  try { const r = await fetch('api/trades', { headers: { 'x-senha': senha() } }); if (r.ok) S.papel = (await r.json()).trades; } catch (e) {}
}
async function atualizar() {
  try {
    const [ops, ct] = await Promise.all([operacoes(), conta()]);
    S.real = ops; S.conta = ct; S.erro = '';
  } catch (e) { S.erro = 'Não consegui ler as suas execuções agora.'; }
  calcular();
}
function calcular() {
  const calc = ler('radar-hoje-calc', {}), riscoPct = parseFloat(String(calc.risco || '0.5').replace(',', '.')) || 0.5;
  // base do dia: o saldo real da carteira; enquanto ela não tiver pelo menos 10% do capital da calculadora (conta ainda sem depósito), usa o capital da calculadora
  const capCalc = parseFloat(String(calc.cap || '1000').replace(',', '.')) || 1000;
  const capital = S.conta && S.conta.saldo >= capCalc * 0.1 ? S.conta.saldo : capCalc;
  S.baseCalc = !(S.conta && S.conta.saldo >= capCalc * 0.1);
  S.trava = travaDoDia({ real: S.real, papel: (S.papel || []).filter(t => t.tipo === 'papel'), capital, aberto: S.conta ? S.conta.aberto : 0, riscoPct, regras: regras() });
  desenhar();
  window.dispatchEvent(new Event('radar-risco'));
}

/* usado pela calculadora (script clássico da página) */
window.radarRisco = {
  get trava() { return S.trava; },
  checklist(calc) {
    const plano = ler('radar-hoje-plano', []), heat = plano.reduce((s, p) => s + (+p.risco || 0), 0);
    let eventos = [];
    try { if (typeof hojeEventos === 'function' && typeof DADOS_HOJE !== 'undefined' && DADOS_HOJE) eventos = hojeEventos(DADOS_HOJE); } catch (e) {}
    const A = calc && calc.A, coin = A ? (A.mercado === 'acoes' ? A.id : A.t) : null, R = regras();
    const d = coin ? mapaDe(coin, () => window.dispatchEvent(new Event('radar-risco'))) : null;   // mapa chega depois: redesenha
    let ref = null; try { if (typeof hojeVivo === 'function' && A) ref = hojeVivo(A); } catch (e) {}
    const extras = calc && d ? checarMapa({ lado: calc.lado, e: calc.e, s: calc.s, d, ref, rrMin: R.rrMin }) : [];
    return checklist({ calc, trava: S.trava, eventos, heatAberto: heat, regras: R, mercado: A && A.mercado === 'acoes' ? 'acoes' : 'cripto', extras });
  },
};

function desenhar() {
  const R = regras(), t = S.trava, user = carteira();
  for (const id of ALVOS) {
    const el = document.getElementById(id);
    if (!el || !t) continue;
    const real = !user ? '<span class="muted">conecte a carteira em "Minhas posições"</span>'
      : `<b class="${t.pctReal < 0 ? 'neg' : t.pctReal > 0 ? 'pos' : ''}">${t.pctReal > 0 ? '+' : ''}${num(t.pctReal)}%</b> <span class="muted">(US$ ${num(t.realizado + t.aberto)}${t.aberto ? ', com o aberto' : ''})</span>`;
    const papel = `<b class="${t.rPapel < 0 ? 'neg' : t.rPapel > 0 ? 'pos' : ''}">${t.rPapel > 0 ? '+' : ''}${num(t.rPapel)}R</b>`;
    const chip = t.parar ? `<span class="chip down" style="font-weight:700">PARE POR HOJE</span>` : `<span class="chip up">liberado</span>`;
    el.innerHTML = `<div class="box" ${t.parar ? 'style="border-color:var(--down)"' : ''}><div class="box-head"><h2>Regras do dia</h2>
        <span class="small">${chip} <button class="hj-link" data-act="rg-ajustar">${S.aberto ? 'fechar' : 'ajustar regras'}</button></span></div>
      ${t.parar ? `<p class="chip down" style="white-space:normal;border-radius:8px">${t.motivos.join(' · ')}. Feche a plataforma: o dia acabou. Revise no Meu diário.</p>` : ''}
      <div class="small" style="display:flex;flex-wrap:wrap;gap:6px 18px">
        <span>Real hoje: ${real}</span><span>Papel hoje: ${papel}</span>
        <span>Operações: <b>${t.ops}/${R.opsDia}</b></span><span>Perdas seguidas: <b>${Math.max(t.perdasReal, t.perdasPapel)}/${R.perdasSeguidas}</b></span>
        <span class="muted">limite ${R.perdaDiaPct}% · entradas: cripto ${R.janelaIni}h–${R.janelaFim}h, ações até ${String(R.acoesJanelaH ?? 2.5).replace('.', ',')} h após a abertura de NY${S.baseCalc ? ' · base: capital da calculadora' : ''}</span></div>
      ${S.erro ? `<p class="small muted">${S.erro}</p>` : ''}
      ${S.aberto ? `<div class="hj-form" style="margin-top:10px">${CAMPOS.map(([k, n]) => `<label>${n}<input data-rg="${k}" inputmode="decimal" value="${R[k]}"></label>`).join('')}</div>
        <p class="small muted">As regras valem para o real e para o papel. O dia começa às 00h de Brasília.</p>` : ''}</div>`;
  }
}

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act="rg-ajustar"]');
  if (!el) return;
  S.aberto = !S.aberto; desenhar();
});
document.addEventListener('change', ev => {
  const el = ev.target.closest('[data-rg]');
  if (!el) return;
  const v = parseFloat(el.value.replace(',', '.'));
  if (!(v >= 0)) return;
  const r = ler('radar-regras', {}); r[el.dataset.rg] = v;
  try { localStorage.setItem('radar-regras', JSON.stringify(r)); } catch (e) {}
  calcular();
});
window.addEventListener('radar-diario', ev => { if (ev.detail) { S.papel = ev.detail; calcular(); } });   // o Meu diário mudou
window.addEventListener('storage', ev => { if (ev.key === 'radar-carteira') { operacoes(true); atualizar(); } });

calcular();
carregarPapel().then(atualizar);
setInterval(() => { if (!document.hidden && document.querySelector('#p-hoje:not([hidden]), #p-a-hoje:not([hidden])')) atualizar(); }, 60000);
