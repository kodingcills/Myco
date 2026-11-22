/**
 * Minimal JSON Schema (draft-07 subset) validator.
 *
 * Hand-rolled on purpose: M1-012 forbids new runtime dependencies, and the
 * evidence schemas only exercise this subset. Supported keywords: `$ref`
 * (local `#/$defs/<name>` only), `$defs`, `type` (string or list), `enum`,
 * `const`, `properties`, `required`, `additionalProperties: false`, `items`,
 * `minItems`, `maxItems`, `minimum`, `maximum`, `pattern`, `minLength`,
 * `maxLength`, `anyOf`, `oneOf`.
 */

export interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  description?: string;
}

export interface SchemaIssue {
  /** JSON-path style location of the failure, e.g. `$.verdict.checks[0].score`. */
  path: string;
  /** Keyword or invariant that failed. */
  keyword: string;
  message: string;
}

export function validateSchema(value: unknown, schema: JsonSchema, path = "$"): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateNode(value, schema, path, schema, issues);
  return issues;
}

function validateNode(
  value: unknown,
  schema: JsonSchema,
  path: string,
  root: JsonSchema,
  issues: SchemaIssue[],
): void {
  if (schema.$ref !== undefined) {
    const resolved = resolveRef(schema.$ref, root);
    if (resolved === undefined) {
      issues.push({ path, keyword: "$ref", message: `unresolvable $ref "${schema.$ref}"` });
      return;
    }
    validateNode(value, resolved, path, root, issues);
    return;
  }

  if (schema.anyOf !== undefined) {
    if (!schema.anyOf.some((branch) => matchesBranch(value, branch, path, root, issues))) {
      issues.push({ path, keyword: "anyOf", message: "value matches none of the anyOf branches" });
    }
  }
  if (schema.oneOf !== undefined) {
    const passes = schema.oneOf.filter((branch) =>
      matchesBranch(value, branch, path, root, issues),
    );
    if (passes.length !== 1) {
      issues.push({
        path,
        keyword: "oneOf",
        message: `value matches ${passes.length} of the oneOf branches, expected exactly 1`,
      });
    }
  }

  if (schema.type !== undefined) {
    const type = schema.type;
    const matches =
      typeof type === "string"
        ? matchesType(value, type)
        : type.some((entry) => matchesType(value, entry));
    if (!matches) {
      issues.push({
        path,
        keyword: "type",
        message: `expected ${typeof type === "string" ? type : type.join("|")}, got ${typeName(value)}`,
      });
      return; // further keywords assume the declared shape
    }
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    issues.push({
      path,
      keyword: "const",
      message: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`,
    });
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(value, candidate))) {
    issues.push({
      path,
      keyword: "enum",
      message: `value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`,
    });
  }

  if (typeof value === "string") {
    checkString(value, schema, path, issues);
  } else if (typeof value === "number") {
    checkNumber(value, schema, path, issues);
  } else if (Array.isArray(value)) {
    checkArray(value, schema, path, root, issues);
  } else if (isPlainObject(value)) {
    checkObject(value, schema, path, root, issues);
  }
}

// A union reports its own error. Discard branch-local details and reuse the caller's buffer.
function matchesBranch(
  value: unknown,
  schema: JsonSchema,
  path: string,
  root: JsonSchema,
  issues: SchemaIssue[],
): boolean {
  const start = issues.length;
  validateNode(value, schema, path, root, issues);
  if (issues.length === start) return true;
  issues.length = start;
  return false;
}

function checkString(value: string, schema: JsonSchema, path: string, issues: SchemaIssue[]): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    issues.push({
      path,
      keyword: "minLength",
      message: `string length ${value.length} is below minimum ${schema.minLength}`,
    });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    issues.push({
      path,
      keyword: "maxLength",
      message: `string length ${value.length} is above maximum ${schema.maxLength}`,
    });
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
    issues.push({
      path,
      keyword: "pattern",
      message: `string does not match pattern ${schema.pattern}`,
    });
  }
}

function checkNumber(value: number, schema: JsonSchema, path: string, issues: SchemaIssue[]): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    issues.push({
      path,
      keyword: "minimum",
      message: `value ${value} is below minimum ${schema.minimum}`,
    });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    issues.push({
      path,
      keyword: "maximum",
      message: `value ${value} is above maximum ${schema.maximum}`,
    });
  }
}

function checkArray(
  value: unknown[],
  schema: JsonSchema,
  path: string,
  root: JsonSchema,
  issues: SchemaIssue[],
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    issues.push({
      path,
      keyword: "minItems",
      message: `array length ${value.length} is below minimum ${schema.minItems}`,
    });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    issues.push({
      path,
      keyword: "maxItems",
      message: `array length ${value.length} is above maximum ${schema.maxItems}`,
    });
  }
  const { items } = schema;
  if (items !== undefined) {
    for (let index = 0; index < value.length; index++) {
      validateNode(value[index], items, `${path}[${index}]`, root, issues);
    }
  }
}

function checkObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
  root: JsonSchema,
  issues: SchemaIssue[],
): void {
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) {
      issues.push({ path, keyword: "required", message: `missing required property "${key}"` });
    }
  }
  const { properties } = schema;
  if (properties) {
    for (const key in properties) {
      if (Object.hasOwn(properties, key) && value[key] !== undefined) {
        validateNode(value[key], properties[key]!, `${path}.${key}`, root, issues);
      }
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (
        value[key] !== undefined &&
        !Object.prototype.propertyIsEnumerable.call(properties ?? {}, key)
      ) {
        issues.push({
          path,
          keyword: "additionalProperties",
          message: `unexpected property "${key}"`,
        });
      }
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (!ref.startsWith("#/$defs/")) return undefined;
  const name = ref.slice("#/$defs/".length);
  return root.$defs?.[name];
}
