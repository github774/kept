#!/usr/bin/env bash
# Demo preflight: one GO / NO-GO line per check, then an overall verdict (exit 1 on any NO-GO).
# Secrets are never printed: keys are reported as present/missing, OpenRouter as numbers only.
#
# Usage: scripts/demo/preflight.sh [--offline]
#   --offline   skip the OpenRouter key check (no network)
# Env: same rules as scripts/start-all.sh (exported vars win over .env; RUN_DIR overrides .run/).
#   MIN_DISK_GB (default 5), MIN_RAM_GB (default 2), MIN_OPENROUTER_USD (default 0.50 left on the key)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$ROOT/.run}"
OFFLINE=0
for a in "$@"; do
    case "$a" in
        --offline) OFFLINE=1 ;;
        -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
        *) echo "preflight: unknown option $a" >&2; exit 2 ;;
    esac
done

NOGO=0
WARNED=0
go()   { printf '  GO     %-22s %s\n' "$1" "$2"; }
nogo() { printf '  NO-GO  %-22s %s\n' "$1" "$2"; NOGO=$((NOGO + 1)); }
warn() { printf '  WARN   %-22s %s\n' "$1" "$2"; WARNED=$((WARNED + 1)); }

echo "== demo preflight ($(date '+%F %T'), repo $ROOT)"

