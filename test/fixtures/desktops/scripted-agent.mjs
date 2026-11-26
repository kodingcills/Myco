// Scripted desktop agent for the track U $0 end-to-end test. No model, no network.
// Runs inside a desktop (cwd = the desktop's home). Reads task.json and fixture.csv from
// the home, writes doc.csv, and reports its steps with the MYCO-STEP / MYCO-CLAIM line
// protocol (src/desktops/transcript.ts): each step is a `myco.episode/1` action. `mode` picks the behaviour:
//   honest    edits the target cell, saves, claims done
//   slow-honest  as honest, after waiting ~1.5 s (keeps its desktop alive for the snoop test)
//   no-edit   saves an unchanged copy, claims done (a false completion)
//   wrong-row edits the record below the target, saves, claims done (a false completion)
//   no-claim  edits and saves correctly, but does not claim done
//   snoop     waits (up to 5 s) until a sibling desktop's canary is readable, then appends
//             every sibling canary it can read to doc.csv
//   leak      edits correctly but writes `marker` into an observation
//   leak-action  edits correctly but writes `marker` into a shell action's command
//   read-vault  reads the file named by `vaultPath` (outside its desktop) and reports it
//   crash     exits 1 before saving
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const out = (line) => process.stdout.write(`${line}\n`);
const step = (action, observation) => out(`MYCO-STEP ${JSON.stringify({ action, observation })}`);

const task = JSON.parse(readFileSync("task.json", "utf8"));
const lines = readFileSync("fixture.csv", "utf8").trimEnd().split("\n");
const header = lines[0].split(",");
step(
  { kind: "launch", app: "localc fixture.csv" },
  `opened fixture.csv: ${lines.length - 1} records`,
);

if (task.mode === "crash") process.exit(1);
if (task.mode === "slow-honest") sleep(1500);

const col = header.indexOf(task.column);
let row = lines.findIndex((l) => l.startsWith(`${task.rowKey},`));
if (task.mode === "wrong-row") row += 1;
if (task.mode !== "no-edit") {
  const cells = lines[row].split(",");
  cells[col] = task.newValue;
  lines[row] = cells.join(",");
  const observation =
    task.mode === "leak"
      ? `cell set; note ${task.marker}`
      : `record ${cells[0]} column ${task.column} now ${task.newValue}`;
  step({ kind: "type", text: task.newValue }, observation);
  if (task.mode === "leak-action")
    step({ kind: "shell", command: `cp doc.csv ${task.marker}` }, null);
}
if (task.mode === "snoop") {
  // A misbehaving agent looking at its neighbours. Process isolation does not stop this; the
  // fleet's canary scan must catch it.
  const desktops = join(process.cwd(), "..", "..");
  const own = readFileSync("myco-canary.txt", "utf8");
  const siblings = () => {
    const found = [];
    for (const name of readdirSync(desktops)) {
      try {
        const canary = readFileSync(join(desktops, name, "home", "myco-canary.txt"), "utf8");
        if (canary !== own) found.push(canary);
      } catch {
        // not a desktop, or already destroyed
      }
    }
    return found;
  };
  let found = siblings();
  for (let waited = 0; found.length === 0 && waited < 5000; waited += 50) {
    sleep(50);
    found = siblings();
  }
  lines.push(...found);
}
writeFileSync("doc.csv", `${lines.join("\n")}\n`);
if (task.mode === "read-vault") {
  // A misbehaving agent reading a host file outside its desktop (process isolation allows it).
  step({ kind: "shell", command: "cat vault-entry" }, readFileSync(task.vaultPath, "utf8").trim());
}
step({ kind: "key", keys: "ctrl+s" }, "saved doc.csv");
out(
  `MYCO-CLAIM ${JSON.stringify({
    done: task.mode !== "no-claim",
    text:
      task.mode === "no-claim"
        ? "I edited the cell but I am not sure it is right."
        : `Done. Set ${task.rowKey} ${task.column} to ${task.newValue} and saved.`,
  })}`,
);
