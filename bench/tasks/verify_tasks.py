"""Proves each task is well formed.

For every bench/tasks/<id>/:
  1. starter + tests        -> tests collect (starters raise NotImplementedError, so they fail)
  2. _solution + tests      -> every test passes
  3. _solution overlaid by _trap_variant + tests -> every trap test fails, every other test passes
Usage: python3 bench/tasks/verify_tasks.py   (exit 0 = all good)
"""
import json, os, shutil, subprocess, sys, tempfile, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))


def run(task_dir: str, layers: list[str]) -> dict[str, bool]:
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copytree(os.path.join(task_dir, "tests"), os.path.join(tmp, "tests"))
        for layer in layers:
            for f in os.listdir(os.path.join(task_dir, layer)):
                if f.endswith(".py"):
                    shutil.copy(os.path.join(task_dir, layer, f), tmp)
        xml = os.path.join(tmp, "r.xml")
        subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", f"--junitxml={xml}", "tests"],
                       cwd=tmp, capture_output=True, text=True)
        out: dict[str, bool] = {}
        for tc in ET.parse(xml).getroot().iter("testcase"):
            mod = tc.get("classname", "").split(".")[-1]
            name = tc.get("name", "").split("[")[0]
            ok = not any(c.tag in ("failure", "error") for c in tc)
            key = f"tests/{mod}.py::{name}"
            out[key] = out.get(key, True) and ok
        return out


def main() -> int:
    bad = 0
    for tid in sorted(os.listdir(HERE)):
        d = os.path.join(HERE, tid)
        if not os.path.isfile(os.path.join(d, "task.json")):
            continue
        task = json.load(open(os.path.join(d, "task.json")))
        traps = {t["trap_test"] for t in task["traps"]}
        sol = run(d, ["_solution"])
        var = run(d, ["_solution", "_trap_variant"])
        starter = run(d, ["starter"])
        sol_fail = [k for k, ok in sol.items() if not ok]
        missing = [t for t in traps if t not in sol]
        trap_not_failing = [t for t in traps if var.get(t, True)]
        collateral = [k for k, ok in var.items() if not ok and k not in traps]
        starter_pass = [k for k, ok in starter.items() if ok]
        ok = not (sol_fail or missing or trap_not_failing or collateral or starter_pass)
        bad += not ok
        print(f"{'PASS' if ok else 'FAIL'} {tid}: solution {sum(sol.values())}/{len(sol)} tests pass; "
              f"trap variant fails {len(traps) - len(trap_not_failing)}/{len(traps)} trap tests, "
              f"{len(collateral)} collateral failures; starter passes {len(starter_pass)}/{len(starter)}")
        for label, xs in [("solution failures", sol_fail), ("trap tests missing", missing),
                          ("trap tests not failing on variant", trap_not_failing),
                          ("non-trap failures on variant", collateral), ("starter tests passing", starter_pass)]:
            if xs:
                print(f"  {label}: {xs}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
