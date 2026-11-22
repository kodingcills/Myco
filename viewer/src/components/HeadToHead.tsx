import { ArrowRight, CircleHelp, Minus } from "lucide-react";
import { useEffect, useRef } from "react";
import type { HeadToHeadReport } from "../data/head-to-head.ts";
import { useViewer } from "../store.ts";

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

export function CompareApp() {
  const comparison = useViewer((state) => state.comparison);
  const name = useViewer((state) => state.comparisonName);
  const close = useViewer((state) => state.closeComparison);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div data-app>
      <header data-app-bar>
        <span className="type-body-strong">myco</span>
        <span className="type-data truncate text-text-secondary" title={name}>
          {name ?? "head-to-head"}
        </span>
        <div className="grow" />
        <button ref={closeButton} type="button" data-button onClick={close}>
          Close
        </button>
      </header>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the report is a scrollable region; keyboard users need it focusable. */}
      <main data-compare className="min-h-0 grow overflow-auto" tabIndex={0}>
        {comparison && <HeadToHeadView report={comparison} />}
      </main>
    </div>
  );
}

export function HeadToHeadView({ report }: { report: HeadToHeadReport }) {
  const { decision } = report;
  const settled = decision.status === "decided";
  return (
    <section data-head-to-head aria-label="Head-to-head report">
      <header data-report-header>
        <div>
          <p className="type-micro text-text-secondary">Decision</p>
          <h1 className="type-title text-text-primary" tabIndex={-1}>
            {settled ? (decision.row ?? "No row") : "Not decided"}
          </h1>
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
        {report.generatedAt && (
          <Fact
            label="Generated"
            value={report.generatedAt.replace("T", " ").replace(/\.\d+Z$/, "Z")}
          />
        )}
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
              <th scope="col">Uncertain</th>
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

      {decision.pairRows.length > 0 && (
        <section aria-label="Paired trials">
          <h2 className="type-micro text-text-secondary">Paired trials</h2>
          <table data-report-table>
            <thead className="type-micro text-text-secondary">
              <tr>
                <th scope="col">Seed</th>
                <th scope="col">Fault</th>
                <th scope="col">Myco false success</th>
                <th scope="col">Comparator false success</th>
              </tr>
            </thead>
            <tbody className="type-data">
              {decision.pairRows.map((row) => (
                <tr key={`${row.seed}-${row.faultClass}`}>
                  <td>{row.seed}</td>
                  <td>{row.faultClass}</td>
                  <td>{row.mycoFalseSuccess ? "yes" : "no"}</td>
                  <td>{row.comparatorFalseSuccess ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

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
            <thead className="type-micro text-text-secondary">
              <tr>
                <th scope="col">Arm</th>
                <th scope="col">Blocker</th>
              </tr>
            </thead>
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

      <section aria-label="What this report does not say">
        <h2 className="type-micro text-text-secondary">What this report does not say</h2>
        <ul data-report-notes>
          <li className="type-small text-text-secondary">
            It does not pool prompt variants: <span className="type-data">ef-t01</span> (verify) and{" "}
            <span className="type-data">ef-t01b</span> (no-verify) are separate decisions.
          </li>
          <li className="type-small text-text-secondary">
            It does not treat <span className="type-data">uncertain</span> as success or failure;
            those trials are counted separately.
          </li>
          <li className="type-small text-text-secondary">
            It is not a leaderboard entry. The task set, initial state, and planner are the ones
            named above.
          </li>
          <li className="type-small text-text-secondary">
            A <span className="type-data">refused</span> decision is a result: the pre-registered
            sample or the trusted ingest is not there yet.
          </li>
        </ul>
      </section>
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
