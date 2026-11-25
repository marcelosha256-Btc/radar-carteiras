import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chanceDe, pTouchC, quantis } from '../web/aovivo/trava.js';

// cópia do cálculo antigo (só 4 h e 24 h), para garantir que a Trava não mudou
function antigo(c) {
  const amp = c.map(x => (x.h - x.l) / x.c), pts = [];
  for (let i = 24; i < c.length; i++) {
    let s = 0; for (let j = i - 24; j < i; j++) s += amp[j];
    const vol = s / 24; if (!(vol > 0)) continue;
    const ex = H => { if (i + H >= c.length) return null; let mx = -Infinity, mn = Infinity; for (let j = i + 1; j <= i + H; j++) { mx = Math.max(mx, c[j].h); mn = Math.min(mn, c[j].l); } return { up: (mx / c[i].c - 1) / vol, dn: (1 - mn / c[i].c) / vol }; };
    pts.push({ e4: ex(4), e24: ex(24) });
  }
  return { '4': { up: quantis(pts.filter(p => p.e4).map(p => p.e4.up)), dn: quantis(pts.filter(p => p.e4).map(p => p.e4.dn)) },
    '24': { up: quantis(pts.filter(p => p.e24).map(p => p.e24.up)), dn: quantis(pts.filter(p => p.e24).map(p => p.e24.dn)) } };
}
let sem = 3; const rnd = () => (sem = (sem * 16807) % 2147483647) / 2147483647;
const velas = (() => { let p = 100; return Array.from({ length: 3000 }, (_, i) => { const o = p; p *= 1 + (rnd() - 0.5) * 0.02; return { t: i * 36e5, c: p, h: Math.max(o, p) * (1 + rnd() * 0.004), l: Math.min(o, p) * (1 - rnd() * 0.004) }; }); })();

test('4 h e 24 h iguais ao cálculo antigo; 7 e 30 dias existem e crescem com o prazo', () => {
  const C = chanceDe(velas), A = antigo(velas);
  assert.deepEqual(C.q['4'], A['4']); assert.deepEqual(C.q['24'], A['24']);
  assert.ok(C.q['168'] && C.q['720']);
  const p = h => pTouchC(C, 105, 100, h);
  assert.ok(p(4) <= p(24) && p(24) <= p(168) && p(168) <= p(720));
});