# ---------------------------------------------------------------- .env
load_env() {
    local line key
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
        key="${BASH_REMATCH[2]}"
        [[ -n "${!key+x}" ]] && continue
        eval "export ${line#export }" 2>/dev/null || true
    done < "$ROOT/.env"
}
# Keys that may be empty: read with optionalEnv() in orchestrator/src/config.ts (model overrides).
OPTIONAL_KEYS=" MODEL_PROFILE WORKER_MODEL "
if [[ -f "$ROOT/.env" ]]; then
    go ".env" "present"
    load_env
    if [[ -f "$ROOT/.env.example" ]]; then
        missing=()
        while IFS= read -r k; do
            [[ "$OPTIONAL_KEYS" == *" $k "* ]] && continue
            [[ -z "${!k:-}" ]] && missing+=("$k")
        done < <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$ROOT/.env.example" | tr -d '=')
        if [[ ${#missing[@]} -eq 0 ]]; then go ".env keys" "all keys from .env.example set (values not shown)"
        else nogo ".env keys" "missing or empty: ${missing[*]}"; fi
    else
        warn ".env keys" "no .env.example to compare against"
    fi
else
    nogo ".env" "missing ($ROOT/.env); copy .env.example and fill it in"
fi

# ---------------------------------------------------------------- toolchain
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }
if command -v bun >/dev/null 2>&1; then
    bv="$(bun --version 2>/dev/null)"
    if ver_ge "$bv" "1.4.2"; then go "bun" "$bv (>= 1.4.2)"; else nogo "bun" "$bv is older than 1.4.2"; fi
else
    nogo "bun" "not on PATH"
fi

if [[ -n "${NODE22:-}" ]]; then
    if [[ -x "$NODE22" ]]; then
        nv="$("$NODE22" --version 2>/dev/null)"
        if [[ "$nv" == v22.* ]]; then go "node 22" "$nv at \$NODE22"; else nogo "node 22" "\$NODE22 is $nv, need v22.x"; fi
    else
        nogo "node 22" "\$NODE22 ($NODE22) is not an executable"
    fi
else
    nogo "node 22" "NODE22 not set in .env"
fi

if command -v python3 >/dev/null 2>&1; then
    pv="$(python3 --version 2>&1 | awk '{print $2}')"
    if ver_ge "$pv" "3.11"; then go "python3" "$pv"; else nogo "python3" "$pv, need >= 3.11"; fi
    if ptv="$(python3 -m pytest --version 2>&1)"; then go "pytest" "$(echo "$ptv" | head -1)"
    else nogo "pytest" "python3 -m pytest failed: $(echo "$ptv" | tail -1 | cut -c1-80)"; fi
else
    nogo "python3" "not on PATH"
fi

# ---------------------------------------------------------------- ports
# A port is GO when free, or when its listener is one of our processes (in the .run/<name>.pid tree).
descendants() {
    local queue=("$@") p kids
    while [[ ${#queue[@]} -gt 0 ]]; do
        p="${queue[0]}"; queue=("${queue[@]:1}")
        [[ -z "$p" ]] && continue
        kill -0 "$p" 2>/dev/null || continue
        echo "$p"
        kids="$(pgrep -P "$p" 2>/dev/null || true)"
        [[ -n "$kids" ]] && queue+=($kids)
    done
}
check_port() {
    local name="$1" port="$2" holders tree root ours=1 h
    if [[ -z "$port" ]]; then nogo "port $name" "$(echo "$name" | tr a-z A-Z)_PORT not set"; return; fi
    holders="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u | xargs)"
    if [[ -z "$holders" ]]; then go "port $port ($name)" "free"; return; fi
    root="$( [[ -f "$RUN_DIR/$name.pid" ]] && cat "$RUN_DIR/$name.pid" 2>/dev/null)"
    tree=" $(descendants $root | xargs) "
    for h in $holders; do [[ "$tree" == *" $h "* ]] || ours=0; done
    if [[ $ours -eq 1 ]]; then go "port $port ($name)" "held by our $name (pid $holders, .run/$name.pid $root)"
    else nogo "port $port ($name)" "held by pid $holders ($(ps -o comm= -p "${holders%% *}" 2>/dev/null)), not started by scripts/start-all.sh"; fi
}
check_port actors "${ACTORS_PORT:-}"
check_port relay "${RELAY_PORT:-}"
check_port orchestrator "${ORCHESTRATOR_PORT:-}"

# ---------------------------------------------------------------- OpenRouter key (numbers only)
if [[ $OFFLINE -eq 1 ]]; then
    warn "openrouter key" "skipped (--offline)"
elif [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
    nogo "openrouter key" "OPENROUTER_API_KEY not set"
else
    body="$(curl -sS -m 10 -w '\n%{http_code}' -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/key 2>/dev/null)"
    code="$(tail -1 <<< "$body")"; json="$(sed '$d' <<< "$body")"
    if [[ "$code" != "200" ]]; then
        nogo "openrouter key" "GET /api/v1/key returned HTTP ${code:-none}"
    else
        # Only numeric fields are extracted; the key label and anything else are never printed.
        line="$(MIN="${MIN_OPENROUTER_USD:-0.50}" python3 -c '
import json, os, sys
d = json.loads(sys.stdin.read()).get("data", {})
num = lambda k: d.get(k) if isinstance(d.get(k), (int, float)) else None
usage, limit, rem = num("usage"), num("limit"), num("limit_remaining")
if rem is None and limit is not None and usage is not None: rem = limit - usage
f = lambda v: "none" if v is None else f"{v:.4f}"
ok = rem is None or rem >= float(os.environ["MIN"])
print(("GO" if ok else "NOGO") + f" usage ${f(usage)} / limit ${f(limit)} (remaining ${f(rem)}; null limit = unlimited)")
' <<< "$json" 2>/dev/null)"
        if [[ -z "$line" ]]; then nogo "openrouter key" "could not parse the /api/v1/key response"
        elif [[ "$line" == GO* ]]; then go "openrouter key" "${line#GO }"
        else nogo "openrouter key" "${line#NOGO } < MIN_OPENROUTER_USD ${MIN_OPENROUTER_USD:-0.50}"; fi
    fi
fi

# ---------------------------------------------------------------- disk / RAM
min_disk="${MIN_DISK_GB:-5}"; min_ram="${MIN_RAM_GB:-2}"
disk_kb="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
disk_gb=$(( disk_kb / 1024 / 1024 ))
if (( disk_gb >= min_disk )); then go "disk" "${disk_gb} GB free (>= $min_disk)"; else nogo "disk" "${disk_gb} GB free (< $min_disk)"; fi

if [[ "$(uname)" == "Darwin" ]]; then
    # free + inactive + purgeable + speculative pages are reclaimable without swapping.
    ram_mb="$(vm_stat | awk -v ps="$(pagesize)" '
        /Pages free/ || /Pages inactive/ || /Pages purgeable/ || /Pages speculative/ { gsub("\\.","",$NF); n += $NF }
        END { printf "%d", n * ps / 1048576 }')"
    total_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
else
    ram_mb="$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)"
    total_gb="$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)"
fi
if (( ram_mb >= min_ram * 1024 )); then go "ram" "${ram_mb} MB available of ${total_gb} GB (>= ${min_ram} GB)"
else nogo "ram" "${ram_mb} MB available of ${total_gb} GB (< ${min_ram} GB); close other apps"; fi

echo
if (( NOGO == 0 )); then if (( WARNED > 0 )); then echo "PREFLIGHT: GO ($WARNED warning(s))"; else echo "PREFLIGHT: GO"; fi; exit 0; fi
echo "PREFLIGHT: NO-GO ($NOGO item(s))"; exit 1
