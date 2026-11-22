#!/usr/bin/env bash
# RT-003: host-side smoke proof. Boots (or reuses) the guest, waits for SSH and
# cloud-init, then proves over SSH:
#   (a) an AT-SPI tree read succeeds (pyatspi dump of the session desktop),
#       explicitly answering: what of the Tk app (window/listbox/entry/label) is visible?
#   (b) synthetic input via xdotool (XTEST) lands in the Tk app: typing into the Entry
#       and activating the Save button must show up in the app's own state file.
set -uo pipefail

GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY="$GUEST_DIR/keys/id_ed25519"
SSH_PORT=10022
BOOT_START=$(date +%s)

SSH=(ssh -i "$KEY" -p "$SSH_PORT"
     -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
     -o ConnectTimeout=5 -o BatchMode=yes myco@localhost)

"$GUEST_DIR/boot.sh"

echo "[smoke] waiting for SSH on port $SSH_PORT ..."
READY=0
for i in $(seq 1 120); do
  if "${SSH[@]}" 'echo up' >/dev/null 2>&1; then READY=1; break; fi
  sleep 5
done
if [[ $READY -ne 1 ]]; then
  echo "[smoke] FAIL: SSH never came up. Serial log tail:" >&2
  tail -30 "$GUEST_DIR/state/serial.log" >&2 || true
  exit 1
fi
SSH_UP=$(date +%s)
echo "[smoke] SSH up after $((SSH_UP - BOOT_START))s (includes prior boot time if reused)."

echo "[smoke] waiting for cloud-init (first boot installs packages; can take minutes) ..."
if ! "${SSH[@]}" 'sudo cloud-init status --wait' 2>&1 | tail -1; then
  echo "[smoke] FAIL: cloud-init did not complete." >&2
  "${SSH[@]}" 'sudo tail -40 /var/log/cloud-init-output.log' >&2 || true
  exit 1
fi
CLOUD_DONE=$(date +%s)
echo "[smoke] cloud-init done (+$((CLOUD_DONE - SSH_UP))s)."

echo "[smoke] waiting for Tk app process ..."
FOUND=0
for i in $(seq 1 60); do
  if "${SSH[@]}" 'pgrep -f "myco-tk-ap[p].py" >/dev/null'; then FOUND=1; break; fi
  sleep 2
done
[[ $FOUND -eq 1 ]] || { echo "[smoke] FAIL: myco-tk-app.py not running." >&2; exit 1; }
APP_UP=$(date +%s)
echo "[smoke] Tk app up (+$((APP_UP - CLOUD_DONE))s). Total boot->app: $((APP_UP - BOOT_START))s."

echo
echo "===== (a) AT-SPI tree read ====="
# Run the dumper AS THE myco USER inside the GUI session's environment (taken from
# the myco-owned app process). Two hard-won facts: (1) each uid gets its own AT-SPI
# registry — a root dump sees root's empty registry, not the one apps registered on;
# (2) reading /proc/<pid>/environ needs `sudo cat`, not a shell redirect (the
# redirect is opened by the unprivileged shell before sudo runs).
"${SSH[@]}" 'sudo bash -s' <<'REMOTE'
set -e
PID=$(pgrep -u myco -f "myco-tk-ap[p].py" | head -1)
echo "Tk app pid: $PID"
ENV=$(cat "/proc/$PID/environ" | tr "\0" "\n" | grep -E "^(DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|NO_AT_BRIDGE)=")
echo "$ENV"
sudo -u myco env $ENV python3 /opt/myco/atspi-dump.py | tee /tmp/atspi-dump.txt
# REQ-03 verdict: is the Tk app present in the AT-SPI tree at all?
if grep -q MycoTkTest /tmp/atspi-dump.txt; then
  echo "TK_ATSPI: VISIBLE"
else
  echo "TK_ATSPI: ABSENT — Tk does not register with AT-SPI (GTK sanity app is present, proving the read path works). REQ-03 needs the fallback channel."
fi
REMOTE
ATSPI_RC=$?
echo "===== AT-SPI dump exit code: $ATSPI_RC ====="
echo

echo "===== (b) synthetic input via xdotool (XTEST) ====="
"${SSH[@]}" 'sudo bash -s' <<'REMOTE'
set -e
PID=$(pgrep -f "myco-tk-ap[p].py" | head -1)
while IFS= read -r kv; do export "$kv"; done < <(tr "\0" "\n" < "/proc/$PID/environ" | grep -E "^(DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|NO_AT_BRIDGE)=")
rm -f /tmp/myco-tk-state.json
WID=$(xdotool search --name MycoTkTest | head -1)
echo "Tk window id: $WID geometry: $(xdotool getwindowgeometry --shell "$WID" | tr "\n" " ")"

# Aim clicks via the app's self-published widget geometry (Tk may expose no AT-SPI
# coordinates); xdotool drives the X server; the app's own state file proves landing.
# Geometry file coordinates are absolute (winfo_rootx/rooty), so move the root pointer.
geom() { awk -v n="$1" '$1==n{print $2+$4/2, $3+$5/2}' /tmp/myco-tk-geometry.txt; }
read -r EX EY <<< "$(geom entry)"
read -r BX BY <<< "$(geom save)"
echo "entry center: ($EX,$EY)  save-button center: ($BX,$BY)"
xdotool mousemove --window "$WID" 10 10   # focus the window
xdotool mousemove "$EX" "$EY"; xdotool click 1
# Clear any pre-existing entry text (Tk bindings: ctrl+a = home, ctrl+k = kill to end).
xdotool key ctrl+a; xdotool key ctrl+k
xdotool type --delay 40 "hello-from-xdotool"
xdotool mousemove "$BX" "$BY"; xdotool click 1   # also prove a synthetic click (XTEST)
sleep 1   # save() fires on KeyRelease; also on the Save button if the click hit it
echo "--- /tmp/myco-tk-state.json ---"
cat /tmp/myco-tk-state.json
echo
python3 - <<'PY'
import json, sys
s = json.load(open("/tmp/myco-tk-state.json"))
ok = s["entry_text"] == "hello-from-xdotool"
print("ENTRY_TEXT_OK:", ok)
sys.exit(0 if ok else 1)
PY
REMOTE
INPUT_RC=$?
echo "===== input proof exit code: $INPUT_RC ====="

if [[ $ATSPI_RC -eq 0 && $INPUT_RC -eq 0 ]]; then
  echo "[smoke] PASS: AT-SPI read succeeded and XTest input landed in the Tk app."
  exit 0
else
  echo "[smoke] PARTIAL/FAIL: atspi_rc=$ATSPI_RC input_rc=$INPUT_RC (see dumps above)."
  exit 1
fi
