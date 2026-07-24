import re

filepath = r"e:\Derivativesproject\nubra-dashboard\src\NubraBacktest.tsx"

with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Add imports
if "PriceTooltip" not in content:
    content = content.replace("import { fmtPrice } from './lib/utils';", "import { fmtPrice } from './lib/utils';\nimport { PriceTooltip, PnlTooltip, GreeksTooltip, PriceTooltipRef, PnlTooltipRef, GreeksTooltipRef } from './components/ChartTooltips';")

# 2. Replace state with refs
state_pattern = re.compile(
    r"  const \[hoverPricePos, setHoverPricePos\].*?\n"
    r"  const \[hoverPriceData, setHoverPriceData\].*?\n\n"
    r"  const \[hoverPnlPos, setHoverPnlPos\].*?\n"
    r"  const \[hoverPnlData, setHoverPnlData\].*?\n\n"
    r"  const \[hoverGreekPos, setHoverGreekPos\].*?\n"
    r"  const \[hoverGreekData, setHoverGreekData\].*?\n",
    re.MULTILINE | re.DOTALL
)

refs_str = """  const priceTooltipRef = useRef<PriceTooltipRef>(null);
  const pnlTooltipRef = useRef<PnlTooltipRef>(null);
  const greeksTooltipRef = useRef<GreeksTooltipRef>(null);
"""
content = state_pattern.sub(refs_str, content)


# 3. Modify updateAllTooltips (Hide on null)
hide_str = """      if (timeVal === null || x === null) {
        priceTooltipRef.current?.setVisibility(false);
        pnlTooltipRef.current?.setVisibility(false);
        greeksTooltipRef.current?.setVisibility(false);
        return null;
      }"""
content = re.sub(
    r"      if \(timeVal === null \|\| x === null\) \{[\s\S]*?return null;\n      \}",
    hide_str,
    content
)

# 4. Modify updateAllTooltips (Set data and pos)
set_data_str = """      const priceMappedLegs = priceLegs.map(l => ({
        name: `${l.side === 'BUY' ? 'B' : 'S'} ${l.strike} ${l.optionType}`,
        color: l.optionType === 'CE' ? '#22c55e' : '#ef4444',
        value: l.value
      }));
      const pnlMappedLegs = pnlLegs.map(l => ({
        name: `${l.side === 'BUY' ? 'B' : 'S'} ${l.strike} ${l.optionType}`,
        color: l.optionType === 'CE' ? '#22c55e' : '#ef4444',
        value: l.value
      }));

      priceTooltipRef.current?.setData(timeStr, spot ? { o: spot, h: spot, l: spot, c: spot } : null, priceMappedLegs, underlying);
      pnlTooltipRef.current?.setData(timeStr, { legs: pnlMappedLegs, total: totalPnl });
      greeksTooltipRef.current?.setData(timeStr, { net: netG, CE: ceG, PE: peG });

      if (priceContainerRef.current && priceTooltipRef.current) {
        priceTooltipRef.current.setPosition(x, activeChartY ?? 40);
        priceTooltipRef.current.setVisibility(true);
      }
      if (pnlContainerRef.current && pnlTooltipRef.current) {
        pnlTooltipRef.current.setPosition(x, activeChartY ?? 40);
        pnlTooltipRef.current.setVisibility(true);
      }
      if (greeksContainerRef.current && greeksTooltipRef.current) {
        greeksTooltipRef.current.setPosition(x, activeChartY ?? 40);
        greeksTooltipRef.current.setVisibility(true);
      }"""

content = re.sub(
    r"      setHoverPriceData\(\{[\s\S]*?setHoverGreekPos\(\{ x, y: activeChartY !== null \? activeChartY : defaultY \}\);",
    set_data_str,
    content
)


# 5. Remove inline HTML for Price
price_html_pattern = re.compile(
    r"                  \{hoverPricePos && hoverPriceData && \([\s\S]*?                  \)\}\n                </div>\n\n                \{\/\* Divider 1: Price \/ PNL \*\/\}",
    re.MULTILINE
)
content = price_html_pattern.sub(
    "                  <PriceTooltip ref={priceTooltipRef} />\n                </div>\n\n                {/* Divider 1: Price / PNL */}",
    content
)

# 6. Remove inline HTML for PNL
pnl_html_pattern = re.compile(
    r"                  \{hoverPnlPos && hoverPnlData && \([\s\S]*?                  \)\}\n                </div>\n\n                \{\/\* Divider 2: PNL \/ Greeks \*\/\}",
    re.MULTILINE
)
content = pnl_html_pattern.sub(
    "                  <PnlTooltip ref={pnlTooltipRef} strategyMargin={0} />\n                </div>\n\n                {/* Divider 2: PNL / Greeks */}",
    content
)

# 7. Remove inline HTML for Greeks
greeks_html_pattern = re.compile(
    r"                  \{hoverGreekPos && hoverGreekData && \(\(\) => \{[\s\S]*?                  \}\)\(\)\}\n                </div>\n              </div>\n\n              \{\/\* Divider 3: Charts \/ Positions \*\/\}",
    re.MULTILINE
)
content = greeks_html_pattern.sub(
    "                  <GreeksTooltip ref={greeksTooltipRef} selectedGreeks={selectedGreeks} greeksLegFilter={greeksLegFilter} colors={{ delta: '#3b82f6', gamma: '#a78bfa', theta: '#22c55e', vega: '#f59e0b' }} />\n                </div>\n              </div>\n\n              {/* Divider 3: Charts / Positions */}",
    content
)

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)
print("NubraBacktest refactored successfully.")
