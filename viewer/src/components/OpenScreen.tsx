import { Menu } from "@base-ui/react/menu";
import { type RefObject, useRef } from "react";
import { selectionName } from "../open-files.ts";
import { useViewer } from "../store.ts";

export function OpenPicker({
  children,
  trigger,
  open,
  setOpen,
}: {
  children: string;
  trigger?: RefObject<HTMLButtonElement | null>;
  open?: boolean;
  setOpen?: (open: boolean) => void;
}) {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const openRun = useViewer((state) => state.open);
  function picked(input: HTMLInputElement) {
    const selection = Array.from(input.files ?? []);
    input.value = "";
    if (selection.length) void openRun(selectionName(selection), selection);
  }
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        ref={trigger}
        data-pick-open
        data-button="default"
        aria-keyshortcuts="Meta+O Control+O"
      >
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start">
          <Menu.Popup data-popup>
            <Menu.Item data-button onClick={() => files.current?.click()}>
              Open files…
            </Menu.Item>
            <Menu.Item data-button onClick={() => folder.current?.click()}>
              Open folder…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
      <input
        ref={files}
        hidden
        type="file"
        multiple
        accept=".mycotrace,.json,.jsonl"
        aria-label="Run files"
        onChange={(event) => picked(event.currentTarget)}
      />
      <input
        ref={folder}
        hidden
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        aria-label="Run folder"
        onChange={(event) => picked(event.currentTarget)}
      />
    </Menu.Root>
  );
}

export function OpenScreen() {
  return (
    <section
      data-empty
      className="m-auto flex w-layout-open-column max-w-full flex-col items-start gap-2 p-3"
    >
      <h1 className="type-title">Open a Myco run</h1>
      <p className="text-text-secondary">Drop a .mycotrace file or a run folder, or press ⌘O.</p>
      <OpenPicker>Open…</OpenPicker>
    </section>
  );
}
