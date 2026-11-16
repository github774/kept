#!/usr/bin/env bash
# Prints "<processes> <total RSS MB>" for a process and all its descendants.
# Usage: scripts/scale-probe/tree-rss.sh <root-pid>
set -euo pipefail
ps -A -o pid=,ppid=,rss= | awk -v root="$1" '
  { pid[NR]=$1; ppid[NR]=$2; rss[NR]=$3; n=NR }
  END {
    keep[root]=1; grew=1
    while (grew) { grew=0; for (i=1;i<=n;i++) if (!(pid[i] in keep) && (ppid[i] in keep)) { keep[pid[i]]=1; grew=1 } }
    c=0; t=0; for (i=1;i<=n;i++) if (pid[i] in keep) { c++; t+=rss[i] }
    printf "%d %.0f\n", c, t/1024
  }'
