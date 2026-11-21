import { readdir, readFile } from "node:fs/promises";
import { compile } from "tailwindcss";
import ts from "typescript";

const generatedFile = "theme.generated.css";
const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const metadata = new Set([
  "version",
  "spec",
  "contrast._note",
  "elevation._note",
  "motion.reducedMotion",
  "icon.color",
]);

function* leaves(value, path = []) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) yield* leaves(child, [...path, key]);
  } else {
    yield [path, value];
  }
}

export function generateTheme(tokens) {
  const declarations = new Map();
  function set(name, value) {
    if (declarations.has(name)) throw new Error(`Duplicate theme variable ${name}`);
    declarations.set(name, value);
  }

  for (const [path, value] of leaves(tokens)) {
    const key = path.join(".");
    const [group, section, ...tail] = path;
    if (
      (metadata.has(key) || (group === "layout" && path.at(-1) === "_source")) &&
      typeof value === "string"
    )
      continue;
    // Contrast is audit metadata measured from the color tokens.
    if (group === "contrast" && path.length === 3 && typeof value === "number") continue;

    const name = path
      .filter((part, index) => part !== "value" || index === 0 || group !== "layout")
      .map(kebab)
      .join("-");
    const number = typeof value === "number" && Number.isFinite(value);
    const text = typeof value === "string";
    if (group === "color" && text && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) {
      set(name, value);
    } else if (
      group === "color" &&
      section === "verdict" &&
      path.at(-1) === "glyph" &&
      text &&
      /^[a-z\d-]+$/.test(value)
    ) {
      set(name, value);
    } else if (
      group === "font" &&
      ["family", "features"].includes(section) &&
      tail.length === 1 &&
      text
    ) {
      const suffix = section === "features" ? "--font-feature-settings" : "";
      set(`font-${kebab(tail[0])}${suffix}`, value);
    } else if (group === "font" && section === "size" && tail.length === 2) {
      const [style, property] = tail;
      const base = `text-${kebab(style)}`;
      if (property === "size" && number) set(base, `${value}px`);
      else if (property === "lineHeight" && number) set(`${base}--line-height`, `${value}px`);
      else if (property === "weight" && number) set(`${base}--font-weight`, value);
      else if (property === "tracking" && number) set(`${base}--letter-spacing`, `${value}em`);
      else if (property === "family" && ["sans", "mono"].includes(value))
        set(`${base}--font-family`, `var(--font-${value})`);
      else if (property === "case" && value === "upper")
        set(`${base}--text-transform`, "uppercase");
      else throw new Error(`Cannot map design token ${key}`);
    } else if (group === "space" && /^\d+(\.\d+)?$/.test(section) && path.length === 2 && number) {
      set(`spacing-${section.replace(".", "_")}`, `${value}px`);
    } else if (group === "layout" && number) {
      set(name, `${value}px`);
      set(`spacing-${name}`, `var(--${name})`);
    } else if (group === "layout" && text && /^\d+(\.\d+)?(%|vh)$/.test(value)) {
      set(name, value);
      set(`spacing-${name}`, `var(--${name})`);
    } else if (["radius", "border"].includes(group) && path.length === 2 && number) {
      set(name, `${value}px`);
    } else if (key === "border.focusRing" && text) {
      const parts = /^(\d+px solid #[\da-f]{6}), offset (\d+px)$/i.exec(value);
      if (!parts) throw new Error(`Cannot map design token ${key}`);
      set("border-focus-ring", parts[1]);
      set("border-focus-ring-offset", parts[2]);
    } else if (key === "elevation.shadow" && value === "none") {
      set("shadow-none", value);
    } else if (group === "motion" && section === "duration" && tail.length === 1 && number) {
      set(`duration-${kebab(tail[0])}`, `${value}ms`);
    } else if (group === "motion" && section === "easing" && tail.length === 1 && text) {
      set(`ease-${kebab(tail[0])}`, value);
    } else if (
      group === "icon" &&
      ["size", "sizeSmall"].includes(section) &&
      path.length === 2 &&
      number
    ) {
      set(name, `${value}px`);
      set(`spacing-${name}`, `var(--${name})`);
    } else if ((key === "icon.stroke" && number) || (key === "icon.set" && value === "lucide")) {
      set(name, value);
    } else {
      throw new Error(`Cannot map design token ${key}`);
    }
  }

  const utilities = Object.keys(tokens.font.size).map((style) => {
    const name = `text-${kebab(style)}`;
    const font = tokens.font.size[style];
    const transform = font.case ? `  text-transform: var(--${name}--text-transform);\n` : "";
    return (
      "@utility type-" +
      kebab(style) +
      " {\n" +
      "  @apply " +
      name +
      ";\n" +
      "  font-family: var(--" +
      name +
      "--font-family);\n" +
      "  font-feature-settings: var(--font-" +
      font.family +
      "--font-feature-settings);\n" +
      transform +
      "}"
    );
  });
  const variables = [...declarations].map(([name, value]) => `  --${name}: ${value};`);
  return [
    "/* Generated from docs/design/tokens.json by viewer/scripts/generate-theme.mjs. */",
    "@theme static {",
    "  --*: initial;",
    ...variables,
    "}",
    "",
    ...utilities,
    "",
  ].join("\n");
}

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) yield* files(path);
    else yield [entry.name, path];
  }
}

