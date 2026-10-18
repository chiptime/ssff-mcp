import { sha256Hex } from "../tenancy.js";

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
