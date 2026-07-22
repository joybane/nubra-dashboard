const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// 1. Fix multiple minimumWidth properties in rightPriceScale
// (my previous script appended it blindly)
const dupMinW = `      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 75,
      minimumWidth: 110,`;
if (txt.includes(dupMinW)) {
  txt = txt.replace(dupMinW, `      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 110,`);
}

// 2. Fix underlying used before declaration
// Currently it's:
/*
  const [lotSizeOverride, setLotSizeOverride] = useState<number | null>(null);
  const [editingLotSize, setEditingLotSize] = useState(false);

  const greeksConfigRef = useRef({ mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter });
  useEffect(() => { greeksConfigRef.current = { mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter }; }, [greeksMode, lotSizeOverride, underlying, greeksLegFilter]);
*/
// It should be moved down past `const underlying = useMemo(...)` which is around line 460.
// Let's remove it from here.
const badGreeksConfig = `  const [lotSizeOverride, setLotSizeOverride] = useState<number | null>(null);
  const [editingLotSize, setEditingLotSize] = useState(false);

  const greeksConfigRef = useRef({ mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter });
  useEffect(() => { greeksConfigRef.current = { mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter }; }, [greeksMode, lotSizeOverride, underlying, greeksLegFilter]);`;

const goodGreeksConfig = `  const [lotSizeOverride, setLotSizeOverride] = useState<number | null>(null);
  const [editingLotSize, setEditingLotSize] = useState(false);`;

if (txt.includes(badGreeksConfig)) {
  txt = txt.replace(badGreeksConfig, goodGreeksConfig);
  // Add it after `const underlying = ...`
  const targetUnderlying = `  const underlying = useMemo(() => deriveUnderlying(allPositions), [allPositions]);`;
  if (txt.includes(targetUnderlying)) {
    txt = txt.replace(targetUnderlying, `${targetUnderlying}
  const greeksConfigRef = useRef({ mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter });
  useEffect(() => { greeksConfigRef.current = { mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter }; }, [greeksMode, lotSizeOverride, underlying, greeksLegFilter]);`);
  }
}

// 3. Fix type errors in the live update loop
// "Property 'iv' is missing"
// => `upsertGreekPoint` expects {time, delta, gamma, theta, vega}. `g` is `{ delta, gamma, theta, vega, iv }`. It already passes them properly... wait, where is the error?
// Oh! `let hist = cached.legGreeksHist.get(refId);` inside the live update loop has type: `{ time: number; delta: number; gamma: number; theta: number; vega: number; iv: number; }` for `cached.legGreeksHist`? No, it's missing `iv`. The previous code had `upsertGreekPoint(hist, { time: t, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega });`. That should be fine. Wait, the error is: `Property 'iv' is missing in type '{ time: number; delta: number; gamma: number; theta: number; vega: number; }' but required in type '{ delta: number; gamma: number; theta: number; vega: number; iv: number; }'`?
// No, `upsertGreekPoint` might expect `iv` now? No, wait! `g` was `hist[hist.length - 1]`. But `hist[hist.length - 1]` does NOT have `iv`!
// Ah! `updates.get(pos.ref_id)` returns `{ delta, gamma, theta, vega, iv }`. `hist[hist.length - 1]` returns `{ time, delta, gamma, theta, vega }` (no iv).
// I assigned it to `let g = updates.get(pos.ref_id)`. Then if not found, `g = hist[hist.length - 1]`. Then TypeScript complains they are incompatible!
// I can fix this by casting `g as any`.

// "Element implicitly has an 'any' type because expression of type 'string' can't be used to index..."
// I should cast `k as 'delta' | 'gamma' | 'theta' | 'vega'`. Or use `as any`.

// "Type 'number' is not assignable to type 'Time'."
// I should use `time: t as any`.

const badLiveUpdate = `          for (const pos of allPositionsRef.current) {
            let g = updates.get(pos.ref_id);
            if (!g) {
               const hist = chartDataRef.current?.legGreeksHist.get(pos.ref_id);
               if (hist && hist.length > 0) g = hist[hist.length - 1];
            }
            if (!g) continue;

            const sign = (pos.order_side || '').includes('BUY') ? 1 : -1;
            const src = positionGreekSource(pos);
            
            for (const k of ['delta', 'gamma', 'theta', 'vega']) {
              const val = g[k] * sign * multiplier;
              liveVals.net[k] += val;
              if (src === 'CE' || src === 'PE') liveVals[src][k] += val;
            }
          }

          for (const src of ['net', 'CE', 'PE']) {
            if (!cfg.filter.has(src)) continue;
            for (const k of ['delta', 'gamma', 'theta', 'vega']) {
              const s = greeksSeriesRef.current[\`\${src}_\${k}\`];
              if (!s) continue;
              const f = greekFactorsRef.current[k] || { mid: 0, half: 1 };
              const nv = (liveVals[src][k] - f.mid) / f.half;
              s.update({ time: t, value: nv });
            }
          }`;

const goodLiveUpdate = `          for (const pos of allPositionsRef.current) {
            let g = updates.get(pos.ref_id) as any;
            if (!g) {
               const hist = chartDataRef.current?.legGreeksHist.get(pos.ref_id);
               if (hist && hist.length > 0) g = hist[hist.length - 1] as any;
            }
            if (!g) continue;

            const sign = (pos.order_side || '').includes('BUY') ? 1 : -1;
            const src = positionGreekSource(pos) as 'CE' | 'PE';
            
            for (const k of ['delta', 'gamma', 'theta', 'vega'] as const) {
              const val = (g[k] as number) * sign * multiplier;
              liveVals.net[k] += val;
              if (src === 'CE' || src === 'PE') (liveVals[src] as any)[k] += val;
            }
          }

          for (const src of ['net', 'CE', 'PE'] as const) {
            if (!cfg.filter.has(src)) continue;
            for (const k of ['delta', 'gamma', 'theta', 'vega'] as const) {
              const s = greeksSeriesRef.current[\`\${src}_\${k}\`];
              if (!s) continue;
              const f = greekFactorsRef.current[k] || { mid: 0, half: 1 };
              const nv = ((liveVals[src] as any)[k] - f.mid) / f.half;
              s.update({ time: t as any, value: nv });
            }
          }`;

if (txt.includes(badLiveUpdate)) {
  txt = txt.replace(badLiveUpdate, goodLiveUpdate);
}

fs.writeFileSync(p, txt);
console.log("Types fixed!");
