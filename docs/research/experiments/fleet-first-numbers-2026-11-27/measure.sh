#!/usr/bin/env bash
# Fleet first numbers (2026-11-27). Re-runnable.
# Measured on: Apple M4 Pro Mac (24 GiB host), colima profile `default`
# (docker runtime, aarch64, 2 CPU / 4 GiB). Creates and removes only
# containers named fleetprobe-* and the image myco-fleet-probe:local.
#
# usage: measure.sh build | cold [N] | paint [N] | scale | probes | cleanup
# Appends to raw.jsonl next to this script.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RAW=$HERE/raw.jsonl
IMG=myco-fleet-probe:local
READY_TIMEOUT=120
STEPS=(1 2 4 6 8 10 12 16 20 24 28 32)
MAX_STEP_ADD_MIB=1024      # host memory guard: no step may add > ~1 GiB
HOST_SWAP_FREE_MIN_MIB=300 # host memory guard
HOST_FREE_PCT_MIN=20       # host memory guard
VM_AVAIL_MIN_MIB=400       # keep colima's VM out of swap/OOM

now() { python3 -c 'import time;print(f"{time.time():.3f}")'; }
log() { # phase k container metric value unit [note]
  printf '{"ts":"%s","host":"colima default 2cpu/4GiB","phase":"%s","k":%s,"container":"%s","metric":"%s","value":%s,"unit":"%s","note":"%s","run":"'"${RUN:-v2-noreset}"'"}\n' \
    "$(date -u +%FT%TZ)" "$1" "$2" "$3" "$4" "$5" "$6" "${7:-}" >> "$RAW"; }

