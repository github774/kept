"""Head-to-head accuracy and cost: Kept (default config) vs Codex subagents, every suite both sides ran.

Reads bench/results.json (excluded and mock rows skipped; every other trial counts) and prints the numbers
the README hero and harness card use, as JSON. Usage: python3 bench/aggregate/headline.py
"""
import json
import statistics as st
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
rows = [r for r in json.loads((ROOT / "bench/results.json").read_text()) if not r.get("excluded") and not r.get("mock")]

# Kept's default config is recorded as mode "ablation" (shared reasoning off). Suites where both sides ran.
SUITES = {2: "Light suite (ours, v2)", 3: "Heavy suite (ours, v3)", 100: "HumanEval (public)", 200: "Big codebase (ours)"}
KEPT, CODEX = "ablation", "codex_baseline"


def side(mode, version):
    rs = [r for r in rows if r["mode"] == mode and r.get("task_version") == version and not r.get("sharing_fix")]
    tests_p = sum((r.get("tests") or {}).get("passed", 0) for r in rs)
    tests_t = sum((r.get("tests") or {}).get("total", 0) for r in rs)
    passing = [r for r in rs if r["success"]]
    tok = [r["tokens_per_passing_task"] for r in passing if r.get("tokens_per_passing_task")]
    usd = [r["usd"] for r in passing if r.get("usd") is not None]
    ttf = [r["time_to_finish_s"] for r in passing if r.get("time_to_finish_s")]
    return {
        "runs": len(rs),
        "passed": len(passing),
        "tests_passed": tests_p,
        "tests_total": tests_t,
        "traps_followed": sum(r.get("trap_hits") or 0 for r in rs),
        "tokens_per_pass": st.mean(tok) if tok else None,
        "usd_per_pass": st.mean(usd) if usd else None,
        "time_s": st.mean(ttf) if ttf else None,
        "usd_total": sum(r["usd"] or 0 for r in rs),
        "tokens_total": sum(r.get("tokens_per_passing_task") or 0 for r in rs),
        "time_total": sum(ttf),
    }


def ratio(a, b):
    return a / b if a is not None and b else None


out = {"suites": {}, "total": {}}
tot = defaultdict(lambda: defaultdict(float))
for v, name in SUITES.items():
    n, c = side(KEPT, v), side(CODEX, v)
    if not n["runs"] or not c["runs"]:
        continue
    out["suites"][name] = {
        "neo": n,
        "codex": c,
        # None when a side has no passing run in this suite (no per-pass mean to compare).
        "tokens_x": ratio(c["tokens_per_pass"], n["tokens_per_pass"]),
        "cost_x": ratio(c["usd_per_pass"], n["usd_per_pass"]),
        "speed_x": ratio(c["time_s"], n["time_s"]),
    }
    for k, s in (("neo", n), ("codex", c)):
        for f in ("runs", "passed", "tests_passed", "tests_total", "traps_followed", "usd_total", "tokens_total", "time_total"):
            tot[k][f] += s[f]
for k in ("neo", "codex"):
    t = tot[k]
    out["total"][k] = {f: (round(v, 4) if isinstance(v, float) and not v.is_integer() else int(v)) for f, v in t.items()}
    out["total"][k]["accuracy"] = t["tests_passed"] / t["tests_total"] if t["tests_total"] else None
    out["total"][k]["pass_rate"] = t["passed"] / t["runs"] if t["runs"] else None
# Pooled ratios: per task, the mean over passing runs on each side; summed over every task both sides ran, so
# unequal trial counts cannot tilt the ratio. Ratio = Codex sum / Kept sum.
def task_means(mode):
    by = defaultdict(lambda: defaultdict(list))
    for r in rows:
        if r["mode"] != mode or r.get("task_version") not in SUITES or r.get("sharing_fix") or not r["success"]:
            continue
        k = (r["task_version"], r["task"])
        by[k]["tok"].append(r["tokens_per_passing_task"] or 0)
        by[k]["usd"].append(r["usd"] or 0)
        by[k]["t"].append(r.get("time_to_finish_s") or 0)
    return {k: {m: st.mean(v) for m, v in d.items()} for k, d in by.items()}


nm, cm = task_means(KEPT), task_means(CODEX)
both = sorted(set(nm) & set(cm))
out["total"]["tasks_compared"] = len(both)
for m, key in (("tok", "tokens_x"), ("usd", "cost_x"), ("t", "speed_x")):
    out["total"][key] = sum(cm[k][m] for k in both) / sum(nm[k][m] for k in both)
print(json.dumps(out, indent=2, default=lambda x: round(x, 4)))
