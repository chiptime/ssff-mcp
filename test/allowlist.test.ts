import test from "node:test";
import assert from "node:assert/strict";
import { isEntityAllowed, type AllowlistEntry } from "../src/allowlist.js";

test("no allowlist configured (undefined) allows any entity", () => {
  assert.equal(isEntityAllowed(undefined, "User"), true);
  assert.equal(isEntityAllowed(undefined, "Anything_Else42"), true);
});

test("listed entity with protocols omitted is allowed (both protocols)", () => {
  const allowlist: AllowlistEntry[] = [{ entity: "User" }];
  assert.equal(isEntityAllowed(allowlist, "User"), true);
  assert.equal(isEntityAllowed(allowlist, "User", "v4"), true);
});

test("entity absent from the allowlist is denied", () => {
  const allowlist: AllowlistEntry[] = [{ entity: "User" }];
  assert.equal(isEntityAllowed(allowlist, "JobRequisition"), false);
});

test("matching is case-sensitive and exact", () => {
  const allowlist: AllowlistEntry[] = [{ entity: "User" }];
  assert.equal(isEntityAllowed(allowlist, "user"), false);
  assert.equal(isEntityAllowed(allowlist, "USER"), false);
  assert.equal(isEntityAllowed(allowlist, "User Peterson"), false);

  // And symmetrically: a differently-cased entry only matches its exact case.
  const lower: AllowlistEntry[] = [{ entity: "photo" }];
  assert.equal(isEntityAllowed(lower, "photo"), true);
  assert.equal(isEntityAllowed(lower, "Photo"), false);
});

test("protocols [\"v2\"] allows v2 only", () => {
  const allowlist: AllowlistEntry[] = [{ entity: "User", protocols: ["v2"] }];
  assert.equal(isEntityAllowed(allowlist, "User"), true); // default protocol is v2
  assert.equal(isEntityAllowed(allowlist, "User", "v2"), true);
  assert.equal(isEntityAllowed(allowlist, "User", "v4"), false);
});

test("protocols [\"v4\"] denies the entity in this phase (DS-P2-03)", () => {
  const allowlist: AllowlistEntry[] = [{ entity: "User", protocols: ["v4"] }];
  assert.equal(isEntityAllowed(allowlist, "User"), false); // default protocol is v2
  assert.equal(isEntityAllowed(allowlist, "User", "v2"), false);
  assert.equal(isEntityAllowed(allowlist, "User", "v4"), true);
});

test("protocols [\"v2\",\"v4\"] allows both", () => {
  const allowlist: AllowlistEntry[] = [{ entity: "User", protocols: ["v2", "v4"] }];
  assert.equal(isEntityAllowed(allowlist, "User", "v2"), true);
  assert.equal(isEntityAllowed(allowlist, "User", "v4"), true);
});

test("an empty allowlist array denies everything (configured deny-all)", () => {
  const allowlist: AllowlistEntry[] = [];
  assert.equal(isEntityAllowed(allowlist, "User"), false);
  assert.equal(isEntityAllowed(allowlist, "User", "v4"), false);
  assert.equal(isEntityAllowed(allowlist, "Whatever"), false);
});

test("entries are independent: one restricted entry does not affect others", () => {
  const allowlist: AllowlistEntry[] = [
    { entity: "User" },
    { entity: "JobRequisition", protocols: ["v4"] },
    { entity: "FOOBar", protocols: ["v2"] },
  ];
  assert.equal(isEntityAllowed(allowlist, "User"), true);
  assert.equal(isEntityAllowed(allowlist, "JobRequisition"), false); // v4-only, denied on v2
  assert.equal(isEntityAllowed(allowlist, "FOOBar"), true);
});
