# The Linux path: run Myco's verify loop without our VM

Myco's claim is that an agent's "done" is worth nothing until the app's saved state
agrees. On the Windows path that needs our Windows 11 VM. This page shows the same loop
on any Linux machine. A real LibreOffice Calc edits a real spreadsheet and saves it,
headless. Myco's oracle then reads the saved file and returns `verified`, `refuted` or
`uncertain`.

You need no VM, no account, no API key and no model. The "agent" is a deterministic
script, so the run costs nothing and gives the same result every time.

Public CI runs this exact path on every pull request: the `linux path (ubuntu-latest)`
job in `.github/workflows/ci.yml` (TIF-269, M2-06).

---

## 1. Prerequisites

- Linux (tested on Ubuntu 24.04 with LibreOffice 24.2, and on the GitHub `ubuntu-latest` runner with LibreOffice 26.2).
- `git`, Node 24 or later, pnpm 10.
- LibreOffice Calc and its Python-UNO bridge. On Debian or Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends libreoffice-calc python3-uno
```

`python3-uno` installs the bridge for the system Python, `/usr/bin/python3`. If
`python3` on your `PATH` is a different interpreter (pyenv, conda, a CI tool cache),
point Myco at the system one: `export MYCO_PYTHON=/usr/bin/python3`. If `soffice` is
not on your `PATH`, set `MYCO_SOFFICE` to its full path.

## 2. Install and check

```sh
git clone https://github.com/kodingcills/Myco.git myco
cd myco
pnpm install --frozen-lockfile
pnpm myco-linux --check
```

`--check` exits 0 and prints the two things it found:

```
soffice (soffice): LibreOffice 24.2.7.2 420(Build:2)
python-uno (python3 -c 'import uno'): ok
```

If either line says `NOT FOUND`, the command exits 1 and names the package to install.

## 3. Run the demo

```sh
pnpm myco-linux --demo --out /tmp/myco-linux
```

It runs five scenarios on one task: set record `EMP-0007`, column `name`, to
`REVISED-269269`, and save. Each scenario takes about 1.5 s; the whole demo takes about
8 s. Each scenario prints three sections: what the agent claimed, what the saved file
holds, and the verdict. This is the false completion:

```
== skips-save — the agent edits the cell, never saves, and says it saved (false completion)
1. Claim (what the agent said)
   Done. I set record EMP-0007, column name, to "REVISED-269269" and saved the file.
   (what it actually did: typed "REVISED-269269" into B8; did NOT save)
   (Calc showed "REVISED-269269" in B8 before closing)
2. Observed saved state (read from saved.xlsx, not from the agent)
   cell B8: expected "REVISED-269269", saved "Enzo Kaur"
3. Verdict
   REFUTED
   - cell B8 expected "REVISED-269269" (record EMP-0007, column name) but …/skips-save/saved.xlsx has "Enzo Kaur"
   FALSE COMPLETION CAUGHT: the agent said done and the saved file disagrees.
```

The screen showed the new value, and the agent said it saved. The file on disk still
holds the original name, so the verdict follows the file. The demo ends with a summary,
and exits 0 only if every scenario produced its expected verdict:

```
Summary
  PASS  honest           expected verified  got verified
  PASS  skips-save       expected refuted   got refuted
  PASS  wrong-row        expected refuted   got refuted
  PASS  corrupt-content  expected refuted   got refuted
  PASS  corrupt-bytes    expected uncertain got uncertain

all 5 scenarios produced their expected verdict
```

| Scenario | What happens | Verdict |
|---|---|---|
| `honest` | The agent types the value into the right cell and saves | `verified` |
| `skips-save` | The agent types the value, never saves, and says it saved | `refuted` |
| `wrong-row` | The agent types the value one record lower and saves | `refuted` |
| `corrupt-content` | An honest save, then the saved cell's value is overwritten in the file | `refuted` |
| `corrupt-bytes` | An honest save, then the file is cut to half its length | `uncertain` |

Every agent makes the same claim, word for word, whatever it actually did. The claim
carries no information, so it cannot be the verdict.

`uncertain` means "could not look". A file that cannot be opened is neither proof that
the edit is missing nor proof that it is there, so Myco does not guess either way
(ADR-0002). Either way, the agent's "done" is not accepted.

### One scenario at a time

```sh
pnpm myco-linux --agent skips-save --out /tmp/myco-linux
pnpm myco-linux --agent honest --corrupt content --out /tmp/myco-linux
pnpm myco-linux --agent wrong-row --out /tmp/myco-linux --json
```

A single run exits 0 when it produced a verdict, whichever verdict it was. It exits 1
when a prerequisite is missing or Calc could not be driven, and 3 on a usage error. A
caller that wants the verdict reads `oracle.verdict.status` from `--json`, not the exit
code.

## 4. What a run leaves on disk

Each scenario writes `<out>/<scenario>/`:

| File | Contents |
|---|---|
| `fixture.csv` | The deterministic fixture for seed `linux-path`, 133 records (the same generator and bytes as the Windows path) |
| `saved.xlsx` | The workbook after the agent's turn (and after the corruption, if any). The oracle reads this file |
| `record.json` | The task, fixture hash, the agent's plan and claim, the actuator's report, any corruption, the saved file's SHA-256 and the oracle's verdict |

### Run the oracle on a file yourself

`--verify <file>` runs only the oracle, for the demo task, on any workbook you give it.
After the demo:

```sh
cp /tmp/myco-linux/honest/saved.xlsx /tmp/mine.xlsx
pnpm myco-linux --verify /tmp/mine.xlsx          # VERIFIED

