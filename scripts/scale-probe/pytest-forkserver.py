# Persistent pytest "zygote": imports pytest once, then forks one child per request.
# Each child chdirs into its own temp dir and runs pytest.main, so module state never leaks
# between agents (tests import solution modules by bare name, so an in-process pytest.main
# without fork would reuse a stale sys.modules entry).
# Protocol (JSON lines): stdin {"id", "dir", "test", "timeout_s"} -> stdout {"id", "code", "ms"}.
import json
import os
import signal
import sys
import threading
import time

import pytest  # noqa: F401  (pre-import is the point)
import _pytest.config  # noqa: F401
import _pytest.python  # noqa: F401
import _pytest.assertion.rewrite  # noqa: F401
import decimal, datetime, re  # noqa: F401,E401  (modules the tasks use)

out_lock = threading.Lock()


def reply(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def run(req):
    t0 = time.monotonic()
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            os.chdir(req["dir"])
            fd = os.open(os.path.join(req["dir"], ".pytest-output.txt"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.dup2(fd, 1)
            os.dup2(fd, 2)
            # Fresh stream objects: the parent's may have had their buffer lock held by another thread at fork.
            sys.stdout = open(1, "w", closefd=False)
            sys.stderr = open(2, "w", closefd=False)
            sys.path.insert(0, req["dir"])
            os.environ["HOME"] = req["dir"]
            code = pytest.main(["-q", "-rfE", "-p", "no:cacheprovider", "--color=no", req["test"]])
            sys.stdout.flush()
            sys.stderr.flush()
            os._exit(int(code))
        except BaseException:
            os._exit(99)
    timer = threading.Timer(req.get("timeout_s", 30), lambda: os.killpg(pid, signal.SIGKILL))
    timer.start()
    _, status = os.waitpid(pid, 0)
    timer.cancel()
    code = os.waitstatus_to_exitcode(status)
    reply({"id": req["id"], "code": code, "ms": round((time.monotonic() - t0) * 1000)})


for line in sys.stdin:
    line = line.strip()
    if line:
        threading.Thread(target=run, args=(json.loads(line),), daemon=True).start()
