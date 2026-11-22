import { ArrowRight, CircleHelp, Minus, Upload } from "lucide-react";
import { useRef, useState } from "react";
import {
  type HeadToHeadDecision,
  type HeadToHeadReport,
  parseHeadToHead,
} from "../data/head-to-head.ts";
import { useViewer } from "../store.ts";
import { VerdictBadge } from "./VerdictBadge.tsx";

/** The decision maps onto the four display verdicts; only the row decides which. */
function display(
  decision: HeadToHeadDecision,
):
  | { label: "Verified"; subtype?: undefined }
  | { label: "Failed"; subtype?: undefined }
  | { label: "Unknown"; subtype?: undefined } {
  if (decision.status === "refused") return { label: "Unknown" };
  if (decision.row === "A-stands") return { label: "Verified" };
  if (decision.row === "myco-has-a-false-success") return { label: "Failed" };
  return { label: "Unknown" };
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function band(bounds: readonly [number, number] | null): string {
  return bounds === null ? "n/a" : `${pct(bounds[0])}–${pct(bounds[1])}`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div data-report-fact>
      <span className="type-micro text-text-secondary">{label}</span>
      <span className="type-data text-text-primary">{value}</span>
    </div>
  );
}

export function CompareOpen({
  onOpen,
}: {
  onOpen: (report: HeadToHeadReport, name: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  return (
    <div data-report-open>
      <p className="type-body text-text-secondary">
        Open a head-to-head report produced by the decision rule. It shows the pre-registered row,
        the paired trials, and the arms that could not run.
      </p>
      <button type="button" data-button="default" onClick={() => input.current?.click()}>
        <Upload aria-hidden="true" /> Open report…
      </button>
      <input
        ref={input}
        hidden
        type="file"
        accept=".json"
        aria-label="Head-to-head report"
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          try {
            const parsed = parseHeadToHead(JSON.parse(await file.text()));
            if (!parsed) {
              setError("That file is not a head-to-head report.");
              return;
            }
            setError(undefined);
            onOpen(parsed, file.name);
          } catch {
            setError("That file could not be read as JSON.");
          }
        }}
      />
      {error && (
        <p className="type-small text-text-secondary" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function CompareApp() {
  const comparison = useViewer((state) => state.comparison);
  const name = useViewer((state) => state.comparisonName);
  const close = useViewer((state) => state.closeComparison);
  return (
    <div data-app>
      <header data-app-bar>
        <span className="type-body-strong">myco</span>
        <span className="type-data truncate text-text-secondary" title={name}>
          {name ?? "head-to-head"}
        </span>
        <div className="grow" />
        <button type="button" data-button onClick={close}>
          Close
        </button>
      </header>
      <main data-compare className="min-h-0 grow overflow-auto">
        {comparison ? (
          <HeadToHeadView report={comparison} />
        ) : (
          <CompareOpen
            onOpen={(report, fileName) => useViewer.getState().openComparison(fileName, report)}
          />
        )}
      </main>
    </div>
  );
}

export function HeadToHeadView({ report }: { report: HeadToHeadReport }) {
  const { decision } = report;
  const verdict = display(decision);
  const settled = decision.status === "decided";
  return (
    <section data-head-to-head aria-label="Head-to-head report">
      <header data-report-header data-verdict={verdict.label}>
        <VerdictBadge label={verdict.label} size="xl" />
        <div>
          <p className="type-title text-text-primary">
            {settled ? (decision.row ?? "No row") : "Not decided"}
          </p>
          <p className="type-small text-text-secondary">
            {decision.status === "refused"
              ? `Refused: ${decision.reason ?? "no reason recorded"}`
              : "The pre-registered rule returned this row"}
          </p>
        </div>
      </header>

      <div data-report-facts>
        <Fact label="Task" value={decision.taskId} />
        <Fact label="Prompt" value={decision.promptVariant} />
        <Fact label="Paired trials" value={String(decision.pairs)} />
        <Fact
          label="Sign test p"
          value={decision.signTestP === null ? "n/a" : decision.signTestP.toFixed(4)}
        />
        <Fact label="Ineligible rows" value={String(decision.ineligibleRows)} />
        {report.generatedAt && <Fact label="Generated" value={report.generatedAt} />}
      </div>

      <section aria-label="Arms">
        <h2 className="type-micro text-text-secondary">Arms</h2>
        <table data-report-table>
          <thead className="type-micro text-text-secondary">
            <tr>
              <th scope="col">Arm</th>
              <th scope="col">Trials</th>
              <th scope="col">Verified</th>
              <th scope="col">Refuted</th>
              <th scope="col">Unknown</th>
              <th scope="col">False successes</th>
              <th scope="col">False-success CI</th>
            </tr>
          </thead>
          <tbody className="type-data">
            {report.arms.map((arm) => {
              const falseSuccesses = arm.trials.filter((trial) => trial.falseSuccess).length;
              const unknown = arm.trials.some((trial) => trial.falseSuccessKnown === false);
              return (
                <tr key={arm.armId}>
                  <td className="type-data-strong">{arm.label ?? arm.armId}</td>
                  <td>{arm.trials.length}</td>
                  <td>{arm.trials.filter((trial) => trial.verdict === "verified").length}</td>
                  <td>{arm.trials.filter((trial) => trial.verdict === "refuted").length}</td>
                  <td>{arm.trials.filter((trial) => trial.verdict === "uncertain").length}</td>
                  <td>{unknown ? "n/a (unknown)" : falseSuccesses}</td>
                  <td>{unknown ? "n/a" : armInterval(arm.trials, falseSuccesses)}</td>
                </tr>
              );
            })}
            {report.arms.length === 0 && (
              <tr>
                <td colSpan={7} className="type-small text-text-secondary">
                  No arms recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section aria-label="Discordant pairs">
        <h2 className="type-micro text-text-secondary">Discordant pairs</h2>
        <p className="type-body text-text-primary">
          <span className="type-data-strong">{decision.discordantFavouringMyco}</span>{" "}
          <span className="text-text-secondary">favour Myco</span>
          <ArrowRight aria-hidden="true" className="type-small mx-2 inline" />
          <span className="type-data-strong">{decision.discordantFavouringComparator}</span>{" "}
          <span className="text-text-secondary">favour the comparator</span>
        </p>
        <p className="type-small text-text-secondary">
          False successes: Myco {decision.mycoFalseSuccesses} (
          {band(decision.mycoFalseSuccessInterval)}) · comparator{" "}
          {decision.comparatorFalseSuccesses} ({band(decision.comparatorFalseSuccessInterval)})
        </p>
      </section>

      {decision.notes.length > 0 && (
        <section aria-label="Rule notes">
          <h2 className="type-micro text-text-secondary">Rule notes</h2>
          <ul data-report-notes>
            {decision.notes.map((note) => (
              <li key={note} className="type-small text-text-primary">
                {note}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.notRun && report.notRun.length > 0 && (
        <section aria-label="Not run">
          <h2 className="type-micro text-text-secondary">Not run</h2>
          <table data-report-table>
            <tbody className="type-data">
              {report.notRun.map((arm) => (
                <tr key={arm.armId}>
                  <td className="type-data-strong">
                    <CircleHelp aria-hidden="true" className="inline" /> {arm.armId}
                  </td>
                  <td className="text-text-secondary">{arm.blocker}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {report.evidence && report.evidence.length > 0 && (
        <section aria-label="Evidence">
          <h2 className="type-micro text-text-secondary">Evidence</h2>
          <ul data-report-notes>
            {report.evidence.map((path) => (
              <li key={path} className="type-data-small text-text-secondary">
                <Minus aria-hidden="true" className="inline" /> {path}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function armInterval(
  trials: readonly { verdict: "verified" | "refuted" | "uncertain"; falseSuccess: boolean }[],
  falseSuccesses: number,
): string {
  const n = trials.length;
  if (n === 0) return "n/a";
  const z = 1.96;
  const p = falseSuccesses / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return `${pct(Math.max(0, centre - margin))}–${pct(Math.min(1, centre + margin))}`;
}
