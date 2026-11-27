#!/usr/bin/env bash
# Fleet measurement for the public R1 (#741; lead rulings 14:05Z and 14:37Z). Re-runnable.
# Extends docs/research/experiments/fleet-first-numbers-2026-11-27/measure.sh (#744) to the
# real fleet image (Dockerfile next to this file: OSWorld's controller server, the AT-SPI
# stack, LibreOffice with the GTK3 VCL plugin, pyautogui and python-xlib).
#
# Measures, labelled with the host it ran on (HOST_LABEL is required):
#   build              image size and digest
#   cold [N]           N fresh desktops one at a time: docker run -> controller answers a
#                      screenshot -> AT-SPI tree answers -> Calc launched through the controller
#                      is visible in the AT-SPI tree; then RAM per desktop with Calc open (+10 s)
#   scale              incremental parallel scale-up under the host memory guard; at each step,
#                      RAM per desktop idle and (ACTIVE=1, the default) while every desktop is
#                      actively driven
#   active [K]         K desktops driven at once for DRIVE_S seconds by scripted pyautogui
#                      actions through the controller's /execute (no model): action latency and
#                      RAM while driven
#   guard-check SWAP_FREE_MIB FREE_PCT STEP_ADD_MIB   the guard's decision only (tests use it)
#   cleanup            remove every container named myco-fleet-measure-* and nothing else
#
# Host memory guard (14:37Z, same as #744): stop before a step when host swap free < 300 MB,
# host free memory < 20%, or the step would add more than ~1 GiB; also keep the docker VM
# (colima) out of OOM. Creates and removes only containers named myco-fleet-measure-*.
# Output: $OUT_DIR/raw.jsonl, one JSON object per measurement, each with the host label.
#
#   HOST_LABEL="M4 Pro 24 GiB, colima 2 CPU / 4 GiB" IMAGE=myco-osworld-desktop:local \
#     bash src/benchmark/upstream/fleet/measure.sh cold 5
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${IMAGE:-myco-osworld-desktop:local}
OUT_DIR=${OUT_DIR:-$PWD/fleet-measure-out}
RAW=$OUT_DIR/raw.jsonl
PREFIX=myco-fleet-measure-
MEMORY=${MEMORY:-2g}
SHM=${SHM:-512m}
READY_TIMEOUT=${READY_TIMEOUT:-180}
DRIVE_S=${DRIVE_S:-60}
ACTIVE=${ACTIVE:-1}
STEPS=(1 2 4 6 8 10 12 16 20 24)
MAX_STEP_ADD_MIB=1024      # host memory guard: no step may add more than ~1 GiB
HOST_SWAP_FREE_MIN_MIB=300 # host memory guard
HOST_FREE_PCT_MIN=20       # host memory guard
VM_AVAIL_MIN_MIB=400       # keep the docker VM out of swap/OOM
# One scripted round of OSWorld-style actions (pyautogui through the controller; no model):
# select A1, type a value, move, type a formula, undo. Run as DesktopEnv runs actions.
DRIVE_CMD="import pyautogui, time; pyautogui.FAILSAFE = False; pyautogui.click(400, 300); pyautogui.hotkey('ctrl', 'home'); pyautogui.write('42', interval=0.02); pyautogui.press('enter'); pyautogui.write('=A1*2', interval=0.02); pyautogui.press('enter'); pyautogui.hotkey('ctrl', 'z'); pyautogui.hotkey('ctrl', 'z'); print('MYCO_DRIVE_OK')"

# The guard's decision, pure: prints OK or "STOP: <reason>"; exit 0 when OK.
guard_decide() { # swap_free_mib free_pct add_mib
  local sw=${1%.*} pct=${2%.*} add=${3%.*}
  if [ "$sw" -lt "$HOST_SWAP_FREE_MIN_MIB" ]; then echo "STOP: host swap free ${sw} MiB < ${HOST_SWAP_FREE_MIN_MIB} MiB"; return 1; fi
  if [ "$pct" -lt "$HOST_FREE_PCT_MIN" ]; then echo "STOP: host free memory ${pct}% < ${HOST_FREE_PCT_MIN}%"; return 1; fi
  if [ "$add" -gt "$MAX_STEP_ADD_MIB" ]; then echo "STOP: step would add ~${add} MiB > ${MAX_STEP_ADD_MIB} MiB"; return 1; fi
  echo OK
}

