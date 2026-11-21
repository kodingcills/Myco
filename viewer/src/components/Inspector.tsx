import { cloneElement, useEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { loadRunFiles } from "../data/loaders.ts";
import type { SourceRef } from "../data/types.ts";
import type { OpenedRun } from "../store.ts";
import { Missing, sourceLabel } from "./SourceRef.tsx";

function sourceValue(run: OpenedRun, source: SourceRef) {
  const { data } = run;
  if ("line" in source) {
    if (source.file === "ledger.jsonl")
      return data.ledger.find(
        (entry) => "line" in entry.source && entry.source.line === source.line,
      )?.value;
    return data.events.find(
      (entry) =>
        entry.source.file === source.file &&
        "line" in entry.source &&
        entry.source.line === source.line,
    )?.event;
  }
  let value: unknown = source.file === "result.json" ? data.result : data.manifest;
  for (const key of source.path
    .slice(1)
    .split("/")
    .filter((_, index) => index || source.path)) {
    const decoded = key.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, decoded)) return undefined;
    value = Reflect.get(value, decoded);
  }
  return value;
}

async function readSource(run: OpenedRun, source: SourceRef) {
  const value = sourceValue(run, source);
  if (value !== undefined) return JSON.stringify(value, null, 2);
  const text = await (await loadRunFiles(run.files)).read(source.file)?.text();
  if (text === undefined) return undefined;
  if ("line" in source) return text.split(/\r?\n/)[source.line - 1];
  if (!source.path) return text;
  return undefined;
}

export function Inspector({ run, source }: { run: OpenedRun; source?: SourceRef }) {
  const [text, setText] = useState<string>();
  const [copyStatus, setCopyStatus] = useState("");
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState<number>();
  const inspector = useRef<HTMLElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const virtualRaw = useRef<VirtuosoHandle>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const header = useRef<HTMLElement>(null);
  const label = source && sourceLabel(source);
  useEffect(() => {
    setText(undefined);
    setCopyStatus("");
    setMatch(undefined);
    let active = true;
    if (source) {
      void readSource(run, source).then(
        (raw) => {
          if (active) setText(raw);
        },
        () => {
          if (active) setText(undefined);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [run, source]);

  useEffect(() => {
    if (source) header.current?.focus({ preventScroll: true });
  }, [source]);

  useEffect(() => {
    if (finding) findInput.current?.focus();
  }, [finding]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      if (!inspector.current?.contains(document.activeElement)) return;
      event.preventDefault();
      setFinding(true);
      findInput.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Could not copy");
    }
  }

  const lines = text?.split("\n") ?? [];
  const matches = query.length
    ? lines.flatMap((line, index) =>
        line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [index] : [],
      )
    : [];
  const hit = match ?? matches[0];

  useEffect(() => {
    if (hit === undefined || !body) return;
    if (virtualRaw.current) virtualRaw.current.scrollToIndex({ index: hit, align: "center" });
    else body.querySelector("[data-raw-match]")?.scrollIntoView({ block: "nearest" });
  }, [hit, body]);

  function rawLine(line: string, index: number) {
    const key = /^\s*"(?:[^"\\]|\\.)*":/.exec(line)?.[0];
    return (
      <div data-json data-raw-match={hit === index || undefined} className="type-data">
        {key ? (
          <>
            <span className="text-text-secondary">{key}</span>
            {line.slice(key.length)}
          </>
        ) : (
          line || " "
        )}
      </div>
    );
  }
  return (
    <aside
      ref={inspector}
      data-inspector
      data-region="inspector"
      aria-label="Inspector"
      tabIndex={-1}
    >
      <header ref={header} tabIndex={-1}>
        <div data-inspector-actions>
          <span className="type-body-strong">Raw</span>
          {text !== undefined && (
            <button type="button" data-button onClick={() => void copy(text)}>
              Copy
            </button>
          )}
          {label && (
            <button type="button" data-button onClick={() => void copy(label)}>
              Copy path
            </button>
          )}
        </div>
        <div className="type-data-small text-text-secondary wrap-anywhere">
          {label ?? <Missing />}
        </div>
        <span role="status" className="sr-only">
          {copyStatus}
        </span>
      </header>
      {finding && (
        <form
          data-raw-find
          onSubmit={(event) => {
            event.preventDefault();
            if (matches.length)
              setMatch(matches[(matches.indexOf(hit ?? -1) + 1) % matches.length]);
          }}
        >
          <input
            ref={findInput}
            aria-label="Find in Raw"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setMatch(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setFinding(false);
                setQuery("");
                setMatch(undefined);
                header.current?.focus();
              }
            }}
          />
          <span role="status" className="type-data-small">
            {query &&
              (matches.length
                ? `${matches.indexOf(hit ?? -1) + 1}/${matches.length}`
                : "No matches")}
          </span>
          <button data-button type="submit">
            Next
          </button>
        </form>
      )}
      <section ref={setBody} data-raw-body aria-label="Raw source">
        {lines.length > 50 && body ? (
          <Virtuoso
            ref={virtualRaw}
            customScrollParent={body}
            data={lines}
            itemContent={(index, line) => rawLine(line, index)}
          />
        ) : (
          <div>
            {text === undefined ? (
              <Missing />
            ) : (
              lines.map((line, index) =>
                // biome-ignore lint/suspicious/noArrayIndexKey: A line's position is its identity in this static source excerpt.
                cloneElement(rawLine(line, index), { key: index }),
              )
            )}
          </div>
        )}
      </section>
    </aside>
  );
}
