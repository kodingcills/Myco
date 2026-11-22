import json
import os
from pathlib import Path
import sys
import time

shared = Path("/dev/shm/myco-discovery")
marker = os.environ.get("MYCO_STATE_MARKER")

if sys.argv[1] == "plant":
    shared.mkdir(exist_ok=True)
    (shared / "marker").write_text("memory\n")
    (shared / "pid").write_text(str(os.getpid()))
    counter = 0
    with (shared / "heartbeat").open("w", buffering=1) as heartbeat:
        while True:
            heartbeat.write(f"{time.time_ns() // 1_000_000}\n")
            if counter % 5 == 0:
                temporary = shared / "counter-next"
                temporary.write_text(str(counter // 5))
                temporary.replace(shared / "counter")
                print(f"Myco discovery RAM counter {counter // 5}", flush=True)
            time.sleep(0.02)
            counter += 1
elif sys.argv[1] == "gap":
    # Largest gap (ms) between consecutive 20 ms heartbeats with timestamps inside [from, to] (guest clock).
    lo, hi = int(sys.argv[2]), int(sys.argv[3])
    stamps = [int(line) for line in (shared / "heartbeat").read_text().split() if line.isdigit()]
    window = [t for t in stamps if lo <= t <= hi]
    gaps = [b - a for a, b in zip(window, window[1:])]
    print(json.dumps({"beats": len(window), "maxGapMs": max(gaps) if gaps else None}))
else:
    def read(path):
        return path.read_text().strip() if path.is_file() else None

    pid = read(shared / "pid")
    counter = read(shared / "counter")
    environ = Path(f"/proc/{pid}/environ")
    try:
        live_marker = b"MYCO_STATE_MARKER=discovery" in environ.read_bytes().split(b"\0")
    except OSError:
        live_marker = False
    time.sleep(0.23)
    print(json.dumps({
        "boot": read(Path("/proc/sys/kernel/random/boot_id")),
        "disk": read(Path.home() / ".myco-discovery-disk"),
        "tmpfs": read(shared / "marker"),
        "processMarker": live_marker,
        "counter": counter,
        "later": read(shared / "counter"),
    }))
