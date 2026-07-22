const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// Fix 1: Minimum width and left scale visibility
const oldChartOpts = `    leftPriceScale: {
      visible: false,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
    },
    rightPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
    },`;

const newChartOpts = `    leftPriceScale: {
      visible: showLeftScale,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 110,
    },
    rightPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 110,
    },`;

// Fix 2: greeksConfigRef
const oldLotSize = `  const [lotSizeOverride, setLotSizeOverride] = useState<number | null>(null);
  const [editingLotSize, setEditingLotSize] = useState(false);`;

const newLotSize = `  const [lotSizeOverride, setLotSizeOverride] = useState<number | null>(null);
  const [editingLotSize, setEditingLotSize] = useState(false);

  const greeksConfigRef = useRef({ mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter });
  useEffect(() => { greeksConfigRef.current = { mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter }; }, [greeksMode, lotSizeOverride, underlying, greeksLegFilter]);`;

// Fix 3: Live updates in option_chain listener
const oldLiveUpdate = `          for (const [refId, g] of updates) {
            let hist = cached.legGreeksHist.get(refId);
            if (!hist) { hist = []; cached.legGreeksHist.set(refId, hist); }
            upsertGreekPoint(hist, { time: t, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega });
          }
          // setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });
        }
        setLegGreeks(prev => {`;

const newLiveUpdate = `          for (const [refId, g] of updates) {
            let hist = cached.legGreeksHist.get(refId);
            if (!hist) { hist = []; cached.legGreeksHist.set(refId, hist); }
            upsertGreekPoint(hist, { time: t, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega });
          }
          // setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });
        }

        // ---- LIVE UPDATE GREEKS CHART ENGINE DIRECTLY ----
        try {
          const cfg = greeksConfigRef.current;
          const activeLotSize = cfg.lotSize ?? (cfg.underlying ? DEFAULT_LOT_SIZES[cfg.underlying] ?? 65 : 65);
          const multiplier = cfg.mode === 'lot' ? activeLotSize : 1;
          
          const liveVals = {
            net: { delta: 0, gamma: 0, theta: 0, vega: 0 },
            CE: { delta: 0, gamma: 0, theta: 0, vega: 0 },
            PE: { delta: 0, gamma: 0, theta: 0, vega: 0 },
          };

          for (const pos of allPositionsRef.current) {
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
          }
        } catch (e) { console.error('[Greeks Live Update]', e); }
        // --------------------------------------------------

        setLegGreeks(prev => {`;

const missing = [];
if (!txt.includes(oldChartOpts)) missing.push("ChartOpts");
if (!txt.includes(oldLotSize)) missing.push("LotSize");
if (!txt.includes(oldLiveUpdate)) missing.push("LiveUpdate");

if (missing.length === 0) {
  txt = txt.replace(oldChartOpts, newChartOpts);
  txt = txt.replace(oldLotSize, newLotSize);
  txt = txt.replace(oldLiveUpdate, newLiveUpdate);
  fs.writeFileSync(p, txt);
  console.log("All fixes applied successfully!");
} else {
  console.log("Could not find targets:", missing.join(", "));
}