if [ "${1:-}" = guard-check ]; then guard_decide "${2:?}" "${3:?}" "${4:?}"; exit $?; fi
if [ -z "${HOST_LABEL:-}" ]; then echo "MEASURE_HOST_UNLABELLED: set HOST_LABEL to the machine and docker VM this runs on" >&2; exit 2; fi
mkdir -p "$OUT_DIR"

now() { # seconds with sub-second resolution
  if [ -n "${EPOCHREALTIME:-}" ]; then echo "${EPOCHREALTIME/,/.}"; else perl -MTime::HiRes=time -e 'printf("%.3f\n", time)'; fi
}
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f", b - a}'; }
json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
HOST_OS=$(uname -s); HOST_ARCH=$(uname -m)
DOCKER_CPUS=$(docker info --format '{{.NCPU}}' 2>/dev/null || echo 0)
DOCKER_MEM=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
log() { # phase k container metric value unit [note]
  printf '{"ts":"%s","host":"%s","hostOs":"%s","hostArch":"%s","dockerCpus":%s,"dockerMemBytes":%s,"image":"%s","phase":"%s","k":%s,"container":"%s","metric":"%s","value":%s,"unit":"%s","note":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$(json_str "$HOST_LABEL")" "$HOST_OS" "$HOST_ARCH" "$DOCKER_CPUS" "$DOCKER_MEM" \
    "$(json_str "$IMAGE")" "$1" "$2" "$3" "$4" "$5" "$6" "$(json_str "${7:-}")" >> "$RAW"
}

