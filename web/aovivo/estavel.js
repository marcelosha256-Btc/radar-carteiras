/* Nota estável da Trava: a nota oscila perto do limite (70 → 63 → 73 em segundos).
 * LIBERADO só depois de R.confirmaMs seguidos com a nota ≥ R.liberado; uma vez liberado, só sai abaixo de R.liberado − R.folga
 * ou com bloqueio. Queda pequena (dentro da folga) não zera a contagem. Função pura: o estado fica no objeto `mem`. */
export function estavel(mem, chave, sc, bloqueado, agora, R) {
  const E = mem[chave] || (mem[chave] = { desde: null, lib: false });
  if (bloqueado) { E.desde = null; E.lib = false; return { lib: false, espera: 0 }; }
  if (E.lib) { if (sc < R.liberado - R.folga) { E.lib = false; E.desde = null; } else return { lib: true, espera: 0 }; }
  if (sc >= R.liberado) { if (E.desde == null) E.desde = agora; if (agora - E.desde >= R.confirmaMs) { E.lib = true; return { lib: true, espera: 0 }; } }
  else if (sc < R.liberado - R.folga) E.desde = null;
  return { lib: false, espera: E.desde != null ? Math.max(1, R.confirmaMs - (agora - E.desde)) : 0 };
}
