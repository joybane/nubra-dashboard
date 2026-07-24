import json
import re

transcript_path = r"C:\Users\ADMIN\.gemini\antigravity-ide\brain\d57b25aa-d1d5-4616-84d3-47a9a63e1a54\.system_generated\logs\transcript_full.jsonl"
output_path = r"e:\Derivativesproject\nubra-dashboard\src\components\ChartTooltips.tsx"

file_content = {}

with open(transcript_path, 'r', encoding='utf-8') as f:
    for line in f:
        try:
            step = json.loads(line.strip())
            if step.get("type") == "VIEW_FILE" and step.get("source") == "MODEL":
                content = step.get("content", "")
                if "ChartTooltips.tsx" in content and "1: import React" in content:
                    lines = content.split('\n')
                    for l in lines:
                        match = re.match(r'^(\d+): (.*)$', l)
                        if match:
                            line_num = int(match.group(1))
                            line_text = match.group(2)
                            if line_num not in file_content:
                                file_content[line_num] = line_text
        except:
            pass

if file_content:
    with open(output_path, 'w', encoding='utf-8') as f:
        for i in range(1, max(file_content.keys()) + 1):
            f.write(file_content.get(i, "") + "\n")
    print("Extracted ChartTooltips.tsx successfully with " + str(len(file_content)) + " lines.")
else:
    print("Failed to find any lines for ChartTooltips.tsx")