host_swap_free_mib() { sysctl -n vm.swapusage | sed -E 's/.*free = ([0-9.]+)M.*/\1/'; }
host_free_pct() { memory_pressure -Q | sed -nE 's/.*percentage: ([0-9]+)%.*/\1/p'; }
vm_avail_mib() { docker run --rm alpine:3 awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
vm_free_m() { docker run --rm alpine:3 free -m | awk '/Mem:/{print $2" "$3" "$4" "$7}'; }  # total used free avail

start_one() { docker run -d --name "$1" --memory=1g --shm-size=256m "$IMG" >/dev/null; }

# Host-observed wait: poll in-container marker files via docker exec.
wait_ready() { # name t0 -> prints "x_s calc_s" or "x_s FAIL"
  local n=$1 t0=$2 x="" c="" t
  while :; do
    t=$(now)
    if [ -z "$x" ] && docker exec "$n" test -f /tmp/x_ready 2>/dev/null; then x=$(python3 -c "print(round($t-$t0,2))"); fi
    if docker exec "$n" test -f /tmp/calc_ready 2>/dev/null; then c=$(python3 -c "print(round($t-$t0,2))"); break; fi
    if python3 -c "import sys;sys.exit(0 if $t-$t0>$READY_TIMEOUT else 1)"; then c=FAIL; break; fi
    sleep 0.25
  done
  echo "${x:-FAIL} $c"
}

# In-VM clock deltas: container StartedAt -> marker files (all VM clock).
inner_deltas() {
  local n=$1 st
  st=$(docker inspect -f '{{.State.StartedAt}}' "$n")
  docker exec "$n" sh -c "s=\$(date -d '$st' +%s.%N); x=\$(cat /tmp/x_ready); c=\$(cat /tmp/calc_ready 2>/dev/null || echo 0); awk -v s=\$s -v x=\$x -v c=\$c 'BEGIN{printf \"%.2f %.2f\", x-s, (c>0?c-s:-1)}'"
}

mem_of() { # name -> "statsMiB cgroupMiB"
  local s c
  s=$(docker stats --no-stream --format '{{.MemUsage}}' "$1" | awk '{v=$1; if (v~/GiB/){sub("GiB","",v); v*=1024} else {sub("MiB","",v)}; print v}')
  c=$(docker exec "$1" sh -c 'cat /sys/fs/cgroup/memory.current 2>/dev/null' | awk '{printf "%.1f", $1/1048576}')
  echo "$s ${c:-NA}"
}

cmd_build() {
  docker build -t "$IMG" "$HERE"
  log build 0 - image_size "$(docker image inspect -f '{{.Size}}' "$IMG")" bytes "docker image inspect .Size"
}

cmd_cold() {
  local N=${1:-5} i n t0 r d m
  for i in $(seq 1 "$N"); do
    n=fleetprobe-cold-$i
    t0=$(now); start_one "$n"
    r=$(wait_ready "$n" "$t0")
    log cold 1 "$n" x_ready_host "${r% *}" s "host: docker run issued -> /tmp/x_ready seen via docker exec poll 0.25s"
    log cold 1 "$n" calc_ready_host "$( [ "${r#* }" = FAIL ] && echo null || echo "${r#* }")" s "host: docker run issued -> Calc window titled seed.csv seen"
    d=$(inner_deltas "$n")
    log cold 1 "$n" x_ready_invm "${d% *}" s "VM clock: StartedAt -> Xvfb accepts (xdpyinfo)"
    log cold 1 "$n" calc_ready_invm "${d#* }" s "VM clock: StartedAt -> wmctrl sees seed.csv window"
    sleep 10   # let Calc settle to idle
    m=$(mem_of "$n")
    log cold 1 "$n" mem_stats "${m% *}" MiB "docker stats --no-stream, Calc idle, doc open, +10s"
    log cold 1 "$n" mem_cgroup "${m#* }" MiB "cgroup v2 memory.current"
    echo "cold $i: host=$r invm=$d mem=$m"
    docker rm -f "$n" >/dev/null
  done
}

guard_ok() { # projected_add_mib -> 0 ok / 1 stop (prints reason)
  local add=$1 sw pct av
  sw=$(host_swap_free_mib); pct=$(host_free_pct); av=$(vm_avail_mib)
  log guard 0 - host_swap_free "$sw" MiB "sysctl vm.swapusage"
  log guard 0 - host_free_pct "$pct" pct "memory_pressure -Q"
  log guard 0 - vm_mem_available "$av" MiB "colima VM /proc/meminfo"
  echo "guard: host swap free ${sw}M, host free ${pct}%, VM avail ${av}M, step adds ~${add}M"
  python3 -c "import sys;sys.exit(0 if float('$sw')>=$HOST_SWAP_FREE_MIN_MIB else 1)" || { echo "STOP: host swap free ${sw}M < ${HOST_SWAP_FREE_MIN_MIB}M"; return 1; }
  [ "$pct" -ge "$HOST_FREE_PCT_MIN" ] || { echo "STOP: host free ${pct}% < ${HOST_FREE_PCT_MIN}%"; return 1; }
  [ "$add" -le "$MAX_STEP_ADD_MIB" ] || { echo "STOP: step would add ~${add}M > ${MAX_STEP_ADD_MIB}M"; return 1; }
  [ $((av - add)) -ge "$VM_AVAIL_MIN_MIB" ] || { echo "STOP: colima VM avail ${av}M - ${add}M < ${VM_AVAIL_MIN_MIB}M"; return 1; }
  return 0
}

# Incremental scale: keep the running desktops, start the new batch in parallel.
cmd_scale() {
  local per=${PER_MIB:-400} prev=0 k i n t0 pids r fails tot m s c wall
  for k in "${STEPS[@]}"; do
    guard_ok $(( (k - prev) * per )) || { log scale "$prev" - stop_reason 0 none "stopped by host memory guard before K=$k"; break; }
    t0=$(now); fails=0
    for i in $(seq $((prev + 1)) "$k"); do start_one fleetprobe-k-$i & done; wait
    for i in $(seq $((prev + 1)) "$k"); do wait_ready fleetprobe-k-$i "$t0" > ${TMPDIR:-/tmp}/fleetprobe-r-$i & done; wait
    wall=0
    for i in $(seq $((prev + 1)) "$k"); do
      r=$(cat ${TMPDIR:-/tmp}/fleetprobe-r-$i); rm -f ${TMPDIR:-/tmp}/fleetprobe-r-$i
      [ "${r#* }" = FAIL ] && fails=$((fails + 1)) || wall=$(python3 -c "print(max($wall, ${r#* }))")
    done
    sleep 10
    tot=0; tc=0
    for i in $(seq 1 "$k"); do m=$(mem_of fleetprobe-k-$i); s=${m% *}; c=${m#* }
      tot=$(python3 -c "print(round($tot+$s,1))"); tc=$(python3 -c "print(round($tc+${c/NA/0},1))"); done
    log scale "$k" - batch_wall_all_ready "$wall" s "new batch of $((k - prev)) started in parallel; slowest to Calc up"
    log scale "$k" - failures "$fails" count "Calc not up within ${READY_TIMEOUT}s"
    log scale "$k" - mem_total_stats "$tot" MiB "sum docker stats over K"
    log scale "$k" - mem_avg_stats "$(python3 -c "print(round($tot/$k,1))")" MiB "per desktop"
    log scale "$k" - mem_total_cgroup "$tc" MiB "sum memory.current over K"
    read -r vt vu vf va <<<"$(vm_free_m)"
    log scale "$k" - vm_free_m_used "$vu" MiB "busybox free -m in colima VM (total $vt)"
    log scale "$k" - vm_free_m_available "$va" MiB "busybox free -m in colima VM"
    echo "K=$k wall=${wall}s fails=$fails total=${tot}MiB avg=$(python3 -c "print(round($tot/$k,1))") vm_avail=${va}M"
    per=$(python3 -c "print(int($tot/$k*1.15)+1)")
    [ "$fails" -gt 0 ] && { log scale "$k" - stop_reason 0 none "failure at K=$k"; break; }
    prev=$k
  done
}

cmd_probes() {
  local n=fleetprobe-probe
  start_one "$n"; wait_ready "$n" "$(now)" >/dev/null
  docker exec "$n" sh -c 'DISPLAY=:1 import -window root /tmp/s.png && identify /tmp/s.png' && log probe 1 "$n" screenshot_import 1 bool || log probe 1 "$n" screenshot_import 0 bool
  docker exec "$n" sh -c 'DISPLAY=:1 xwd -root -silent > /tmp/s.xwd && test -s /tmp/s.xwd' && log probe 1 "$n" screenshot_xwd 1 bool || log probe 1 "$n" screenshot_xwd 0 bool
  docker exec "$n" python3 -c 'import pyatspi' && log probe 1 "$n" pyatspi_import 1 bool || log probe 1 "$n" pyatspi_import 0 bool
  docker exec "$n" python3 -c 'import flask; print(flask.__version__)' && log probe 1 "$n" flask_import 1 bool || log probe 1 "$n" flask_import 0 bool
  docker exec "$n" python3 -c 'import uno' && log probe 1 "$n" uno_import 1 bool || log probe 1 "$n" uno_import 0 bool
  docker exec "$n" sh -c 'DISPLAY=:1 xdotool search --name seed getwindowname' && log probe 1 "$n" xdotool_find 1 bool || log probe 1 "$n" xdotool_find 0 bool
  docker cp "$n":/tmp/s.png "$HERE/screenshot-calc.png" 2>/dev/null || true
  docker rm -f "$n" >/dev/null
}

# Stricter milestone: the Calc document has PAINTED (root screenshot below the
# title bar shows >500 distinct colours: toolbar icons + cell text rendered;
# all-black = 1 colour, fully painted sheet = ~1472). Timed inside the container as seconds since
# PID 1 started (/proc/1/stat starttime vs /proc/uptime), polling ~0.2 s.
cmd_paint() {
  local N=${1:-5} i n r
  for i in $(seq 1 "$N"); do
    n=fleetprobe-paint-$i; start_one "$n"
    r=$(docker exec "$n" sh -c 'hz=$(getconf CLK_TCK); s=$(awk "{print \$22}" /proc/1/stat)
      while :; do up=$(awk "{print \$1}" /proc/uptime); el=$(awk -v u=$up -v s=$s -v h=$hz "BEGIN{printf \"%.2f\", u - s/h}")
        if DISPLAY=:1 import -window root /tmp/p.png 2>/dev/null && [ "$(convert /tmp/p.png -crop 1280x780+0+20 -format "%k" info:)" -gt 500 ]; then echo $el; break; fi
        awk -v e=$el "BEGIN{exit !(e>120)}" && { echo null; break; }; sleep 0.2; done')
    log paint 1 "$n" calc_painted_invm "$r" s "since PID1 start: root screenshot below title bar >500 distinct colours (toolbar+cells rendered)"
    echo "paint $i: ${r}s"
    docker rm -f "$n" >/dev/null
  done
}

cmd_cleanup() {
  docker ps -aq --filter name=fleetprobe- | xargs -r docker rm -f
  docker rmi "$IMG" 2>/dev/null || true
}

case "${1:-}" in
  build) cmd_build ;; cold) cmd_cold "${2:-5}" ;; scale) cmd_scale ;;
  probes) cmd_probes ;; paint) cmd_paint "${2:-5}" ;; cleanup) cmd_cleanup ;;
  *) echo "usage: $0 build|cold [N]|scale|probes|cleanup" >&2; exit 2 ;;
esac
