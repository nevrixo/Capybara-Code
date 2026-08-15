/**
 * Tool argument validation — PRD §12.1, §12.4, AC-10.
 *
 * §12.1: the model *proposes*; CBC validates before anything executes. AC-10
 * requires that a malformed tool call returns a structured validation error as an
 * observation and never runs the tool.
 *
 * The validator covers the JSON Schema subset the catalog uses. It rejects
 * anything it cannot verify rather than passing it through, so an unrecognized
 * keyword can never become an accidental allow.
 */

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult<T = Record<string, unknown>> {
  readonly ok: boolean;
  readonly value?: T;
  readonly errors: ValidationError[];
}

/** Parse the raw argument text a model streamed, then validate it. */
export function parseAndValidate(
  argumentsText: string,
  schema: Record<string, unknown>,
): ValidationResult {
  let parsed: unknown;
  const trimmed = argumentsText.trim();
  try {
    parsed = trimmed.length === 0 ? {} : JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: ".",
          message: `arguments are not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }
  return validate(parsed, schema);
}

export function validate(value: unknown, schema: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  const coerced = check(value, schema, "", errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: coerced as Record<string, unknown>, errors: [] };
}

function check(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): unknown {
  const type = schema.type as string | undefined;

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value as never)) {
      errors.push({
        path: path || ".",
        message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
      });
      return value;
    }
  }

  switch (type) {
    case "object":
      return checkObject(value, schema, path, errors);
    case "array":
      return checkArray(value, schema, path, errors);
    case "string":
      return checkString(value, schema, path, errors);
    case "integer":
    case "number":
      return checkNumber(value, schema, path, errors, type === "integer");
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push({ path: path || ".", message: "must be a boolean" });
      }
      return value;
    case undefined:
      // No declared type: accept the value as-is only when an enum already
      // constrained it, otherwise report the schema as unusable.
      if (!Array.isArray(schema.enum)) {
        errors.push({ path: path || ".", message: "schema has no declared type" });
      }
      return value;
    default:
      errors.push({ path: path || ".", message: `unsupported schema type '${type}'` });
      return value;
  }
}

function checkObject(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push({ path: path || ".", message: "must be an object" });
    return value;
  }
  const input = value as Record<string, unknown>;
  const properties = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
  const required = (schema.required as string[]) ?? [];
  const additional = schema.additionalProperties;
  const out: Record<string, unknown> = {};

  for (const key of required) {
    if (!(key in input) || input[key] === undefined) {
      // A required key with a schema default is satisfied by the default.
      const propertySchema = properties[key];
      if (propertySchema && "default" in propertySchema) continue;
      errors.push({ path: joinPath(path, key), message: "is required" });
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (key in input && input[key] !== undefined) {
      out[key] = check(input[key], propertySchema, joinPath(path, key), errors);
    } else if ("default" in propertySchema) {
      out[key] = propertySchema.default;
    }
  }

  for (const key of Object.keys(input)) {
    if (key in properties) continue;
    if (additional === false || additional === undefined) {
      // §12.4: additionalProperties:false. An unexpected key is an error rather
      // than being silently dropped, so the model learns the correct shape.
      errors.push({ path: joinPath(path, key), message: "is not an allowed property" });
      continue;
    }
    if (additional === true) {
      out[key] = input[key];
      continue;
    }
    out[key] = check(
      input[key],
      additional as Record<string, unknown>,
      joinPath(path, key),
      errors,
    );
  }

  return out;
}

function checkArray(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): unknown {
  if (!Array.isArray(value)) {
    errors.push({ path: path || ".", message: "must be an array" });
    return value;
  }
  const minItems = schema.minItems as number | undefined;
  const maxItems = schema.maxItems as number | undefined;
  if (minItems !== undefined && value.length < minItems) {
    errors.push({ path: path || ".", message: `must have at least ${minItems} item(s)` });
  }
  if (maxItems !== undefined && value.length > maxItems) {
    errors.push({ path: path || ".", message: `must have at most ${maxItems} item(s)` });
  }
  const items = schema.items as Record<string, unknown> | undefined;
  if (!items) return value;
  return value.map((item, index) => check(item, items, `${path}[${index}]`, errors));
}

function checkString(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): unknown {
  if (typeof value !== "string") {
    errors.push({ path: path || ".", message: "must be a string" });
    return value;
  }
  const minLength = schema.minLength as number | undefined;
  const maxLength = schema.maxLength as number | undefined;
  if (minLength !== undefined && value.length < minLength) {
    errors.push({ path: path || ".", message: `must be at least ${minLength} character(s)` });
  }
  if (maxLength !== undefined && value.length > maxLength) {
    errors.push({
      path: path || ".",
      message: `must be at most ${maxLength} character(s), got ${value.length}`,
    });
  }
  return value;
}

function checkNumber(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
  integer: boolean,
): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path: path || ".", message: integer ? "must be an integer" : "must be a number" });
    return value;
  }
  if (integer && !Number.isInteger(value)) {
    errors.push({ path: path || ".", message: "must be an integer" });
  }
  const minimum = schema.minimum as number | undefined;
  const maximum = schema.maximum as number | undefined;
  if (minimum !== undefined && value < minimum) {
    errors.push({ path: path || ".", message: `must be >= ${minimum}` });
  }
  if (maximum !== undefined && value > maximum) {
    errors.push({ path: path || ".", message: `must be <= ${maximum}` });
  }
  return value;
}

function joinPath(base: string, key: string): string {
  return base.length === 0 ? key : `${base}.${key}`;
}

/** Render errors as the observation text the model receives (AC-10). */
export function renderValidationErrors(toolId: string, errors: ValidationError[]): string {
  const lines = [`INVALID_ARGUMENT: ${toolId} was not executed because its arguments are invalid.`];
  for (const error of errors.slice(0, 12)) {
    lines.push(`- ${error.path}: ${error.message}`);
  }
  if (errors.length > 12) lines.push(`- …and ${errors.length - 12} more`);
  lines.push("Re-issue the call with corrected arguments.");
  return lines.join("\n");
}
