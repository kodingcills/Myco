#!/usr/bin/env bash
# Deploy and smoke-test myco-todo in an existing RT-020 Linux desktop.
set -euo pipefail
# TIF-158: the guest may run from a DIFFERENT checkout than this script, because
# `runtime/guest/state/` is gitignored and survives in only one worktree while
# the runner runs from another. Resolving the guest from this script's own path
# sent me to a worktree with no qemu.pid and refused a guest that was running
# (TIF-158). --guest-state points at the state dir the guest actually lives in.
usage() {
    echo "Usage: $0 --go [--guest-state <dir>] (inside the Coordinator-approved Linux window)" >&2
    echo "  --guest-state  directory holding qemu.pid/keys for the running guest" >&2
    echo "                 (default: <repo>/runtime/guest)" >&2
}
GO=0
GUEST_STATE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --go) GO=1 ;;
        # A trailing --guest-state with no value used to be swallowed by
        # "${2:-}" and silently fall back to the default guest — which is the
        # exact wrong-guest confusion this flag exists to prevent (TIF-158).
        --guest-state)
            [[ $# -ge 2 && -n "${2:-}" ]] || {
                echo "--guest-state needs a directory" >&2; exit 2; }
            GUEST_STATE="$2"; shift ;;

        *) usage; exit 2 ;;
    esac
    shift
done
[[ $GO -eq 1 ]] || { usage; exit 2; }

repo="$(cd "$(dirname "$0")/.." && pwd)"
guest="${GUEST_STATE:-$repo/runtime/guest}"
[[ -d "$guest" ]] || { echo "No guest state dir at $guest" >&2; exit 1; }
app="$repo/dogfood/apps/myco-todo/myco_todo.py"
pid="$(cat "$guest/state/qemu.pid")"
[[ "$pid" =~ ^[0-9]+$ ]]
qemu="$(ps -p "$pid" -o command=)"
[[ "$qemu" == *qemu-system-aarch64* && "$qemu" == *"$guest/state/myco-runtime-v0.qcow2"* ]] || {
    echo "No matching runtime Linux guest" >&2
    exit 1
}
ssh=(ssh -i "$guest/keys/id_ed25519" -p 10022 -o BatchMode=yes -o IdentitiesOnly=yes
     -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null myco@localhost)
"${ssh[@]}" 'test "$(uname -m)" = aarch64 && . /etc/os-release &&
    test "$ID:$VERSION_ID" = ubuntu:24.04 && test -r /run/myco/gui.env'
digest="$(shasum -a 256 "$app" | cut -d ' ' -f 1)"
"${ssh[@]}" "set -eu
    mkdir -p \$HOME/myco-todo
    temp=\$(mktemp \$HOME/myco-todo/upload.XXXXXX)
    trap 'rm -f \"\$temp\"' EXIT
    cat > \"\$temp\"
    printf '%s  %s\\n' '$digest' \"\$temp\" | sha256sum -c -
    mv \"\$temp\" \$HOME/myco-todo/myco_todo.py" < "$app"

"${ssh[@]}" bash -s <<'GUEST'
set -euo pipefail
set -a
source /run/myco/gui.env
set +a
app="$HOME/myco-todo/myco_todo.py"
python3 "$app" --self-test
todo_window() {
    # xdotool is in the guest image (x11-utils/xwininfo is not).
    xdotool search --onlyvisible --name '^myco-todo$' 2>/dev/null | sed -n 1p || true
}
if [[ -n "$(todo_window)" ]]; then
    echo "A myco-todo window is already open" >&2
    exit 1
fi
work="$(mktemp -d)"
python3 "$app" --store "$work/store.json" >"$work/app.log" 2>&1 &
app_pid=$!
cleanup() {
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
    rm -rf "$work"
}
trap cleanup EXIT
for attempt in {1..40}; do
    window="$(todo_window)"
    if [[ -n "$window" ]] && kill -0 "$app_pid" 2>/dev/null; then
        printf 'myco-todo visible (X11 window %s), installed at %s\n' "$window" "$app"
        exit 0
    fi
    kill -0 "$app_pid" 2>/dev/null || break
    sleep 0.5
done
cat "$work/app.log" >&2
echo "myco-todo did not expose a viewable X11 window; visible windows:" >&2
for w in $(xdotool search --onlyvisible --name '' 2>/dev/null); do
    printf '  %s: %s\n' "$w" "$(xdotool getwindowname "$w" 2>/dev/null)" >&2
done
exit 1
GUEST
