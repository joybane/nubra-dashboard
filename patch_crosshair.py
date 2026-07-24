import re

filepath = r"e:\Derivativesproject\nubra-dashboard\src\components\StrategyAnalysisView.tsx"

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# The regex looks for `chart.subscribeCrosshairMove((param) => {` 
# and inserts the early return right after it.
# Note: we should only target `chart.subscribeCrosshairMove` (which are the individual ones)
# The synced one is `sourceChart.subscribeCrosshairMove(onCrosshairMove);`

pattern = r"(chart\.subscribeCrosshairMove\(\(param\) => \{\s*)"
replacement = r"\1if (param.point === undefined && param.time !== undefined) return;\n        "

new_content = re.sub(pattern, replacement, content)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Patched StrategyAnalysisView.tsx to ignore programmatic crosshair moves in individual charts.")
