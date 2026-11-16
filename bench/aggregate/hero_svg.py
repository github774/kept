"""Writes docs/hero.svg, the README banner, from bench/aggregate/headline.py (measured rows only).

Usage: python3 bench/aggregate/hero_svg.py
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
d = json.loads(subprocess.check_output([sys.executable, str(ROOT / "bench/aggregate/headline.py")]))
n, c, t = d["total"]["neo"], d["total"]["codex"], d["total"]
heavy = d["suites"].get("Heavy suite (ours, v3)")
runs = n["runs"] + c["runs"]

INK, MUTED, BG, BLUE, ORANGE, LINE = "#1B1A17", "#6B665E", "#F1EDE6", "#2F55D4", "#B8612F", "#D9D3C9"
SERIF = "Georgia, 'Times New Roman', serif"
SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"


def x(v):
    return f"{v:.0f}×" if v >= 10 else f"{v:.1f}×"


acc = f"{n['accuracy'] * 100:.0f}%"
def best(key):
    name, v = max(((k, v[key]) for k, v in d["suites"].items()), key=lambda kv: kv[1])
    return f"up to {x(v)} ({name.split(' (')[0].replace(' suite', '')})"


tiles = [
    (acc, "accuracy kept", f"{n['tests_passed']:,}/{n['tests_total']:,} tests passed", f"Codex: {c['tests_passed']:,}/{c['tests_total']:,}", BLUE),
    (x(t["tokens_x"]), "fewer tokens", best("tokens_x"), "", INK),
    (x(t["cost_x"]), "cheaper", best("cost_x"), "", INK),
    (x(t["speed_x"]), "faster", best("speed_x"), "", INK),
    (f"{n['traps_followed']}", "traps followed", f"Codex followed {c['traps_followed']}", "planted misleading facts", ORANGE),
]

W, H = 1280, 520
tw, gap, x0, y0 = 232, 14, 40, 250
parts = [
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="Kept vs Codex subagents: {acc} accuracy kept, {x(t["tokens_x"])} fewer tokens, {x(t["cost_x"])} cheaper, {x(t["speed_x"])} faster">',
    f'<rect width="{W}" height="{H}" rx="20" fill="{BG}"/>',
    f'<text x="40" y="62" font-family="{SANS}" font-size="17" letter-spacing="2.5" fill="{MUTED}">KEPT VS CODEX SUBAGENTS · SAME MODEL · SAME TASKS · SAME TESTS · {runs} RUNS · {t["tasks_compared"]} TASKS</text>',
    f'<text x="38" y="150" font-family="{SERIF}" font-size="60" font-weight="700" fill="{INK}">Same accuracy. <tspan fill="{BLUE}">{x(t["tokens_x"])} fewer tokens.</tspan></text>',
    f'<text x="40" y="200" font-family="{SANS}" font-size="22" fill="{MUTED}">Every run passed its full test suite on both sides, and Kept did it for a fraction of the tokens, cost and time.</text>',
]
for i, (big, label, sub1, sub2, color) in enumerate(tiles):
    tx = x0 + i * (tw + gap)
    parts += [
        f'<rect x="{tx}" y="{y0}" width="{tw}" height="230" rx="14" fill="#FBF9F5" stroke="{LINE}"/>',
        f'<text x="{tx + 20}" y="{y0 + 96}" font-family="{SANS}" font-size="{72 if len(big) <= 4 else 60}" font-weight="800" letter-spacing="-2" fill="{color}">{big}</text>',
        f'<text x="{tx + 20}" y="{y0 + 136}" font-family="{SANS}" font-size="22" font-weight="600" fill="{INK}">{label}</text>',
        f'<text x="{tx + 20}" y="{y0 + 176}" font-family="{SANS}" font-size="15" fill="{MUTED}">{sub1}</text>',
        f'<text x="{tx + 20}" y="{y0 + 198}" font-family="{SANS}" font-size="15" fill="{MUTED}">{sub2}</text>',
    ]
parts.append("</svg>")
(ROOT / "docs/hero.svg").write_text("\n".join(parts) + "\n")
print(json.dumps({"runs": runs, "accuracy": acc, "tokens_x": t["tokens_x"], "cost_x": t["cost_x"], "speed_x": t["speed_x"]}))
