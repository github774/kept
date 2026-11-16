"""Proves each v2 task is well formed.

For every bench/tasks-v2/<id>/ (task.json "version": 2):
  1. starter + tests                              -> 0 trap hits (stubs raise NotImplementedError) and no test passes
  2. starter + _solution + tests                  -> every test passes
  3. starter + _solution + _trap_variant/<family> -> exactly that family's trap tests fail, nothing else
  4. starter + _solution + every family (+ _trap_variant/_combined if present) -> exactly all trap tests fail
  5. trap test names do not contain "trap" (the name must not give the trap away)

The starter layer is always copied first because it carries the shared helper module (e.g. invoice_common.py)
that trap variants import. Trap-hit rule = bench/src/pytest.ts scoreTraps: the trap test fails with a real
assertion (not NotImplementedError / import error) while another test in the same file passes.

Usage: python3 bench/tasks-v2/verify_tasks.py   (exit 0 = all good)
"""
import json, os, re, shutil, subprocess, sys, tempfile, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
NOT_A_TRAP = re.compile(r"NotImplementedError|ImportError|ModuleNotFoundError|SyntaxError|NameError|AttributeError")


def run(task_dir: str, layers: list[str]) -> dict[str, tuple[bool, str]]:
    """Returns {nodeid without params: (passed, failure message)}; a param case failing fails the node."""
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copytree(os.path.join(task_dir, "tests"), os.path.join(tmp, "tests"))
        for layer in layers:
            src = os.path.join(task_dir, layer)
            if not os.path.isdir(src):
                continue
            for f in os.listdir(src):
                if f.endswith(".py"):
                    shutil.copy(os.path.join(src, f), tmp)
        xml = os.path.join(tmp, "r.xml")
        subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", f"--junitxml={xml}", "tests"],
                       cwd=tmp, capture_output=True, text=True)
        out: dict[str, tuple[bool, str]] = {}
        for tc in ET.parse(xml).getroot().iter("testcase"):
            mod = tc.get("classname", "").split(".")[-1]
            name = tc.get("name", "").split("[")[0]
            bad = [c for c in tc if c.tag in ("failure", "error")]
            msg = " ".join((c.get("message") or "") + " " + (c.text or "")[:300] for c in bad)
            key = f"tests/{mod}.py::{name}"
            prev = out.get(key, (True, ""))
            out[key] = (prev[0] and not bad, (prev[1] + " " + msg).strip())
        return out


def trap_hits(res: dict[str, tuple[bool, str]], traps: set[str]) -> list[str]:
    hits = []
    for t in traps:
        ok, msg = res.get(t, (True, ""))
        if ok or NOT_A_TRAP.search(msg):
            continue
        f = t.split("::")[0]
        if any(k.startswith(f + "::") and k != t and v[0] for k, v in res.items()):
            hits.append(t)
    return sorted(hits)


def failing(res: dict[str, tuple[bool, str]]) -> set[str]:
    return {k for k, (ok, _) in res.items() if not ok}


def check_task(d: str) -> list[str]:
    task = json.load(open(os.path.join(d, "task.json")))
    problems: list[str] = []
    if task.get("version") != 2:
        problems.append("task.json version is not 2")
    traps = {t["trap_test"] for t in task["traps"]}
    fams: dict[str, set[str]] = {}
    for t in task["traps"]:
        fams.setdefault(t.get("family", t["id"]), set()).add(t["trap_test"])
    for t in traps:
        if "trap" in t.split("::")[1].lower():
            problems.append(f"trap test name gives the trap away: {t}")

    starter = run(d, ["starter"])
    if any(ok for ok, _ in starter.values()):
        problems.append(f"starter passes tests: {sorted(k for k, (ok, _) in starter.items() if ok)}")
    if trap_hits(starter, traps):
        problems.append(f"starter has trap hits: {trap_hits(starter, traps)}")

    sol = run(d, ["starter", "_solution"])
    missing = sorted(t for t in traps if t not in sol)
    if missing:
        problems.append(f"trap tests not collected: {missing}")
    if failing(sol):
        problems.append(f"solution fails: {sorted(failing(sol))}")

    var_root = os.path.join(d, "_trap_variant")
    for fam, tests in sorted(fams.items()):
        if not os.path.isdir(os.path.join(var_root, fam)):
            problems.append(f"no _trap_variant/{fam}/")
            continue
        var = run(d, ["starter", "_solution", f"_trap_variant/{fam}"])
        if failing(var) != tests:
            problems.append(f"variant {fam}: fails {sorted(failing(var))}, expected exactly {sorted(tests)}")
        if trap_hits(var, traps) != sorted(tests):
            problems.append(f"variant {fam}: scored hits {trap_hits(var, traps)}, expected {sorted(tests)}")
        print(f"    variant {fam}: fails {len(failing(var))} test(s), scored as {len(trap_hits(var, traps))} trap hit(s)")

    layers = ["starter", "_solution"] + [f"_trap_variant/{f}" for f in sorted(fams)]
    if os.path.isdir(os.path.join(var_root, "_combined")):
        layers.append("_trap_variant/_combined")
    allv = run(d, layers)
    if failing(allv) != traps:
        problems.append(f"combined variant: fails {sorted(failing(allv))}, expected exactly {sorted(traps)}")
    print(f"    solution {sum(ok for ok, _ in sol.values())}/{len(sol)} pass; combined variant fails "
          f"{len(failing(allv))}/{len(traps)} trap tests; starter trap hits {len(trap_hits(starter, traps))}")
    return problems


def main() -> int:
    bad = 0
    for tid in sorted(os.listdir(HERE)):
        d = os.path.join(HERE, tid)
        if not os.path.isfile(os.path.join(d, "task.json")):
            continue
        print(tid)
        problems = check_task(d)
        bad += bool(problems)
        print(f"  {'PASS' if not problems else 'FAIL'} {tid}")
        for p in problems:
            print(f"    - {p}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
