# Row 8 operator report 4 — bounded re-run (§4, §5, §6 --limit 4, scorecard check)

- Clone: `git clone https://github.com/kodingcills/Myco /private/tmp/row8-step1b` (full, no --depth), 2026-11-25T08:53:12Z
- HEAD: `6ad605ffff974c4d9677866453e05daedf6c4ce5`
- Host: node v24.4.1, pnpm 10.34.9, `~/VMs/myco-win11/ssh_config` exists, host scripts present.
- Pre-check 08:53:33Z (load 2.64): `scripts/vm-state.sh` → `GUEST RUNNING: argv:yes port:listening utm:started` exit 0; `vm.sh status` → `started`; `lsof /tmp/myco-win11.vm.lock || echo free` → `free`. Free + running = normal state (§2).

## Steps

### Step 0 — §1.2 setup (only what the steps need)
- Command: `pnpm install --frozen-lockfile`
- Start 2026-11-25T08:53:41Z, end 08:53:42Z, wall 1 s, 1-min load at start 2.39
- Result: `Done in 918ms`, plus a pnpm warning box `Ignored build scripts: esbuild@0.28.2. Run "pnpm approve-builds"…` (J1). `pnpm exec tsx --version` → tsx v4.23.15, works.
- Expected vs actual: runbook expects install then four green commands; I ran install only (J2).

### Step 1a — §3.1 cold reset (required before a deploy: §3 "reset first, deploy second"; §6 F20 "on a row-8 reproduction run, never" skip)
- Gate: `lsof /tmp/myco-win11.vm.lock || echo free` → `free`
- Command: `scripts/reset-trial-vm.sh`
- Start 2026-11-25T08:53:58Z, end 08:57:03Z, wall 185 s, 1-min load at start 2.40
- Result: exit 0, `reset-trial-vm: ready on 'clean-base'`
- Expected vs actual: expected that line in the 180–280 s planning range; actual 185 s. PASS.

