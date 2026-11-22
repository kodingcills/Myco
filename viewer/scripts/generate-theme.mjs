import { readFile, writeFile } from "node:fs/promises";
import { generateTheme, validateStyles } from "./theme.mjs";

const tokens = JSON.parse(
  await readFile(new URL("../../docs/design/tokens.json", import.meta.url)),
);
const src = new URL("../src/", import.meta.url);
const theme = generateTheme(tokens);
await validateStyles(src, theme);
if (!process.argv.includes("--check")) {
  await writeFile(new URL("theme.generated.css", src), theme);
}
