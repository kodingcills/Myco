import { AlertTriangle, ArrowRight, CircleHelp, Minus } from "lucide-react";
import { useEffect, useRef } from "react";
import type { HeadToHeadReport } from "../data/head-to-head.ts";
import { useViewer } from "../store.ts";

// gui-spec §4.6/§2.11: missing data reads exactly `not recorded`; unverifiable data reads
// exactly `could not look`. Identical strings everywhere, so they live in one place.
const MISSING = "not recorded";
const COULD_NOT_LOOK = "could not look";

function pct(value: number | null): string {
  return value === null ? MISSING : `${(value * 100).toFixed(1)}%`;
}

function band(bounds: readonly [number, number] | null): string {
  return bounds === null ? MISSING : `${pct(bounds[0])}–${pct(bounds[1])}`;
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
  const provenance = report.provenance ?? { kind: "unknown" as const };
  const settled = decision.status === "decided";
  const nonLive = provenance.kind !== "live";
  const sourceLabel =
    provenance.kind === "simulated"
      ? "simulated"
      : provenance.kind === "mixed"
        ? "mixed"
        : "unknown source";
  return (
    <section data-head-to-head aria-label="Head-to-head report">
      <header data-report-header>
        <div>
          <p className="type-micro text-text-secondary">Decision</p>
          <div className="flex items-center gap-2">
            <h1 className="type-title text-text-primary" tabIndex={-1}>
              {settled ? (decision.row ?? "No row") : "Not decided"}
              {nonLive ? ` (${sourceLabel})` : ""}
            </h1>
            {provenance.kind !== "live" && (
              <span
                data-simulated-badge
                className="type-data-small inline-flex items-center gap-1 px-1 border border-border-strong rounded-control text-text-primary bg-bg-surface3 whitespace-nowrap"
                title="Not live guest evidence: this report is simulated, modelled, or replayed"
              >
                <AlertTriangle
                  className="size-3 shrink-0 text-text-primary"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                {provenance.kind === "simulated"
                  ? "Simulated"
                  : provenance.kind === "mixed"
                    ? "Mixed"
                    : "Unknown source"}
              </span>
            )}
          </div>
          <p className="type-small text-text-secondary">
            {decision.status === "refused"
              ? `Refused: ${decision.reason ?? "no reason recorded"}`
              : provenance.kind !== "live"
                ? "Not a live result: the arms below are not guest trials"
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
          value={decision.signTestP === null ? MISSING : decision.signTestP.toFixed(4)}
        />
        <Fact label="Ineligible rows" value={String(decision.ineligibleRows)} />
        {report.generatedAt && (
          <Fact label="Generated" value={formatGeneratedAt(report.generatedAt)} />
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
              <th scope="col">Failed</th>
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
                  <td>{unknown ? MISSING : falseSuccesses}</td>
                  <td>{unknown ? COULD_NOT_LOOK : armInterval(arm.trials, falseSuccesses)}</td>
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
                  <td>
                    {row.claimKnown === false ? MISSING : row.mycoFalseSuccess ? "yes" : "no"}
                  </td>
                  <td>
                    {row.claimKnown === false ? MISSING : row.comparatorFalseSuccess ? "yes" : "no"}
                  </td>
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
                {nonLive ? `${sourceLabel[0]?.toUpperCase()}${sourceLabel.slice(1)}: ` : ""}
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

      {provenance && (
        <section aria-label="Provenance">
          <h2 className="type-micro text-text-secondary">Provenance</h2>
          <p className="type-small text-text-primary">
            {provenance.kind === "live"
              ? "Live guest trials."
              : provenance.kind === "simulated"
                ? "Simulated: no guest trials back these numbers."
                : provenance.kind === "mixed"
                  ? "Mixed: at least one arm is not live guest evidence."
                  : "Unknown source: the report does not say whether these are live trials."}
          </p>
          {provenance.note && <p className="type-small text-text-secondary">{provenance.note}</p>}
          {provenance.arms && provenance.arms.length > 0 && (
            <table data-report-table>
              <thead className="type-micro text-text-secondary">
                <tr>
                  <th scope="col">Arm</th>
                  <th scope="col">Source</th>
                  <th scope="col">Live</th>
                </tr>
              </thead>
              <tbody className="type-data">
                {provenance.arms.map((arm) => (
                  <tr key={arm.armId}>
                    <td className="type-data-strong">{arm.armId}</td>
                    <td>{arm.source}</td>
                    <td>{arm.live ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
            It does not pool prompt variants: <span className="type-data">{decision.taskId}</span> (
            <span className="type-data">{decision.promptVariant}</span>) is this decision's variant,
            and any other variant is a separate decision.
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
  if (n === 0) return COULD_NOT_LOOK;
  const z = 1.96;
  const p = falseSuccesses / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return `${pct(Math.max(0, centre - margin))}–${pct(Math.min(1, centre + margin))}`;
}

// gui-spec §4.5: absolute timestamps read `HH:MM:SS.mmm ET` in the viewer's local zone with
// a label. The report's `generatedAt` is an ISO instant, so render it in local time rather
// than echoing the raw UTC `Z`, which the spec forbids in the UI.
function formatGeneratedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return MISSING;
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}:${String(at.getSeconds()).padStart(2, "0")}.${String(at.getMilliseconds()).padStart(3, "0")}`;
  return `${time} ET`;
}
