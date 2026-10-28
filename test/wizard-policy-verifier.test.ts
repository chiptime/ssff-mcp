import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

interface WizardState { catalog: string[]; rounds: (string[] | symbol)[]; retry: boolean | symbol; retries: number; selections: number; notes: string[] }
declare global { var __policyWizard: WizardState; }
const CANCEL = Symbol("cancel");
const prompts = [
  "const s=()=>globalThis.__policyWizard;",
  "export const select=async(o)=>o.message===\"Authentication type\"?\"basic\":\"none\";",
  "export const text=async(o)=>o.message===\"Environment alias\"?\"prod\":o.message.startsWith(\"Tenant base\")?\"https://policy.example.com\":\"u\";",
  "export const password=async()=>\"p\";",
  "export const confirm=async(o)=>o.message.startsWith(\"Restrict\")?true:(s().retries++,s().retry);",
  "export const autocompleteMultiselect=async()=>{s().selections++;return s().rounds.shift()};",
  "export const isCancel=(x)=>typeof x===\"symbol\";",
  "export const note=(x)=>s().notes.push(x); export const cancel=(x)=>s().notes.push(x);",
  "export const intro=()=>{}; export const outro=()=>{}; export const spinner=()=>({start(){},stop(){}});",
].join("\n");
// module.registerHooks exists from Node 22.15; the engines floor is Node 20,
// where these tests are skipped (CI runs them on its Node 22 job).
const registerHooks = (nodeModule as Partial<typeof nodeModule>).registerHooks;
const skip = registerHooks === undefined ? "module.registerHooks requires Node >= 22.15" : false;
let runInit: typeof import("../src/cli/init.js").runInit;
if (registerHooks !== undefined) {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "@clack/prompts") return { url: "data:text/javascript," + encodeURIComponent(prompts), shortCircuit: true };
    if (specifier === "./discovery.js" && context.parentURL?.endsWith("/cli/init.js")) return { url: "data:text/javascript," + encodeURIComponent("export const discoverEntities=async()=>globalThis.__policyWizard.catalog;"), shortCircuit: true };
    return next(specifier, context);
  } });
  ({ runInit } = await import("../src/cli/init.js"));
  hooks.deregister();
}

// L24 / invariant 7: exercise the actual collectAnswers -> runInit wiring.
test("wizard repeats empty USER selections; cancellation preserves existing bytes", { skip }, async () => {
  for (const [rounds, retry, success] of [
    [[[], [], ["User"]], true, true],
    [[CANCEL], true, false],
    [[[]], CANCEL, false],
    [[[]], false, false],
  ] as [(string[] | symbol)[], boolean | symbol, boolean][]) {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "wizard-independent-"));
    const configPath = path.join(dir, "config.json");
    if (!success) await fs.writeFile(configPath, "existing bytes\n", { mode: 0o600 });
    globalThis.__policyWizard = { catalog: ["User"], rounds, retry, retries: 0, selections: 0, notes: [] };
    const code = await runInit({ isTTY: true, configPath, stdout: () => {}, stderr: () => {} });
    assert.equal(code, success ? 0 : 130);
    if (success) {
      assert.equal(globalThis.__policyWizard.selections, 3);
      assert.equal(globalThis.__policyWizard.retries, 2);
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      assert.deepEqual(config.environments.prod.entityAllowlist, [{ entity: "User" }]);
    } else {
      assert.equal(globalThis.__policyWizard.selections, 1);
      assert.equal(await fs.readFile(configPath, "utf8"), "existing bytes\n");
      assert.deepEqual(globalThis.__policyWizard.notes, ["Cancelled; nothing was written"]);
    }
  }
});

// L24 / invariant 7: "restrict" must not finish successfully without a selection.
test("empty catalog cannot complete a requested restriction as an unrestricted config", { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "wizard-empty-catalog-"));
  const configPath = path.join(dir, "config.json");
  globalThis.__policyWizard = { catalog: [], rounds: [CANCEL], retry: CANCEL, retries: 0, selections: 0, notes: [] };
  const code = await runInit({ isTTY: true, configPath, stdout: () => {}, stderr: () => {} });
  assert.equal(code, 130);
  await assert.rejects(fs.stat(configPath), { code: "ENOENT" });
});
