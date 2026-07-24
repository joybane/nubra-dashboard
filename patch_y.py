import re

filepath = r"e:\Derivativesproject\nubra-dashboard\src\components\StrategyAnalysisView.tsx"
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace the syncingCrosshair extraction block
pattern1 = r"(const t = param\.time as number;\s*const xPos = param\.point\.x;\s*const tStr = fmtChartTime\(t\);)"
repl1 = r"\1\n            const yPos = param.point.y;"
content = re.sub(pattern1, repl1, content)

# Replace priceTooltipRef setPosition
pattern2 = r"(const w = priceChartContainerRef\.current\?\.clientWidth \?\? 800;\s*)priceTooltipRef\.current\.setPosition\(xPos > w \* 0\.6 \? xPos - 230 : xPos \+ 20, 20\);"
repl2 = r"\1const h = priceChartContainerRef.current?.clientHeight ?? 400;\n                priceTooltipRef.current.setPosition(xPos > w * 0.6 ? xPos - 230 : xPos + 20, sourceChart === pc ? Math.max(20, Math.min(yPos - 30, h - 140)) : 20);"
content = re.sub(pattern2, repl2, content)

# Replace pnlTooltipRef setPosition
pattern3 = r"(const w = pnlChartContainerRef\.current\?\.clientWidth \?\? 800;\s*)pnlTooltipRef\.current\.setPosition\(xPos > w \* 0\.6 \? xPos - 230 : xPos \+ 20, 8\);"
repl3 = r"\1const h = pnlChartContainerRef.current?.clientHeight ?? 400;\n                pnlTooltipRef.current.setPosition(xPos > w * 0.6 ? xPos - 230 : xPos + 20, sourceChart === nc ? Math.max(8, Math.min(yPos - 30, h - 140)) : 8);"
content = re.sub(pattern3, repl3, content)

# Replace greeksTooltipRef setPosition
pattern4 = r"(const w = greeksChartContainerRef\.current\?\.clientWidth \?\? 800;\s*)greeksTooltipRef\.current\.setPosition\(xPos > w \* 0\.6 \? xPos - 210 : xPos \+ 20, 8\);"
repl4 = r"\1const h = greeksChartContainerRef.current?.clientHeight ?? 400;\n                greeksTooltipRef.current.setPosition(xPos > w * 0.6 ? xPos - 210 : xPos + 20, sourceChart === gc ? Math.max(8, Math.min(yPos - 30, h - 140)) : 8);"
content = re.sub(pattern4, repl4, content)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print("Patched StrategyAnalysisView.tsx with proper Y position syncing.")
