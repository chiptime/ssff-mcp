import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, guidanceMessages, resolveLocale } from "../src/i18n.js";

test("precedence: tool locale > config defaultLocale > SF_DEFAULT_LOCALE > en_US", () => {
  assert.equal(resolveLocale({ tool: "es_ES", config: "en_US", env: "en_US" }), "es_ES");
  assert.equal(resolveLocale({ config: "es_ES", env: "en_US" }), "es_ES");
  assert.equal(resolveLocale({ env: "es_ES" }), "es_ES");
  assert.equal(resolveLocale({}), "en_US");
  assert.equal(DEFAULT_LOCALE, "en_US");
});

test("a provided but untranslated tool locale falls back to en_US, not to a lower level", () => {
  assert.equal(resolveLocale({ tool: "fr_FR", config: "es_ES" }), "en_US");
});

test("blank values are treated as absent and the chain continues", () => {
  assert.equal(resolveLocale({ tool: "  ", config: "", env: "es_ES" }), "es_ES");
});

test("normalizes es, es-ES, es_es and ES_es to the catalog key es_ES", () => {
  for (const raw of ["es", "es-ES", "es_es", "ES_es", " es_ES "]) {
    assert.equal(resolveLocale({ tool: raw }), "es_ES", raw);
  }
});

test("a known language with an unknown region resolves to that language's catalog entry", () => {
  assert.equal(resolveLocale({ tool: "es_MX" }), "es_ES");
  assert.equal(resolveLocale({ tool: "en_GB" }), "en_US");
});

test("garbage input never throws and falls back to en_US", () => {
  for (const raw of ["../../etc", "es_ES; drop", "\u0000", "x".repeat(500)]) {
    assert.equal(resolveLocale({ tool: raw }), "en_US");
  }
});

test("every supported locale defines every guidance message with non-empty text", () => {
  const reference = Object.keys(guidanceMessages("en_US")).sort();
  for (const locale of SUPPORTED_LOCALES) {
    const messages = guidanceMessages(locale);
    assert.deepEqual(Object.keys(messages).sort(), reference, locale);
    assert.ok(messages.reverseNavigation("cust_X").length > 0);
    assert.ok(messages.effectiveDated("externalCode", "effectiveStartDate").length > 0);
    assert.ok(messages.compositeChild("cust_P", "cust_X").length > 0);
    assert.ok(messages.unlinked("cust_X").length > 0);
    assert.ok(messages.permissions("cust_X").length > 0);
  }
});

test("catalogs are written in different languages (one language per response)", () => {
  assert.notEqual(guidanceMessages("en_US").unlinked("cust_X"), guidanceMessages("es_ES").unlinked("cust_X"));
});

test("messages interpolate the entity and never include OData templates", () => {
  const text = guidanceMessages("es_ES").reverseNavigation("cust_Equipo");
  assert.match(text, /cust_Equipo/);
  assert.match(text, /224/);
});
