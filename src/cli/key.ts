import { randomBytes } from "node:crypto";
import { sha256Hex } from "../tenancy.js";

/** Prefix marking a generated MCP personal access token (nothing else uses it). */
const TOKEN_PREFIX = "ssff_pat_";

/** Never take a credential in argv: process listings and shell history leak it. */
export async function runKeyHash(): Promise<number> {
  if (process.stdin.isTTY) {
    process.stderr.write("ssff-mcp: pipe the key on stdin; no credential is accepted in arguments\n");
    return 2;
  }
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 16_384) {
      process.stderr.write("ssff-mcp: key input is too large\n");
      return 2;
    }
  }
  const key = input.replace(/\r?\n$/, "");
  if (key.length === 0 || /[\r\n]/.test(key) || key.trim() !== key) {
    process.stderr.write("ssff-mcp: stdin must contain one non-empty key without surrounding whitespace\n");
    return 2;
  }
  process.stdout.write(`${sha256Hex(key)}\n`);
  return 0;
}

/**
 * Generate a personal access token (local-user-tokens S2): 32 random bytes,
 * base64url, `ssff_pat_` prefix. Prints the token exactly once as a single
 * JSON line (`token`, `tokenHash`); only the hash belongs in server config.
 * Takes no input, accepts no arguments (the dispatcher rejects any) and
 * writes nothing to stderr: the secret appears only on success.
 */
export function runKeyGenerate(): number {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  process.stdout.write(`${JSON.stringify({ token, tokenHash: sha256Hex(token) })}\n`);
  return 0;
}
