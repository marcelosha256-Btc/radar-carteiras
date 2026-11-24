/* Zonas do mapa de liquidações para a calculadora: o mesmo critério da "Trava do seu roteiro" (aba Liquidez ao vivo),
 * só que medido a partir da SUA entrada planejada. Uma fonte de verdade: stop além da zona do lado do stop, alvo na zona
 * do outro lado, e R:R mínimo entre os dois. Funções puras testadas em tests/risco.test.mjs; a busca usa /api/liquidez. */

const STOP_BUF = 0.0015;   // stop 0,15% além da zona (igual à Trava)

/** converte o formato da /api/liquidez (faixas em volta do preço) em [preço, US$], igual ao build() da Liquidez ao vivo */
export function construir(d) {
  if (!d || !(d.p > 0) || !(d.R > 0) || !(d.nb > 0) || !Array.isArray(d.L) || !Array.isArray(d.S)) return null;
  const lo = d.p * (1 - d.R / 100), w = d.p * 2 * d.R / 100 / d.nb, h = d.nb / 2;
  return { bw: w, L: d.L.map((v, i) => [lo + (i + 0.5) * w, v * 1e6]), S: d.S.map((v, i) => [lo + (h + i + 0.5) * w, v * 1e6]) };
}

/** d = { bw, L: [[preço, US$], ...] liquidações de comprados, S: [[preço, US$], ...] de vendidos }; ref = preço de referência */
export function zonasMapa(d, ref) {
  if (!d || !(d.bw > 0) || !Array.isArray(d.L) || !Array.isArray(d.S)) return null;
  const bw = d.bw, mL = Math.max(1, ...d.L.map(a => +a[1])), mS = Math.max(1, ...d.S.map(a => +a[1]));
  const ap = d.L.filter(a => +a[0] + bw / 2 < ref).sort((x, y) => y[0] - x[0]).find(a => +a[1] >= 0.35 * mL);
  const ve = d.S.filter(a => +a[0] - bw / 2 > ref).sort((x, y) => x[0] - y[0]).find(a => +a[1] >= 0.35 * mS);
  const z = a => a ? { lo: +a[0] - bw / 2, hi: +a[0] + bw / 2, usd: +a[1] } : null;
  return { comprados: z(ap), vendidos: z(ve) };   // comprados = zona abaixo (apoio); vendidos = zona acima
}

/** itens do checklist a partir das zonas. lado 'compra'|'venda', e = entrada, s = stop */
export function checarMapa({ lado, e, s, d, rrMin = 2 }) {
  const Z = zonasMapa(d, e);
  if (!Z) return [];
  const compra = lado === 'compra', it = [];
  const zStop = compra ? Z.comprados : Z.vendidos, zAlvo = compra ? Z.vendidos : Z.comprados;
  const fx = v => (+v).toLocaleString('pt-BR', { maximumFractionDigits: v >= 1000 ? 0 : 2 });
  if (zStop && zAlvo) {
    const stopZ = compra ? zStop.lo * (1 - STOP_BUF) : zStop.hi * (1 + STOP_BUF);
    const alvoZ = compra ? zAlvo.lo : zAlvo.hi;
    const rr = Math.abs(alvoZ - e) / Math.abs(e - stopZ);
    if (rr < rrMin) {
      const eMin = (alvoZ + rrMin * stopZ) / (1 + rrMin);
      it.push(['bloqueia', `Pelo mapa de liquidações, da entrada até a zona do outro lado (${fx(zAlvo.lo)}–${fx(zAlvo.hi)}) o R:R é ${rr.toFixed(1).replace('.', ',')}: só vale ${compra ? 'comprando em' : 'vendendo em'} ${fx(eMin)} ou ${compra ? 'abaixo' : 'acima'} (a mesma Trava da Liquidez ao vivo).`]);
    } else it.push(['ok', `Mapa de liquidações: R:R ${rr.toFixed(1).replace('.', ',')} até a zona do outro lado (${fx(zAlvo.lo)}–${fx(zAlvo.hi)}).`]);
  }
  if (zStop && s > 0) {
    const antes = compra ? s >= zStop.lo && s < e : s <= zStop.hi && s > e;   // stop antes ou dentro da zona: o preço costuma ir buscá-la
    if (antes) it.push(['aviso', `Seu stop (${fx(s)}) fica antes ou dentro da zona de liquidação ${compra ? 'dos comprados' : 'dos vendidos'} (${fx(zStop.lo)}–${fx(zStop.hi)}): o preço costuma ir buscar essas zonas. Stop do mapa: ${fx(compra ? zStop.lo * (1 - STOP_BUF) : zStop.hi * (1 + STOP_BUF))}.`]);
  }
  return it;
}

/* ---------------------------------------------------------------- busca (navegador) ---- */
const cache = {};   // coin -> { t, d | null, p }
const senha = () => { try { return localStorage.getItem('radar-senha') || ''; } catch (e) { return ''; } };
/** devolve o mapa já carregado (ou null) e, se faltar ou estiver velho, busca em segundo plano e chama aoChegar */
export function mapaDe(coin, aoChegar) {
  if (!coin || !senha()) return null;
  const c = cache[coin];
  if (!c || (Date.now() - c.t > 5 * 60000 && !c.p)) {
    const p = fetch(`api/liquidez?q=mapa&coin=${encodeURIComponent(coin)}`, { headers: { 'x-senha': senha() } })
      .then(r => r.ok ? r.json() : null).then(construir).catch(() => null)
      .then(d => { cache[coin] = { t: Date.now(), d, p: null }; if (aoChegar) aoChegar(); });
    cache[coin] = { t: c ? c.t : 0, d: c ? c.d : null, p };
  }
  return cache[coin].d;
}
