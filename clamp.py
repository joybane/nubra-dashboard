import re

filepath = r"e:\Derivativesproject\nubra-dashboard\src\NubraBacktest.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# Replace priceTooltipRef setPosition
content = re.sub(
    r"      if \(priceContainerRef.current && priceTooltipRef.current\) \{\n        priceTooltipRef.current.setPosition\(x, activeChartY \?\? 40\);\n        priceTooltipRef.current.setVisibility\(true\);\n      \}",
    """      if (priceContainerRef.current && priceTooltipRef.current) {
        const w = priceContainerRef.current.clientWidth || 800;
        const h = priceContainerRef.current.clientHeight || 400;
        priceTooltipRef.current.setPosition(x > w * 0.5 ? x - 230 : x + 20, activeChartType === 'price' ? Math.max(8, Math.min((activeChartY ?? 40) - 80, h - 140)) : 8);
        priceTooltipRef.current.setVisibility(true);
      }""",
    content
)

# Replace pnlTooltipRef setPosition
content = re.sub(
    r"      if \(pnlContainerRef.current && pnlTooltipRef.current\) \{\n        pnlTooltipRef.current.setPosition\(x, activeChartY \?\? 40\);\n        pnlTooltipRef.current.setVisibility\(true\);\n      \}",
    """      if (pnlContainerRef.current && pnlTooltipRef.current) {
        const w = pnlContainerRef.current.clientWidth || 800;
        const h = pnlContainerRef.current.clientHeight || 400;
        pnlTooltipRef.current.setPosition(x > w * 0.5 ? x - 230 : x + 20, activeChartType === 'pnl' ? Math.max(8, Math.min((activeChartY ?? 40) - 80, h - 140)) : 8);
        pnlTooltipRef.current.setVisibility(true);
      }""",
    content
)

# Replace greeksTooltipRef setPosition
content = re.sub(
    r"      if \(greeksContainerRef.current && greeksTooltipRef.current\) \{\n        greeksTooltipRef.current.setPosition\(x, activeChartY \?\? 40\);\n        greeksTooltipRef.current.setVisibility\(true\);\n      \}",
    """      if (greeksContainerRef.current && greeksTooltipRef.current) {
        const w = greeksContainerRef.current.clientWidth || 800;
        const h = greeksContainerRef.current.clientHeight || 400;
        greeksTooltipRef.current.setPosition(x > w * 0.5 ? x - 230 : x + 20, activeChartType === 'greeks' ? Math.max(8, Math.min((activeChartY ?? 40) - 80, h - 140)) : 8);
        greeksTooltipRef.current.setVisibility(true);
      }""",
    content
)

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)
print("Updated setPosition clamping successfully.")
