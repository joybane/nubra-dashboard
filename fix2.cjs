const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

const t1 = `  const [lotSizeOverride, setLotSizeOverride] = useState<number | null>(null);
  const [editingLotSize, setEditingLotSize] = useState(false);`;

const r1 = `  const [lotSizeOverride, setLotSizeOverride] = useState<number | null>(null);
  const [editingLotSize, setEditingLotSize] = useState(false);

  const greeksConfigRef = useRef({ mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter });
  useEffect(() => { greeksConfigRef.current = { mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter }; }, [greeksMode, lotSizeOverride, underlying, greeksLegFilter]);`;

const t2 = `          setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });
        }
      }
    });`;

const r2 = `          // setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });
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

        setLegGreeks(prev => {
          const next = new Map(prev);
          for (const [k, v] of updates) next.set(k, v);
          return next;
        });
      }
    });`;

if (txt.includes(t1) && txt.includes(t2)) {
    txt = txt.replace(t1, r1).replace(t2, r2);
    fs.writeFileSync(p, txt);
    console.log("Success!");
} else {
    console.log("Not found!", txt.includes(t1), txt.includes(t2));
}