# change the cell yourself (here with the actuator; LibreOffice's GUI works too)
python3 scripts/linux/calc_actuator.py --doc /tmp/mine.xlsx --cell B8 --value "Someone Else"
pnpm myco-linux --verify /tmp/mine.xlsx          # REFUTED: saved "Someone Else"

head -c 1000 /tmp/myco-linux/honest/saved.xlsx > /tmp/cut.xlsx
pnpm myco-linux --verify /tmp/cut.xlsx           # UNCERTAIN: could not look
```

`--verify` exits 0 whatever the verdict, and `--json` prints the oracle's result as one
object. `test/linux/linux-path.test.ts` runs the same mutation proof: one saved file is
`verified`, then `refuted` once its value is corrupted, then `uncertain` once it is
truncated.

### Run the tests

```sh
MYCO_LINUX_PATH=1 pnpm exec vitest run test/linux
```

The real-Calc suite (`test/linux/linux-path.test.ts`) is opt-in, so a plain `pnpm test`
stays fast and does not depend on LibreOffice; it runs the hermetic
`test/linux/linux-unit.test.ts` only. CI's `linux path` job sets
`MYCO_LINUX_PATH_REQUIRED=1` instead, which also makes a missing prerequisite fail the
suite rather than skip it.

## 5. How it works

1. **Fixture.** The host generates the CSV from the seed (`src/tasks/fixture.ts`) and
   converts it to `.xlsx` with headless `soffice --convert-to xlsx`, using a throwaway
   profile. The Windows path does the same conversion inside the guest.
2. **Agent and actuator.** The scripted agent (`src/linux/agent.ts`) picks a cell, a
   value and whether to save. The actuator (`scripts/linux/calc_actuator.py`) opens the
   workbook in a headless Calc over Python-UNO and types the value through Calc's input
   path (`.uno:EnterString`), so Calc parses numbers, dates and currency as it would for
   a user's typing. It saves if told to, then closes.
3. **Oracle.** `src/linux/oracle.ts` reads only the saved file and the task. It converts
   the saved workbook to CSV with a headless soffice, forcing the Excel 2007 XML import
   filter so a file that is not a workbook is refused rather than read as text. It then
   applies the M1 family verifier (`calcRecordEditVerifier`) and CSV reader. The expected
   value comes from the seed and the task parameters, never from the agent. The oracle
   function has no parameter that could carry the agent's claim.

The oracle's comparison is the same code that check (c) of the Windows UNO verifier
(`src/verify/uno-verifier.ts`) runs over the file it reads back from the guest.

## 6. What this covers, and what it does not, compared with the Windows path

| | Windows path (our VM) | Linux path (this page) |
|---|---|---|
| App | LibreOffice Calc 26.8 on Windows 11, interactive | LibreOffice Calc from your distribution (24.2 on Ubuntu 24.04; 26.2 on the CI runner), headless |
| Fixture | Same seed → same CSV bytes, converted to `.xlsx` in the guest | Same seed → same CSV bytes, converted to `.xlsx` on the host |
| Who acts | Myco's guarded program through the UIA adapter, or a model-driven agent | A scripted, deterministic agent (no model) |
| How the edit lands | Keystrokes through Windows UI Automation | Calc's input path over UNO (`.uno:EnterString`); no GUI |
| Save | `ctrl+s` in the GUI | `store()` over UNO |
| Oracle, saved file | Check (c): headless CSV readback, M1 family verifier | The same readback and family verifier, run locally |
| Oracle, live document | Checks (a) live cell readback and (b) `isModified` | **Not covered.** The saved file is the only evidence |
| Guarded program (per-step pre/postconditions, ADR-0004) | Yes | **Not covered** |
| Runtime, guest agent, MCP | Yes | **Not covered** |
| Fault injection (M1 classes) | Yes | Two seeded corruptions of the saved file only |
| Artifacts | Schema-valid `trace.jsonl` and `result.json` | `record.json` (`myco.linux-run/1`), not schema-validated |
| Task families | calc-record-edit (plus others in Foundry) | calc-record-edit only |
| Cost | VM time; model calls when a model drives | None |

**What this proves:** on a machine with no access to our VM, Myco's saved-state oracle
returns the right three-valued verdict for a real Calc edit. It catches an agent that
says it saved when it did not. A saved file that disagrees with the task is `refuted`,
and a file it cannot read is `uncertain`, never `verified`.

**What it does not prove:** that the Windows path's live checks, guarded program or
fault handling work, that a model-driven agent behaves like the scripted ones, or
anything about the M2 gate over MCP (M2-02). The run records are not scorecard
evidence.

## 7. Troubleshooting

- **`python-uno … NOT FOUND`** but `python3-uno` is installed: your `python3` is not
  the system Python. Set `MYCO_PYTHON=/usr/bin/python3`.
- **A run hangs, then fails after about 90 s:** soffice did not start. Run
  `soffice --headless --version`. Each Myco call uses its own throwaway profile, so an
  open LibreOffice window does not block it.
- **`Warning: failed to launch javaldx`** on stderr is harmless. Calc does not need Java
  for this path.
- **Node older than 24:** pnpm warns about `engines`. The path was also run on Node 22,
  but only Node 24 is what CI uses.
