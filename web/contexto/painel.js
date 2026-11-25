/* Medidores de medo (cripto e VIX) no topo da tela Hoje, acima do plano. */
import { medo, medidorMedo } from './medo.js';
import { vix, medidorVix } from './vix.js';
import { medidor } from './medidor.js';

const el = document.getElementById('medosHoje');
if (el) {
  const S = { m: null, v: null };
  const desenhar = () => {
    const cards = [S.v ? medidor(medidorVix(S.v)) : '', S.m ? medidor(medidorMedo(S.m)) : ''].join('');
    el.innerHTML = cards ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:10px">${cards}</div>` : '';
  };
  const carregar = () => { medo().then(m => { if (m) { S.m = m; desenhar(); } }); vix().then(v => { if (v) { S.v = v; desenhar(); } }); };
  carregar(); setInterval(() => { if (!document.hidden) carregar(); }, 900e3);
}
