import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { generateTheme, validateStyles } from "../scripts/theme.mjs";

const src = new URL("../src/", import.meta.url);
const tokens = JSON.parse(
  await readFile(new URL("../../docs/design/tokens.json", import.meta.url), "utf8"),
);
const theme = generateTheme(tokens);

test("viewer styles use generated tokens and contain no raw hex or pixel values", async () => {
  await expect(validateStyles(src, theme)).resolves.toBeUndefined();
});

test("theme generation fails on an unmappable token", () => {
  expect(() => generateTheme({ ...tokens, unknown: 5 })).toThrow("Cannot map design token unknown");
});

test("style validation rejects unknown tokens, misspelled utilities, and raw design values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "myco-theme-"));
  const root = pathToFileURL(dir + sep);
  try {
    await writeFile(new URL("styles.css", root), "body { color: var(--color-missing); }");
    await expect(validateStyles(root, theme)).rejects.toThrow("unknown design token");
    await writeFile(new URL("styles.css", root), "body { color: #abcd; }");
    await expect(validateStyles(root, theme)).rejects.toThrow("raw design value");
    await writeFile(new URL("styles.css", root), "body { padding: 2px; }");
    await expect(validateStyles(root, theme)).rejects.toThrow("raw design value");
    await writeFile(new URL("styles.css", root), "");
    await mkdir(new URL("components/", root));
    await writeFile(
      new URL("components/App.tsx", root),
      'const color = "bg-bg-cavnas" as const; <div className={color} />',
    );
    await expect(validateStyles(root, theme)).rejects.toThrow("unknown Tailwind utility");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
