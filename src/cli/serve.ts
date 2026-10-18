/**
 * `ssff-mcp serve` — the hosted mode CLI (FR-154/FR-155/FR-163).
 *
 * Starts the HTTP edge, logs one line, and shuts down gracefully on
 * SIGTERM/SIGINT: stop accepting connections, close every session and exit
 * within 10 seconds (rolling deployments must not hang).
 */

import { startHttpServer, type RunningHttpServer } from "../server-http.js";
import { PACKAGE_VERSION } from "../version.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ServeCliResult {
  server: RunningHttpServer;
  /** Resolves when a shutdown signal has been fully handled. */
  done: Promise<void>;
}

export async function runServeHttp(options: {
  port?: number;
  host?: string;
  configPath?: string;
}): Promise<ServeCliResult> {
  const server = await startHttpServer(options);
  process.stderr.write(
    `ssff-mcp ${PACKAGE_VERSION} serving on http://${options.host ?? "0.0.0.0"}:${server.port}/mcp (read-only, API-key authenticated)\n`,
  );

  let doneResolve: () => void;
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const shutdown = (signal: string) => {
    process.stderr.write(`ssff-mcp: ${signal} received, shutting down\n`);
    const hardExit = setTimeout(() => {
      process.stderr.write("ssff-mcp: shutdown timed out, exiting\n");
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    hardExit.unref();
    void server
      .close()
      .catch(() => undefined)
      .then(() => {
        clearTimeout(hardExit);
        doneResolve();
      });
    // Only the first signal starts a shutdown; a second one may force-exit.
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
  };
  const onTerm = () => shutdown("SIGTERM");
  const onInt = () => shutdown("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  return { server, done };
}
