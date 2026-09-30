/**
 * Stderr-only JSON-line operation logger.
 *
 * stdout is the MCP protocol channel: `console.log` is forbidden anywhere in
 * this codebase. Log lines carry operation metadata only, with a fixed
 * allowlist of fields. Never log URLs, entity paths, query values, bodies or
 * credentials.
 */

export type LogOutcome = "ok" | "error";

export interface LogFields {
  tool: string;
  environment?: string;
  outcome: LogOutcome;
  code?: string;
  durationMs: number;
  recordCount?: number;
}

/** Fields that may ever appear in a log line. */
export const LOG_FIELD_ALLOWLIST = new Set([
  "ts",
  "tool",
  "environment",
  "outcome",
  "code",
  "durationMs",
  "recordCount",
]);

export type LogSink = (line: string) => void;

function defaultStderrSink(line: string): void {
  process.stderr.write(line);
}

export type Logger = (fields: LogFields) => void;

export function makeLogger(sink: LogSink = defaultStderrSink): Logger {
  return (fields: LogFields): void => {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      tool: fields.tool,
    };
    if (fields.environment !== undefined) {
      entry.environment = fields.environment;
    }
    entry.outcome = fields.outcome;
    if (fields.code !== undefined) {
      entry.code = fields.code;
    }
    entry.durationMs = fields.durationMs;
    if (fields.recordCount !== undefined) {
      entry.recordCount = fields.recordCount;
    }
    sink(JSON.stringify(entry) + "\n");
  };
}