const rawLiteral = /#[\da-f]{3,8}(?![\w-])|(?:\d+(?:\.\d+)?|\.\d+)px\b/i;

function classCandidates(source) {
  const candidates = new Set();
  function collect(node) {
    if (!node) return;
    if (ts.isStringLiteralLike(node)) {
      for (const candidate of node.text.split(/\s+/)) if (candidate) candidates.add(candidate);
    } else if (ts.isTemplateExpression(node)) {
      throw new Error("Use complete Tailwind class names instead of interpolating class names");
    } else if (ts.isConditionalExpression(node)) {
      collect(node.whenTrue);
      collect(node.whenFalse);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      collect(node.right);
    } else if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node)) {
      collect(node.expression);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collect(element);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) collect(property.name);
      }
    }
  }
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "className")
      collect(node.initializer);
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (name === "clsx" || name === "cn") {
        for (const argument of node.arguments) collect(argument);
      } else if (name === "cva") {
        collect(node.arguments[0]);
        const options = node.arguments[1];
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            if (property.name.getText(source) === "variants") {
              const visitVariant = (value) => {
                if (ts.isObjectLiteralExpression(value)) {
                  for (const entry of value.properties) {
                    if (ts.isPropertyAssignment(entry)) visitVariant(entry.initializer);
                  }
                } else collect(value);
              };
              visitVariant(property.initializer);
            } else if (
              property.name.getText(source) === "compoundVariants" &&
              ts.isArrayLiteralExpression(property.initializer)
            ) {
              for (const item of property.initializer.elements) {
                if (!ts.isObjectLiteralExpression(item)) continue;
                for (const entry of item.properties) {
                  if (
                    ts.isPropertyAssignment(entry) &&
                    /^(class|className)$/.test(entry.name.getText(source))
                  )
                    collect(entry.initializer);
                }
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return candidates;
}

export async function validateStyles(src, theme) {
  const variables = new Set(theme.match(/--[\w-]+(?=:)/g));
  const compiler = await compile(`${theme}\n@tailwind utilities;`);
  let previous = compiler.build([]);
  const checked = new Set();
  for await (const [name, path] of files(src)) {
    if (name === generatedFile) continue;
    const css = name.endsWith(".css");
    const component = path.pathname.includes("/components/") && /\.[cm]?[jt]sx?$/.test(name);
    if (!css && !component) continue;
    const body = await readFile(path, "utf8");
    const literal = rawLiteral.exec(body);
    if (literal) throw new Error(`${name}: raw design value ${literal[0]}`);
    for (const [token] of body.matchAll(/--[\w-]+/g)) {
      if (!variables.has(token)) throw new Error(`${name}: unknown design token ${token}`);
    }
    if (!component) continue;
    const source = ts.createSourceFile(name, body, ts.ScriptTarget.Latest, true);
    for (const candidate of classCandidates(source)) {
      if (checked.has(candidate)) continue;
      if (candidate.includes("[") || /\([^)]*$/.test(candidate)) {
        throw new Error(`${name}: use theme variables for ${candidate}`);
      }
      const next = compiler.build([candidate]);
      if (next === previous && !/^(group|peer)(\/[\w-]+)?$/.test(candidate)) {
        throw new Error(`${name}: unknown Tailwind utility ${candidate}`);
      }
      checked.add(candidate);
      previous = next;
    }
  }
}