### Step 1 — §4 deploy
- Private token path per §4 G25 (J3): `mkdir -p -m 700 runs/token-"$USER"`, then export MYCO_TOKEN_OUT as `$PWD/runs/token-$USER/agent-token` (the runbook's two lines). A command that printed that variable (to record the path) was BLOCKED by the host secret guard (J4); I dropped the print and did not work around it. (A later report append quoting that command verbatim was blocked too.)
- Gate: `lsof … || echo free` → `free`
- Command: `agent/bootstrap/deploy-to-vm.sh` (output to `runs/deploy.log`)
- Start 2026-11-25T08:57:21Z, end 08:59:41Z, wall 140 s, 1-min load at start 7.33
- Result: exit 0. `==> verified 13 files on the guest against the source (sha256)` (clean first attempt, no retry line), `==> wrote the fresh token to /private/tmp/row8-step1b/runs/token-tofuinparis/agent-token (mode 600)`, `==> ping verified:` `{"ok": true, "id": 1, "result": {"agent_version": "0.1.0", "session_id": "[REDACTED]", "backend": "windows"}}`, `DEPLOY OK`, then the token/tunnel/ops hint lines.
- Expected vs actual: matches the expected tail, in the 100–420 s range. Extra, unmentioned output: three OpenSSH post-quantum warnings (J5); no pip output visible although §4 says the deploy installs pywin32/comtypes/uiautomation (J6). PASS.

### Step 2 — §5 desktop proof
- Gate: `lsof … || echo free` → `free`; `unset MYCO_AGENT_TOKEN` (§4)
- Command: `pnpm exec tsx src/integration/session-info.ts --token-file /private/tmp/row8-step1b/runs/token-tofuinparis/agent-token` (the deploy's private path, via a shell variable)
- Start 2026-11-25T09:00:07Z, end 09:00:12Z, wall 5 s, 1-min load at start 5.90
- Result: exit 0, stdout `{"session_id":1,"window_station":"WinSta0","desktop":"Default","user":"MYCO-WIN11\\myco"}`, stderr empty; afterwards `lsof -iTCP:8765 -sTCP:LISTEN` → nothing listening.
- Expected vs actual: identical to the expected JSON, exit 0. PASS.

### Step 3 — §6.1 clean check, then §6 generator proof (`--limit 4`)
- §6.1: wrote `runs/row8-host/guest-clean.ps1` verbatim from the runbook, gate `free`, `scp -q -F ~/VMs/myco-win11/ssh_config runs/row8-host/guest-clean.ps1 myco-win11:'C:/myco/guest-clean.ps1'` (exit 0), `vssh 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\myco\guest-clean.ps1'` (exit 0) → printed nothing. 09:00:20–09:00:33Z, load 4.97. Clean guest (fresh from clean-base), no cleanup needed.
- Gate (§6.2): `free`; `unset MYCO_AGENT_TOKEN`
- Command: `pnpm exec tsx src/integration/run-live.ts --mode values --limit 4 --runs-dir runs/s6-subset --token-file /private/tmp/row8-step1b/runs/token-tofuinparis/agent-token` (runbook's own subset example, J7)
- Start 2026-11-25T09:00:40Z, end 09:03:42Z, wall 182 s, 1-min load at start 5.21
- Result: exit 0; stdout a JSON array of 4 rows, all `"status": "verified"`:
  - name `REVISED-908578` — cell B39 (EMP-0038) persisted, 68.2 s
  - qty `9733` — cell C24 (EMP-0023) persisted, 38.2 s
  - joined `2024-05-28` — cell D60 (EMP-0059) persisted, 37.6 s
  - salary `$12458.13` — cell E10 (EMP-0009) persisted, 37.5 s
  - stderr: `agent ping ok: 0.1.0 session <hex>` only.
- Expected vs actual: the §6 `--limit N` rule is "a JSON array of N rows, every one verified, exit code 0". Actual: 4 rows, 4 verified, exit 0. PASS (evidence for those 4 sets only; it does not replace the 20/20).

### Step 4 — scorecard check
- Command: `python3 scripts/scorecard-check.py` (defaults: `--doc docs/m1-scorecard.md`, sub-checks on), from the clone root; output in `runs/scorecard-check.out` (202 lines).
- Start 2026-11-25T09:03:57Z, end 09:03:57Z, wall <1 s (re-timed: real 0.38 s), 1-min load at start 4.95
- Result: exit 0. Last two lines:
  - `120 ok, 0 mismatch, 0 unattributed, 40 not machine-checked, 9 artifact-consistency, 1 skipped, 16 sections swept clean, 49 identifier words skipped; 2 sections out of scope`
  - `SCORECARD CHECK OK: every number in the in-scope sections matches its committed artifact or is listed as unchecked`
  - Sub-checks: `check-scorecard-links.py — exit 0`, `scorecard-viewer-links.py --check — exit 0`. The 1 skipped: `row 8 toolchain files — row 8 no longer quotes the toolchain file count (the tree has 18)`.
- `git status --short` empty before and after (only gitignored `node_modules/`, `runs/`, `scripts/__pycache__/`, `viewer/node_modules/`). No checked file modified.
- Expected vs actual: the script's docstring says it exits 1 on any mismatch, unattributed token or sub-check failure; actual exit 0 with 0/0. PASS. See J8, J10.

## J-findings

- **J1 (§1.2).** "`pnpm install --frozen-lockfile`" — Expected: four green commands. Actual: install prints a warning box `Ignored build scripts: esbuild@0.28.2. Run "pnpm approve-builds"…`, which the runbook doesn't mention. I had to decide whether to approve the build. I did not run `approve-builds`, because `tsx` worked (v4.23.15) and every later step passed without it.
- **J2 (§1.2 vs scope).** "do it before any VM work so a later failure is unambiguous" — the runbook asks for typecheck, lint, test and build before VM work. My scope said §1 already passed and to do only the setup the steps need. I decided to run `pnpm install` only: `pnpm test` fills `runs/` with fixtures and loads the host. I skipped typecheck, lint, test and build.
- **J3 (§4, G25).** "When several operators share the Mac, give each a private path" — nothing in the repo tells an operator whether the Mac is shared right now. I assumed it might be (other operators' clones exist under /private/tmp) and used the private path `runs/token-$USER/agent-token`.
- **J4 (§1.3 / §4 vs the host guard).** "`MYCO_TOKEN_OUT` (`~/.myco-token`, …; a path, never a secret)" — the host secret guard still BLOCKS any command that prints `$MYCO_TOKEN_OUT`, because the name contains TOKEN. A later report append that only quoted that command as text was blocked too. The runbook calls the variable a harmless path and doesn't warn about this. I dropped the print, recorded the path from the deploy's own `==> wrote the fresh token to …` line, and did not work around the guard.
- **J5 (§4).** "Expected tail (the last lines it prints)" — the deploy also printed three OpenSSH warnings (`** WARNING: connection is not using a post-quantum key exchange algorithm … See https://openssh.com/pq.html`) that neither the expected output nor the failure table mentions. I decided they are harmless client noise (the copy verified and the ping passed) and continued.
- **J6 (§4).** "installs pywin32/comtypes/uiautomation into LibreOffice's own Python" and the failure table's "re-run the deploy and read its pip output" — the deploy log shows no pip output at all. So I could not confirm from the output that the install happened, or tell whether "read its pip output" refers to something hidden. I relied on §5 and §6 passing as indirect evidence that the deps are present.
- **J7 (§6).** The §6 command uses `--runs-dir runs/s6-final`, while the subset paragraph gives `--limit 4 --runs-dir runs/s6-subset` as "for example". I had to choose. I used the subset example (`runs/s6-subset`) so a subset is never mistaken for the 20-row evidence dir.
- **J8 (scorecard check is missing from the runbook).** `grep -n scorecard-check docs/eval-runbook.md` finds nothing. The runbook never names `scripts/scorecard-check.py`, how to run it, or what its pass output is. I took the invocation (no arguments, defaults) and the pass rule (exit 0, 0 mismatch / 0 unattributed / sub-checks green) from the script's docstring. The script prints two closing lines (a counts line and `SCORECARD CHECK OK: …`), and neither is named "the summary line". I recorded both and treated the counts line as the summary.
- **J9 (§4/§5/§6, "from the same shell").** "pass `--token-file "$MYCO_TOKEN_OUT"` in §5, §6 and §7, from the same shell" — an agent's tool calls don't keep one shell, so the exported variable is gone by §5. I re-derived the same path in each call (`TF="$PWD/runs/token-$USER/agent-token"`) instead of the variable, and passed it as `--token-file "$TF"`.
- **J10 (scorecard vs repo).** The check's own output (line 117) says: `unchecked row 8 validate-live falsely reports ALL OK on 0 files (TIF-223) — … stale since #433 fixed TIF-223 (the row still says it)`. So the scorecard's row 8 carries a claim the checker knows is stale, and the check still exits 0, because unchecked claims never fail. I didn't modify anything (scope). I'm recording it as a contradiction that someone has to settle. It didn't change my verdict, because the script's documented pass rule is met.
- **J11 (§6, after the run).** §6 doesn't say whether to re-run the §6.1 check or the cleanup after a passing `--limit N` run, or to leave the guest as it is for the next operator. I left the guest as `run-live` left it and didn't run cleanup. The next operator's §6.1 check is what protects them.

## Final table

| step | result | wall | findings |
|---|---|---|---|
| §1.2 setup (install only) | PASS | 1 s | J1, J2 |
| §3.1 cold reset (pre-deploy) | PASS, `ready on 'clean-base'` | 185 s | — |
| §4 deploy | PASS, `DEPLOY OK`, 13 files sha256-verified | 140 s | J3, J4, J5, J6, J9 |
| §5 desktop proof | PASS, exit 0, session 1 / WinSta0 / Default | 5 s | J9 |
| §6.1 clean check | clean (no output) | 13 s | — |
| §6 `--limit 4` | PASS, 4/4 verified, exit 0 | 182 s | J7, J9, J11 |
| scorecard check | PASS, exit 0, `120 ok, 0 mismatch, 0 unattributed, …` | <1 s | J8, J10 |
