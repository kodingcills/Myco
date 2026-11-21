import { Popover } from "@base-ui/react/popover";
import { Tabs } from "@base-ui/react/tabs";
import { PanelLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { droppedFiles, selectionName } from "../open-files.ts";
import { type Mode, useActiveRun, useViewer } from "../store.ts";
import { Inspector } from "./Inspector.tsx";
import { OpenPicker, OpenScreen } from "./OpenScreen.tsx";
import { Proof } from "./Proof.tsx";
import { layoutNumber, RunsSidebar } from "./RunsSidebar.tsx";
import { SourceChip } from "./SourceRef.tsx";
import { VerdictBar } from "./VerdictBar.tsx";

const shortcuts = [
  ["Mod+O", "Open a run"],
  ["Mod+B", "Toggle Runs sidebar"],
  ["Mod+D", "Toggle source Inspector"],
  ["F6 / Shift+F6", "Next / previous region"],
  ["2 / 3", "Why / Proof"],
  ["↑ / ↓", "Move through runs or comparisons"],
  ["Home / End", "First / last run"],
  ["Enter", "Open the focused run or persisted source"],
  ["Delete", "Remove the focused run from the sidebar"],
  ["Mod+1…9", "Jump to a run"],
  ["Mod+Shift+[ / ]", "Previous / next run"],
  ["Esc", "Close an overlay or clear selection"],
  ["Mod+F", "Find in the Raw source"],
  ["?", "Show shortcuts"],
];

function useNarrowViewport() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const update = () => setNarrow(innerWidth < layoutNumber("--layout-min-viewport-width"));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return narrow;
}