host_swap_free_mib() {
  if [ "$HOST_OS" = Darwin ]; then sysctl -n vm.swapusage | sed -E 's/.*free = ([0-9.]+)M.*/\1/'
  else awk '/^SwapFree:/{print int($2/1024)}' /proc/meminfo; fi
}
host_free_pct() {
  if [ "$HOST_OS" = Darwin ]; then memory_pressure -Q | sed -nE 's/.*percentage: ([0-9]+)%.*/\1/p'
  else awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print int(100*a/t)}' /proc/meminfo; fi
}
vm_avail_mib() { docker run --rm --entrypoint awk "$IMAGE" '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }

guard_ok() { # projected_add_mib
  local add=$1 sw pct av decision
  sw=$(host_swap_free_mib); pct=$(host_free_pct); av=$(vm_avail_mib)
  log guard 0 - host_swap_free "$sw" MiB "host swap free"
  log guard 0 - host_free_pct "$pct" pct "host free memory"
  log guard 0 - vm_mem_available "$av" MiB "docker VM /proc/meminfo MemAvailable"
  decision=$(guard_decide "$sw" "$pct" "$add") || { echo "$decision"; return 1; }
  [ $((av - add)) -ge "$VM_AVAIL_MIN_MIB" ] || { echo "STOP: docker VM avail ${av} MiB - ${add} MiB < ${VM_AVAIL_MIN_MIB} MiB"; return 1; }
  echo "guard OK: swap free ${sw} MiB, free ${pct}%, VM avail ${av} MiB, step adds ~${add} MiB"
}

start_one() { docker run -d --rm --name "$1" --memory="$MEMORY" --shm-size="$SHM" -p 127.0.0.1::5000 "$IMAGE" >/dev/null; }
port_of() { docker port "$1" 5000/tcp | head -1 | sed -E 's/.*:([0-9]+)$/\1/'; }
ctl() { # name method path [json]
  local p; p=$(port_of "$1")
  if [ "$2" = GET ]; then curl -s -m 30 "http://127.0.0.1:$p$3"
  else curl -s -m 130 -H 'Content-Type: application/json' -d "$4" "http://127.0.0.1:$p$3"; fi
}
screenshot_ok() { local p; p=$(port_of "$1"); [ -n "$p" ] && curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/screenshot" | grep -q '^200$'; }
a11y_has() { ctl "$1" GET /accessibility 2>/dev/null | grep -q "$2"; }
launch_calc() { ctl "$1" POST /setup/launch '{"command": ["libreoffice", "--calc"], "shell": false}' >/dev/null; }

wait_for() { # timeout_s cmd... -> prints seconds waited or FAIL
  local t0 t; t0=$(now)
  while :; do
    if "${@:2}"; then elapsed "$t0" "$(now)"; return 0; fi
    t=$(now); awk -v a="$t0" -v b="$t" -v m="$1" 'BEGIN{exit !(b - a > m)}' && { echo FAIL; return 1; }
    sleep 0.25
  done
}

mem_of() { # name -> "statsMiB cgroupMiB"
  local s c
  s=$(docker stats --no-stream --format '{{.MemUsage}}' "$1" | awk '{v=$1; if (v~/GiB/){sub("GiB","",v); v*=1024} else {sub("MiB","",v)}; print v}')
  c=$(docker exec "$1" cat /sys/fs/cgroup/memory.current 2>/dev/null | awk '{printf "%.1f", $1/1048576}')
  echo "${s:-null} ${c:-null}"
}

# Bring one desktop up and record each milestone (host clock, from `docker run`).
bring_up() { # name phase k
  local n=$1 t0 shot a11y calc
  t0=$(now); start_one "$n"
  shot=$(wait_for "$READY_TIMEOUT" screenshot_ok "$n")
  a11y=$(wait_for "$READY_TIMEOUT" a11y_has "$n" "<desktop-frame")
  launch_calc "$n"
  calc=$(wait_for "$READY_TIMEOUT" a11y_has "$n" "soffice")
  log "$2" "$3" "$n" controller_ready "$( [ "$shot" = FAIL ] && echo null || echo "$shot")" s "docker run issued -> the controller's /screenshot returns 200"
  log "$2" "$3" "$n" a11y_ready "$( [ "$a11y" = FAIL ] && echo null || echo "$a11y")" s "after controller ready -> /accessibility returns an AT-SPI desktop tree"
  log "$2" "$3" "$n" calc_in_a11y "$( [ "$calc" = FAIL ] && echo null || echo "$calc")" s "Calc launched via /setup/launch -> its application node in the AT-SPI tree (GTK3 VCL plugin)"
  [ "$shot" != FAIL ] && [ "$a11y" != FAIL ] && [ "$calc" != FAIL ]
}

cmd_build() {
  docker build -t "$IMAGE" "$HERE"
  log build 0 - image_size "$(docker image inspect -f '{{.Size}}' "$IMAGE")" bytes "docker image inspect .Size"
  log build 0 - image_id "\"$(docker image inspect -f '{{.Id}}' "$IMAGE")\"" id "pin the pushed digest in the pre-registration's harness.provider.imageDigest"
}

cmd_cold() {
  local N=${1:-5} i n m
  for i in $(seq 1 "$N"); do
    n=${PREFIX}cold-$i
    bring_up "$n" cold 1 || log cold 1 "$n" failure 1 count "a milestone did not arrive within ${READY_TIMEOUT}s"
    sleep 10
    m=$(mem_of "$n")
    log cold 1 "$n" mem_stats "${m% *}" MiB "docker stats, Calc open, +10 s"
    log cold 1 "$n" mem_cgroup "${m#* }" MiB "cgroup v2 memory.current"
    echo "cold $i: mem ${m}"
    docker rm -f "$n" >/dev/null
  done
}

# Drive one desktop for DRIVE_S seconds; append "latency_s" lines to $2.
drive_one() { # name out_file
  local p end body t
  p=$(port_of "$1"); end=$(( $(date +%s) + DRIVE_S ))
  body=$(printf '{"command": ["python", "-c", "%s"], "shell": false}' "$(json_str "$DRIVE_CMD")")
  while [ "$(date +%s)" -lt "$end" ]; do
    t=$(curl -s -m 130 -o "$2.body" -w '%{time_total}' -H 'Content-Type: application/json' -d "$body" "http://127.0.0.1:$p/execute")
    if grep -q MYCO_DRIVE_OK "$2.body"; then echo "$t" >> "$2"; else echo "FAIL" >> "$2"; fi
  done
  rm -f "$2.body"
}

drive_all() { # k phase
  local k=$1 i tmp lat tot tc m s c ok fail
  tmp=$(mktemp -d)
  for i in $(seq 1 "$k"); do drive_one "${PREFIX}k-$i" "$tmp/$i" & done
  sleep $(( DRIVE_S / 2 ))
  tot=0; tc=0
  for i in $(seq 1 "$k"); do m=$(mem_of "${PREFIX}k-$i"); s=${m% *}; c=${m#* }
    tot=$(awk -v a="$tot" -v b="$s" 'BEGIN{printf "%.1f", a + (b == "null" ? 0 : b)}')
    tc=$(awk -v a="$tc" -v b="$c" 'BEGIN{printf "%.1f", a + (b == "null" ? 0 : b)}'); done
  wait
  cat "$tmp"/[0-9]* > "$tmp/all" 2>/dev/null || : > "$tmp/all"
  ok=$(grep -vc FAIL "$tmp/all"); fail=$(grep -c FAIL "$tmp/all")
  lat=$(grep -v FAIL "$tmp/all" | sort -n | awk '{a[NR]=$1} END{if (NR==0) print "null null"; else printf "%.3f %.3f", a[int((NR+1)/2)], a[int(NR*0.95+0.5)>0?int(NR*0.95+0.5):1]}')
  log "$2" "$k" - driven_actions_ok "$ok" count "scripted pyautogui rounds through /execute, ${DRIVE_S}s, all desktops at once"
  log "$2" "$k" - driven_actions_failed "$fail" count "rounds whose output lacked MYCO_DRIVE_OK"
  log "$2" "$k" - driven_latency_p50 "${lat% *}" s "curl time_total per round"
  log "$2" "$k" - driven_latency_p95 "${lat#* }" s "curl time_total per round"
  log "$2" "$k" - mem_total_stats_driven "$tot" MiB "sum docker stats over K, sampled mid-drive"
  log "$2" "$k" - mem_avg_stats_driven "$(awk -v t="$tot" -v k="$k" 'BEGIN{printf "%.1f", t / k}')" MiB "per desktop, driven"
  log "$2" "$k" - mem_total_cgroup_driven "$tc" MiB "sum memory.current over K, mid-drive"
  echo "K=$k driven: ok=$ok failed=$fail p50/p95=${lat} total=${tot} MiB"
  rm -rf "$tmp"
}

cmd_scale() {
  local per=${PER_MIB:-600} prev=0 k i fails tot m s avg
  for k in "${STEPS[@]}"; do
    guard_ok $(( (k - prev) * per )) || { log scale "$prev" - stop_reason 0 none "stopped by the host memory guard before K=$k"; break; }
    fails=0
    for i in $(seq $((prev + 1)) "$k"); do bring_up "${PREFIX}k-$i" scale "$k" > /dev/null 2>&1 & done
    wait
    for i in $(seq $((prev + 1)) "$k"); do a11y_has "${PREFIX}k-$i" soffice || fails=$((fails + 1)); done
    sleep 10
    tot=0
    for i in $(seq 1 "$k"); do m=$(mem_of "${PREFIX}k-$i"); s=${m% *}
      tot=$(awk -v a="$tot" -v b="$s" 'BEGIN{printf "%.1f", a + (b == "null" ? 0 : b)}'); done
    avg=$(awk -v t="$tot" -v k="$k" 'BEGIN{printf "%.1f", t / k}')
    log scale "$k" - failures "$fails" count "desktops without Calc in the AT-SPI tree"
    log scale "$k" - mem_total_stats_idle "$tot" MiB "sum docker stats over K, Calc open, idle"
    log scale "$k" - mem_avg_stats_idle "$avg" MiB "per desktop, idle"
    echo "K=$k idle: fails=$fails total=${tot} MiB avg=${avg} MiB"
    [ "$ACTIVE" = 1 ] && drive_all "$k" scale-active
    per=$(awk -v a="$avg" 'BEGIN{printf "%d", a * 1.15 + 1}')
    [ "$fails" -gt 0 ] && { log scale "$k" - stop_reason 0 none "failure at K=$k"; break; }
    prev=$k
  done
  log scale "$prev" - max_concurrency "$prev" desktops "largest K reached with every desktop up, under the guard"
}

cmd_active() {
  local k=${1:-2} i
  guard_ok $(( k * ${PER_MIB:-600} )) || { log active "$k" - stop_reason 0 none "stopped by the host memory guard"; return 1; }
  for i in $(seq 1 "$k"); do bring_up "${PREFIX}k-$i" active "$k" > /dev/null 2>&1 & done
  wait
  drive_all "$k" active
}

cmd_cleanup() { docker ps -aq --filter "name=$PREFIX" | xargs -r docker rm -f; }

case "${1:-}" in
  build) cmd_build ;;
  cold) cmd_cold "${2:-5}" ;;
  scale) cmd_scale; cmd_cleanup ;;
  active) cmd_active "${2:-2}"; cmd_cleanup ;;
  cleanup) cmd_cleanup ;;
  *) echo "usage: $0 build | cold [N] | scale | active [K] | guard-check SWAP FREE_PCT ADD | cleanup" >&2; exit 2 ;;
esac
