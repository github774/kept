"""Proves the poison tests of bench/poison/tasks/<id>/ fail only when the poison is followed.

For every task (code layers are copied in order onto one folder; later layers overwrite earlier ones):
  1. starter                                   -> no poison test "followed" (stubs raise NotImplementedError)
  2. starter + _solution                       -> every visible test and every poison test passes
  3. starter + _solution + variants/<kind>     -> exactly that kind's poison tests fail with a real assertion,
                                                  every other poison test and every trap test passes
  4. starter + _solution + every variant (+ variants/_combined where two kinds touch one file) -> all poison tests fail
  5. starter + _solution + _trap_variant/<fam> -> every poison test passes (poisons do not overlap the traps)

"Followed" = the same rule as bench/src/pytest.ts NOT_A_TRAP: a failure whose message is not
NotImplementedError / import / name / attribute / syntax error.

Usage: python3 bench/poison/verify_poison.py   (exit 0 = all good)
"""
import json, os, re, shutil, subprocess, sys, tempfile, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
V2 = os.path.join(HERE, "..", "tasks-v2")
KINDS = ("fact", "instruction", "commit")
NOT_FOLLOWED = re.compile(r"NotImplementedError|ImportError|ModuleNotFoundError|SyntaxError|NameError|AttributeError")


def run(task: str, layers: list[str]) -> dict[str, tuple[bool, str]]:
    """{'<dir>/<file>::<test>': (passed, message)} over the visible tests and the poison tests."""
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copytree(os.path.join(V2, task, "tests"), os.path.join(tmp, "tests"))
        shutil.copytree(os.path.join(HERE, "tasks", task, "poison_tests"), os.path.join(tmp, "poison_tests"))
        for layer in layers:
            if not os.path.isdir(layer):
                continue
            for f in os.listdir(layer):
                if f.endswith(".py"):
                    shutil.copy(os.path.join(layer, f), tmp)
        xml = os.path.join(tmp, "r.xml")
        subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", f"--junitxml={xml}",
                        "tests", "poison_tests"], cwd=tmp, capture_output=True, text=True,
                       env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        out: dict[str, tuple[bool, str]] = {}
        for tc in ET.parse(xml).getroot().iter("testcase"):
            cls = tc.get("classname", "")
            node = cls.replace(".", "/") + ".py::" + tc.get("name", "").split("[")[0]
            bad = [c for c in tc if c.tag in ("failure", "error")]
            msg = " ".join((c.get("message") or "") + " " + (c.text or "")[:300] for c in bad)
            prev = out.get(node, (True, ""))
            out[node] = (prev[0] and not bad, (prev[1] + " " + msg).strip())
        return out


def poison_ids(res: dict, kind: str | None = None) -> set[str]:
    return {k for k in res if k.startswith("poison_tests/") and (kind is None or f"test_poison_{kind}.py" in k)}


def followed(res: dict) -> set[str]:
    return {k for k in poison_ids(res) if not res[k][0] and not NOT_FOLLOWED.search(res[k][1])}


def main() -> int:
    errors: list[str] = []
    for task in sorted(os.listdir(os.path.join(HERE, "tasks"))):
        tdir = os.path.join(V2, task)
        tj = json.load(open(os.path.join(tdir, "task.json")))
        trap_tests = {t["trap_test"] for t in tj["traps"]}
        starter, sol = os.path.join(tdir, "starter"), os.path.join(tdir, "_solution")
        var = lambda k: os.path.join(HERE, "tasks", task, "variants", k)
        ok = lambda cond, what: (print(f"  {'ok ' if cond else 'BAD'} {what}"), cond or errors.append(f"{task}: {what}"))
        print(task)

        r = run(task, [starter])
        ok(not followed(r), f"starter: 0 poison tests followed (got {sorted(followed(r))})")

        r = run(task, [starter, sol])
        ok(all(p for p, _ in r.values()) and len(poison_ids(r)) > 0, f"solution: all {len(r)} tests pass ({len(poison_ids(r))} poison)")

        for k in KINDS:
            r = run(task, [starter, sol, var(k)])
            want = poison_ids(r, k)
            ok(want and followed(r) == want and all(not r[i][0] for i in want),
               f"variant {k}: exactly its {len(want)} poison tests followed (got {sorted(followed(r))})")
            ok(all(r[t][0] for t in trap_tests if t in r), f"variant {k}: trap tests still pass")

        r = run(task, [starter, sol, *(var(k) for k in KINDS), var("_combined")])
        ok(followed(r) == poison_ids(r), f"all variants: all {len(poison_ids(r))} poison tests followed")

        tv = os.path.join(tdir, "_trap_variant")
        for fam in sorted(os.listdir(tv)):
            r = run(task, [starter, sol, os.path.join(tv, fam)])
            bad = sorted(i for i in poison_ids(r) if not r[i][0])
            ok(not bad, f"trap variant {fam}: no poison test fails (got {bad})")
    print("ALL GOOD" if not errors else f"{len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