export function App() {
  const run = useActiveRun();
  const mode = useViewer((state) => state.mode);
  const setMode = useViewer((state) => state.setMode);
  const source = useViewer((state) => state.selection.source);
  const inspector = useViewer((state) => state.inspectorOpen);
  const sidebar = useViewer((state) => state.sidebarOpen);
  const narrow = useNarrowViewport();
  const showSidebar = sidebar ?? !narrow;
  const [center, setCenter] = useState<HTMLElement | null>(null);
  const [picker, setPicker] = useState(false);
  const [help, setHelp] = useState(false);
  const [mod, setMod] = useState(false);
  const [drag, setDrag] = useState(false);
  const dragDepth = useRef(0);
  const [dropError, setDropError] = useState<string>();
  const openTrigger = useRef<HTMLButtonElement>(null);
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef(new Map<HTMLElement, HTMLElement>());

  useEffect(() => {
    function trackFocus(event: FocusEvent) {
      if (!(event.target instanceof HTMLElement)) return;
      const region = event.target.closest<HTMLElement>("[data-region]");
      if (region) lastFocus.current.set(region, event.target);
    }
    function cycleRegion(backwards: boolean) {
      const regions = Array.from(document.querySelectorAll<HTMLElement>("[data-region]"));
      const current = regions.findIndex((region) => region.contains(document.activeElement));
      const index =
        current < 0
          ? backwards
            ? regions.length - 1
            : 0
          : (current + (backwards ? -1 : 1) + regions.length) % regions.length;
      const region = regions[index];
      if (!region) return;
      const previous = lastFocus.current.get(region);
      if (previous?.isConnected && previous.getClientRects().length) previous.focus();
      else
        (
          region.querySelector<HTMLElement>('[tabindex="0"],button:not([disabled])') ?? region
        ).focus();
    }
    function keys(event: KeyboardEvent) {
      setMod(event.metaKey || event.ctrlKey);
      if (event.defaultPrevented) return;
      const state = useViewer.getState();
      const modified = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const editable =
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          event.target.matches("input:not([type=range]), textarea, select"));
      if (modified && key === "o") {
        event.preventDefault();
        setDropError(undefined);
        openTrigger.current?.focus();
        setPicker(true);
      } else if (modified && key === "b") {
        event.preventDefault();
        useViewer.setState({ sidebarOpen: !showSidebar });
      } else if (modified && key === "d" && state.selection.run) {
        event.preventDefault();
        useViewer.setState({ inspectorOpen: !state.inspectorOpen });
      } else if (event.key === "F6") {
        event.preventDefault();
        cycleRegion(event.shiftKey);
      } else if (modified && !event.shiftKey && /^[1-9]$/.test(key)) {
        const target = state.runs[Number(key) - 1];
        if (target) {
          event.preventDefault();
          state.activate(target);
        }
      } else if (
        modified &&
        event.shiftKey &&
        ["BracketLeft", "BracketRight"].includes(event.code)
      ) {
        const index = state.runs.findIndex(({ key }) => key === state.selection.run);
        const target = state.runs[index + (event.code === "BracketLeft" ? -1 : 1)];
        if (target) {
          event.preventDefault();
          state.activate(target);
        }
      } else if (
        !modified &&
        !event.altKey &&
        !editable &&
        !help &&
        !picker &&
        state.selection.run &&
        (key === "2" || key === "3")
      ) {
        event.preventDefault();
        state.setMode(key === "2" ? "why" : "proof");
        requestAnimationFrame(() => {
          const target =
            key === "3" && document.querySelector<HTMLElement>('[data-comparison][tabindex="0"]');
          (
            target || document.querySelector<HTMLElement>('[data-modes] [aria-selected="true"]')
          )?.focus();
        });
      } else if (!modified && !editable && key === "?") {
        helpTrigger.current?.focus();
        setHelp((open) => !open);
      } else if (
        event.key === "Escape" &&
        !help &&
        !picker &&
        !document.activeElement?.closest('[role="menu"]')
      ) {
        if (narrow && state.inspectorOpen) useViewer.setState({ inspectorOpen: false });
        else state.select({ run: state.selection.run });
      }
    }
    function modifiers(event: KeyboardEvent) {
      setMod(event.metaKey || event.ctrlKey);
    }
    function blur() {
      setMod(false);
    }
    document.addEventListener("focusin", trackFocus);
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", modifiers);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("focusin", trackFocus);
      window.removeEventListener("keydown", keys);
      window.removeEventListener("keyup", modifiers);
      window.removeEventListener("blur", blur);
    };
  }, [help, narrow, picker, showSidebar]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The shared center resets on run or mode changes.
  useEffect(() => {
    center?.scrollTo(0, 0);
  }, [center, mode, run?.key]);

  const parseError = run?.data.parseErrors[0];
  const error = dropError ?? run?.error;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The window-wide drop zone has an equivalent keyboard picker.
    <div
      data-app
      data-dragging={drag || undefined}
      onChangeCapture={(event) => {
        if (event.target instanceof HTMLInputElement && event.target.type === "file") {
          setDropError(undefined);
        }
      }}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          dragDepth.current++;
          setDrag(true);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDrag(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDrag(false);
        setDropError(undefined);
        void droppedFiles(event.dataTransfer)
          .then((files) => {
            if (files.length) void useViewer.getState().open(selectionName(files), files);
          })
          .catch((error) => setDropError(String(error)));
      }}
    >
      <header data-app-bar>
        {run && (
          <button
            type="button"
            data-button
            aria-label="Toggle Runs sidebar"
            title="Toggle Runs sidebar (Mod+B)"
            aria-pressed={showSidebar}
            onClick={() => useViewer.setState({ sidebarOpen: !showSidebar })}
          >
            <PanelLeft aria-hidden="true" />
          </button>
        )}
        <span className="type-body-strong">myco</span>
        {run && (
          <span className="type-data truncate text-text-secondary" title={run.name}>
            {run.name}
          </span>
        )}
        <div className="grow" />
        <OpenPicker trigger={openTrigger} open={picker} setOpen={setPicker}>
          Open
        </OpenPicker>
        <Popover.Root open={help} onOpenChange={setHelp}>
          <Popover.Trigger
            ref={helpTrigger}
            data-button
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            ?
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="end">
              <Popover.Popup data-popup className="p-3">
                <Popover.Title className="type-title mb-2">Keyboard shortcuts</Popover.Title>
                <dl data-shortcuts>
                  {shortcuts.map(([key, action]) => (
                    <div key={key}>
                      <dt className="type-data-small">{key}</dt>
                      <dd>{action}</dd>
                    </div>
                  ))}
                </dl>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </header>
      <div data-workspace>
        {run && showSidebar && <RunsSidebar mod={mod} />}
        <Tabs.Root data-run-view value={mode} onValueChange={(value) => setMode(value as Mode)}>
          {run && <VerdictBar run={run} />}
          <div data-run-body>
            <main
              ref={setCenter}
              data-center
              data-region="center"
              aria-label={run ? "Run evidence" : "Open a run"}
              tabIndex={-1}
            >
              {(error || parseError) && (
                <section role="alert" className="p-3">
                  <h1 className="type-title">Can't read this run</h1>
                  {error && <p className="type-data wrap-anywhere">{error}</p>}
                  {parseError && (
                    <>
                      <p>Incomplete trace</p>
                      {parseError.issues.map(({ path, keyword, message }) => (
                        <p
                          key={JSON.stringify([path, keyword, message])}
                          className="type-data wrap-anywhere"
                        >
                          {path} · {keyword} · {message}
                        </p>
                      ))}
                      <SourceChip source={parseError.source} />
                    </>
                  )}
                  <OpenPicker>Open another…</OpenPicker>
                </section>
              )}
              {!run && !error && <OpenScreen />}
              {run && (!run.error || run.data.result) && (
                <>
                  <Tabs.Panel value="proof" keepMounted tabIndex={-1} data-proof-panel>
                    <Proof key={run.key} center={center} data={run.data} loading={run.loading} />
                  </Tabs.Panel>
                  <Tabs.Panel value="why" tabIndex={-1}>
                    <p className="p-3 text-text-secondary">
                      Why view is unavailable in this build.
                    </p>
                  </Tabs.Panel>
                </>
              )}
            </main>
            {run && inspector && (
              <div data-inspector-slot data-overlay={narrow || undefined}>
                <Inspector run={run} source={source} />
              </div>
            )}
          </div>
        </Tabs.Root>
      </div>
    </div>
  );
}
