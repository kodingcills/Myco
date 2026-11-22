#!/usr/bin/env bash
# Deploy and smoke-test myco-todo in an existing RT-020 Linux desktop.
set -euo pipefail
if [[ "${1:-}" != --go || $# != 1 ]]; then
    echo "Usage: $0 --go (inside the Coordinator-approved Linux window)" >&2
    exit 2
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
guest="$repo/runtime/guest"
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
if xdotool search --all --onlyvisible --name '^myco-todo$' >/dev/null; then
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
if ! window="$(timeout 20s xdotool search --sync --all --onlyvisible --name '^myco-todo$' | sed -n '1p')"; then
    cat "$work/app.log" >&2
    exit 1
fi
test -n "$window"
kill -0 "$app_pid"
printf 'myco-todo visible (X11 window %s), installed at %s\n' "$window" "$app"
GUEST
