/**
 * Renders the tools reference (docs/tools.md) from the tool catalog, so the
 * documentation cannot drift from the registered tools.
 *
 * The argument STRUCTURE (name, type, required) is introspected from the Zod
 * schema; the description comes from the schema's `.describe()` when present, or
 * from `ARG_DESCRIPTIONS` below otherwise. `test/docs-tools-sync.test.ts` fails
 * when the committed doc differs from this output.
 */

import { z } from "zod";
import { TOOL_CATALOG, type ToolCatalogEntry } from "./tool-catalog.js";

export const TOOLS_MARKER_START = "<!-- START GENERATED: tools -->";
export const TOOLS_MARKER_END = "<!-- END GENERATED: tools -->";

/**
 * Documentation copy for arguments whose schema carries no description. Keyed by
 * `<tool>.<argument>`. Structure never lives here (that comes from the schema).
 */
const ARG_DESCRIPTIONS: Record<string, string> = {
  "query_entity.environment": "Required; must be a configured alias. Optional in inline mode (a single configured environment).",
  "query_entity.entityPath":
    "Resource path: an entity set, an entity by key, or a bounded navigation. Examples: `User`, `User('123')`, `Foobar(key1='a',key2=1)/navProperty`. Max 4 segments and 512 chars; `$`-prefixed segments are rejected.",
  "query_entity.filter": "Raw OData value, passed through unmodified (`$filter`).",
  "query_entity.orderby": "Raw OData value, passed through unmodified (`$orderby`).",
  "query_entity.select": "Raw OData value, passed through unmodified (`$select`).",
  "query_entity.expand": "Raw OData value, passed through unmodified (`$expand`).",
  "query_entity.top": "`$top`: integer >= 1. Above 1000 it is clamped to 1000 and flagged (`topClamped`).",
  "query_entity.skip": "`$skip`: integer 0..1,000,000. Cannot be combined with `cursor`.",
  "inspect_entity.environment":
    "Required; must be a configured alias. Optional in inline mode (a single configured environment).",
  "batch_get.environment":
    "Required; must be a configured alias. Optional in inline mode (a single configured environment).",
  "batch_get.requests":
    "Array of 1..180 items (SAP `$batch` hard limit). Each item uses exactly the `query_entity` GET grammar. There is no field for HTTP method, URL, host, headers, body or changesets.",
};

interface ArgRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** Unwrap Optional/Nullable/Default wrappers to reach the underlying type. */
function unwrap(schema: unknown): { typeName: string; def: Record<string, unknown> } {
  let current = schema as { _def?: Record<string, unknown> };
  for (;;) {
    const def = current?._def;
    const typeName = def?.typeName as string | undefined;
    if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
      current = def?.innerType as { _def?: Record<string, unknown> };
      continue;
    }
    return { typeName: typeName ?? "unknown", def: (def ?? {}) as Record<string, unknown> };
  }
}

/** Human-readable type for a schema node. */
function typeOf(schema: unknown): string {
  const { typeName, def } = unwrap(schema);
  switch (typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      return ((def.values as string[] | undefined) ?? []).map((value) => `"${value}"`).join(" | ");
    case "ZodArray":
      return `array<${typeOf(def.type)}>`;
    case "ZodObject":
      return "object";
    default:
      return typeName.replace(/^Zod/, "").toLowerCase();
  }
}

function isRequired(schema: unknown): boolean {
  const optional = (schema as { isOptional?: () => boolean }).isOptional;
  return typeof optional === "function" ? !optional.call(schema) : true;
}

function descriptionOf(schema: unknown): string | undefined {
  return (schema as { description?: string }).description;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Argument rows for one tool (empty for a tool with no arguments). */
export function toolArgRows(entry: ToolCatalogEntry): ArgRow[] {
  const shape = (entry.schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (shape === undefined) {
    return [];
  }
  return Object.entries(shape).map(([name, field]) => ({
    name,
    type: typeOf(field),
    required: isRequired(field),
    description: descriptionOf(field) ?? ARG_DESCRIPTIONS[`${entry.name}.${name}`] ?? "",
  }));
}

/** Render one tool as a `###` block with its argument table. */
function renderTool(entry: ToolCatalogEntry): string {
  const rows = toolArgRows(entry);
  const header = `### \`${entry.name}\`\n\n_${escapeCell(entry.title)}._\n\n${entry.description}`;
  if (rows.length === 0) {
    return `${header}\n\nNo arguments.\n`;
  }
  const table = [
    "| Argument | Type | Required | Description |",
    "|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| \`${row.name}\` | ${escapeCell(row.type)} | ${row.required ? "yes" : "no"} | ${escapeCell(row.description)} |`,
    ),
  ].join("\n");
  return `${header}\n\n${table}\n`;
}

/** The full generated tools section (no markers). */
export function renderToolsSection(entries: readonly ToolCatalogEntry[] = TOOL_CATALOG): string {
  return entries.map(renderTool).join("\n");
}

/**
 * Replace the region between the tools markers in a markdown document with the
 * freshly generated section. Throws when the markers are missing.
 */
export function replaceToolsSection(markdown: string, entries: readonly ToolCatalogEntry[] = TOOL_CATALOG): string {
  const start = markdown.indexOf(TOOLS_MARKER_START);
  const end = markdown.indexOf(TOOLS_MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("docs/tools.md is missing the tools generation markers");
  }
  const head = markdown.slice(0, start + TOOLS_MARKER_START.length);
  const tail = markdown.slice(end);
  return `${head}\n${renderToolsSection(entries)}\n${tail}`;
}
