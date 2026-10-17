import test from "node:test";
import assert from "node:assert/strict";
import { MetadataService } from "../src/metadata.js";
import { envTargetFor } from "../src/http.js";
import { isSanitizedError } from "../src/errors.js";
import { mdfMetadataXml, recordingFetch, xmlResponse } from "./helpers.js";

const env = envTargetFor({ baseUrl: "https://tenant-a.example.com", auth: { type: "basic", username: "u", password: "p" } }, "a");

function service() {
  const rec = recordingFetch(() => xmlResponse(mdfMetadataXml()));
  return { service: new MetadataService({ fetchImpl: rec.fetch }), requests: rec.requests };
}

test("listCustomMdf lists only cust_* entities, sorted, classified from metadata", async () => {
  const { service: svc } = service();
  const list = await svc.listCustomMdf(env, "a");
  assert.deepEqual(
    list.map((item) => [item.name, item.linkType]),
    [
      ["cust_Catalogo", "UNLINKED_STANDALONE"],
      ["cust_Equipo", "DIRECT_USER_KEY"],
      ["cust_Equipo_Detalle", "COMPOSITE_CHILD"],
      ["cust_Prendas", "USER_FIELD_NAVIGATION"],
      ["cust_Social", "DIRECT_USER_KEY"],
    ],
  );
  assert.equal(list.find((i) => i.name === "cust_Social")?.isEffectiveDated, true);
});

test("employeeLinkedOnly keeps the four direct link kinds and drops composite/unlinked", async () => {
  const { service: svc } = service();
  const list = await svc.listCustomMdf(env, "a", undefined, true);
  assert.deepEqual(list.map((i) => i.name), ["cust_Equipo", "cust_Prendas", "cust_Social"]);
});

test("listCustomMdf respects the allowlist and an empty allowlist narrows nothing", async () => {
  const { service: svc } = service();
  const some = await svc.listCustomMdf(env, "a", [{ entity: "cust_Equipo" }, { entity: "User" }]);
  assert.deepEqual(some.map((i) => i.name), ["cust_Equipo"]);
  // `[]` narrows nothing, so it returns the same catalog as passing no list.
  assert.deepEqual(
    (await svc.listCustomMdf(env, "a", [])).map((i) => i.name),
    (await svc.listCustomMdf(env, "a", undefined)).map((i) => i.name),
  );
});

test("an allowlist entry limited to v4 does not expose the entity (v2 is the active protocol)", async () => {
  const { service: svc } = service();
  assert.deepEqual(await svc.listCustomMdf(env, "a", [{ entity: "cust_Equipo", protocols: ["v4"] }]), []);
});

test("getCustomMdfDetails returns classification and guidance in the requested locale", async () => {
  const { service: svc } = service();
  const details = await svc.getCustomMdfDetails(env, "a", "cust_Equipo", undefined, "es_ES");
  assert.equal(details?.employeeLink.type, "DIRECT_USER_KEY");
  assert.equal(details?.guidance.locale, "es_ES");
  assert.equal(details?.isEffectiveDated, true);
});

test("getCustomMdfDetails: unknown and non-custom entities yield undefined", async () => {
  const { service: svc } = service();
  assert.equal(await svc.getCustomMdfDetails(env, "a", "cust_Nope"), undefined);
  assert.equal(await svc.getCustomMdfDetails(env, "a", "User"), undefined);
});

test("getCustomMdfDetails: a denied entity throws before metadata is touched; [] narrows nothing", async () => {
  const { service: svc, requests } = service();
  await assert.rejects(
    () => svc.getCustomMdfDetails(env, "a", "cust_Equipo", [{ entity: "User" }]),
    (error: unknown) => isSanitizedError(error) && error.code === "ENTITY_NOT_ALLOWED",
  );
  // The denial happens before any fetch.
  assert.equal(requests.length, 0);
  // An empty allowlist narrows nothing, so the entity is served normally.
  assert.ok((await svc.getCustomMdfDetails(env, "a", "cust_Equipo", [])) !== undefined);
});

test("zero-network: discovery reuses the cached metadata and issues no data request", async () => {
  const { service: svc, requests } = service();
  await svc.listCustomMdf(env, "a");
  await svc.getCustomMdfDetails(env, "a", "cust_Equipo");
  await svc.listCustomMdf(env, "a", undefined, true);
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.url.endsWith("/$metadata"));
});
