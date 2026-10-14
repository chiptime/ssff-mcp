import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyEmployeeLink,
  classifyEntity,
  effectiveDateKey,
  isCustomMdfEntity,
  isEmployeeLinkedType,
  summarizeCustomMdf,
} from "../src/mdf.js";
import type { EntitySchema, NavigationProperty } from "../src/metadata.js";

function nav(name: string, targetEntitySet: string): NavigationProperty {
  return { name, targetEntitySet, relationship: `SFOData.${name}`, multiplicity: "0..1" };
}

function schema(entitySet: string, keys: string[], navs: NavigationProperty[] = []): EntitySchema {
  return {
    entitySet,
    entityType: `SFOData.${entitySet}`,
    keys,
    properties: keys.map((name) => ({ name, type: "Edm.String", nullable: false })),
    navigationProperties: [nav("createdByNav", "User"), nav("lastModifiedByNav", "User"), ...navs],
  };
}

function all(...schemas: EntitySchema[]): Record<string, EntitySchema> {
  return Object.fromEntries(schemas.map((s) => [s.entitySet, s]));
}

// --- S3: canonical custom MDF detection ---------------------------------------

test("isCustomMdfEntity matches cust_ and Cust_ prefixes only", () => {
  assert.equal(isCustomMdfEntity("cust_Equipo"), true);
  assert.equal(isCustomMdfEntity("Cust_Equipo"), true);
  assert.equal(isCustomMdfEntity("User"), false);
  assert.equal(isCustomMdfEntity("customer_x"), false);
  assert.equal(isCustomMdfEntity("xcust_a"), false);
  assert.equal(isCustomMdfEntity("CUST_A"), false);
  assert.equal(isCustomMdfEntity("cust"), false);
});

// --- S4: effective dating (D-69) ---------------------------------------------

test("effectiveDateKey detects effectiveStartDate and mdfSystemEffectiveStartDate keys", () => {
  assert.equal(effectiveDateKey(schema("cust_A", ["externalCode", "effectiveStartDate"])), "effectiveStartDate");
  assert.equal(
    effectiveDateKey(schema("cust_B", ["externalCode", "mdfSystemEffectiveStartDate"])),
    "mdfSystemEffectiveStartDate",
  );
  assert.equal(effectiveDateKey(schema("cust_C", ["externalCode"])), undefined);
});

// --- S4: the six link types, in order ----------------------------------------

test("DIRECT_USER_KEY: externalCode key with its own externalCodeNav to User", () => {
  const s = schema("cust_A", ["externalCode"], [nav("externalCodeNav", "User")]);
  assert.deepEqual(classifyEmployeeLink(s, all(s)), {
    type: "DIRECT_USER_KEY",
    targetEntitySet: "User",
    matchingField: "externalCode",
    navigationProperty: "externalCodeNav",
  });
});

test("DIRECT_USER_KEY: userId key with userIdNav", () => {
  const s = schema("cust_A", ["userId", "effectiveStartDate"], [nav("userIdNav", "User")]);
  const link = classifyEmployeeLink(s, all(s));
  assert.equal(link.type, "DIRECT_USER_KEY");
  assert.equal(link.matchingField, "userId");
  assert.equal(link.navigationProperty, "userIdNav");
});

test("audit navigations never create a link (createdByNav/lastModifiedByNav -> User)", () => {
  const s = schema("cust_A", ["externalCode"]);
  assert.equal(s.navigationProperties.length, 2);
  assert.equal(classifyEmployeeLink(s, all(s)).type, "UNLINKED_STANDALONE");
});

test("USER_FIELD_NAVIGATION: any non-audit User nav that is not the key's own nav", () => {
  const s = schema("cust_A", ["externalCode"], [nav("cust_GerenteNav", "User")]);
  assert.deepEqual(classifyEmployeeLink(s, all(s)), {
    type: "USER_FIELD_NAVIGATION",
    targetEntitySet: "User",
    matchingField: "cust_Gerente",
    navigationProperty: "cust_GerenteNav",
  });
});

test("the link signal is the target entity, not the nav name", () => {
  const user = schema("cust_A", ["externalCode"], [nav("whateverNav", "User")]);
  assert.equal(classifyEmployeeLink(user, all(user)).type, "USER_FIELD_NAVIGATION");
  const decoy = schema("cust_B", ["externalCode"], [nav("cust_userIdNav", "cust_Other")]);
  assert.equal(classifyEmployeeLink(decoy, all(decoy)).type, "UNLINKED_STANDALONE");
});

test("externalCode key with an unrelated User nav is a field link, not a key link", () => {
  const s = schema("cust_A", ["externalCode"], [nav("cust_Jefe_ServicioNav", "User")]);
  assert.equal(classifyEmployeeLink(s, all(s)).type, "USER_FIELD_NAVIGATION");
});

test("DIRECT_EMPLOYMENT_KEY and EMPLOYMENT_FIELD_NAVIGATION target EmpEmployment", () => {
  const direct = schema("cust_A", ["externalCode"], [nav("externalCodeNav", "EmpEmployment")]);
  assert.equal(classifyEmployeeLink(direct, all(direct)).type, "DIRECT_EMPLOYMENT_KEY");
  assert.equal(classifyEmployeeLink(direct, all(direct)).targetEntitySet, "EmpEmployment");
  const field = schema("cust_B", ["externalCode"], [nav("cust_empleoNav", "EmpEmployment")]);
  const link = classifyEmployeeLink(field, all(field));
  assert.equal(link.type, "EMPLOYMENT_FIELD_NAVIGATION");
  assert.equal(link.navigationProperty, "cust_empleoNav");
});

test("User link wins over EmpEmployment link (rule order)", () => {
  const s = schema("cust_A", ["externalCode"], [nav("cust_empleoNav", "EmpEmployment"), nav("externalCodeNav", "User")]);
  assert.equal(classifyEmployeeLink(s, all(s)).type, "DIRECT_USER_KEY");
});

test("COMPOSITE_CHILD requires the key pattern AND an existing custom parent", () => {
  const parent = schema("cust_ASOC_EPIS", ["externalCode"]);
  const child = schema("cust_ASOC_EPIS_Detalles", ["cust_ASOC_EPIS_externalCode", "externalCode"]);
  const link = classifyEmployeeLink(child, all(parent, child));
  assert.equal(link.type, "COMPOSITE_CHILD");
  assert.equal(link.parentEntitySet, "cust_ASOC_EPIS");

  const orphan = schema("cust_X_Detalles", ["cust_X_externalCode"]);
  assert.equal(classifyEmployeeLink(orphan, all(orphan)).type, "UNLINKED_STANDALONE");
});

test("a navigation to another cust_ entity alone does NOT make a composite child", () => {
  const other = schema("cust_Other", ["externalCode"]);
  const s = schema("cust_A", ["externalCode"], [nav("cust_OtherNav", "cust_Other")]);
  assert.equal(classifyEmployeeLink(s, all(other, s)).type, "UNLINKED_STANDALONE");
});

test("composite key pattern accepts effectiveStartDate and userId suffixes", () => {
  const parent = schema("cust_P", ["externalCode"]);
  for (const suffix of ["effectiveStartDate", "userId"]) {
    const child = schema("cust_P_c", [`cust_P_${suffix}`]);
    assert.equal(classifyEmployeeLink(child, all(parent, child)).type, "COMPOSITE_CHILD", suffix);
  }
});

test("isEmployeeLinkedType is true for the four direct kinds only", () => {
  assert.equal(isEmployeeLinkedType("DIRECT_USER_KEY"), true);
  assert.equal(isEmployeeLinkedType("DIRECT_EMPLOYMENT_KEY"), true);
  assert.equal(isEmployeeLinkedType("USER_FIELD_NAVIGATION"), true);
  assert.equal(isEmployeeLinkedType("EMPLOYMENT_FIELD_NAVIGATION"), true);
  assert.equal(isEmployeeLinkedType("COMPOSITE_CHILD"), false);
  assert.equal(isEmployeeLinkedType("UNLINKED_STANDALONE"), false);
});

// --- S5: guidance --------------------------------------------------------------

test("guidance for externalCode key: filter, orderby, top and example (effective-dated)", () => {
  const s = schema("cust_Equipo", ["externalCode", "effectiveStartDate"], [nav("externalCodeNav", "User")]);
  const details = classifyEntity(s, all(s), "es_ES");
  assert.equal(details.isCustom, true);
  assert.equal(details.isEffectiveDated, true);
  assert.deepEqual(details.keys, ["externalCode", "effectiveStartDate"]);
  assert.equal(details.guidance.locale, "es_ES");
  assert.equal(details.guidance.suggestedFilter, "externalCode eq '<userId>'");
  assert.equal(details.guidance.recommendedOrderBy, "effectiveStartDate desc");
  assert.deepEqual(details.guidance.exampleQuery, {
    tool: "query_entity",
    entityPath: "cust_Equipo",
    filter: "externalCode eq '1042'",
    orderby: "effectiveStartDate desc",
    top: 1,
  });
  assert.ok(details.guidance.warnings.some((w) => w.includes("224")));
  assert.ok(details.guidance.warnings.some((w) => w.includes("effectiveStartDate desc")));
});

test("guidance for userId key uses `userId eq`", () => {
  const s = schema("cust_A", ["userId"], [nav("userIdNav", "User")]);
  const guidance = classifyEntity(s, all(s)).guidance;
  assert.equal(guidance.suggestedFilter, "userId eq '<userId>'");
  assert.equal(guidance.recommendedOrderBy, undefined);
  assert.equal(guidance.exampleQuery.orderby, undefined);
  assert.equal(guidance.exampleQuery.top, 10);
});

test("guidance for a field link uses the navigation-segment form `<nav>/userId eq`", () => {
  const s = schema("cust_Prendas", ["externalCode"], [nav("cust_UsuarioNav", "User")]);
  const guidance = classifyEntity(s, all(s)).guidance;
  assert.equal(guidance.suggestedFilter, "cust_UsuarioNav/userId eq '<userId>'");
  assert.equal(guidance.exampleQuery.filter, "cust_UsuarioNav/userId eq '1042'");
});

test("mdfSystemEffectiveStartDate drives the order-by recommendation", () => {
  const s = schema("cust_AccionSocial", ["externalCode", "mdfSystemEffectiveStartDate"], [nav("externalCodeNav", "User")]);
  const details = classifyEntity(s, all(s));
  assert.equal(details.isEffectiveDated, true);
  assert.equal(details.guidance.recommendedOrderBy, "mdfSystemEffectiveStartDate desc");
});

test("unlinked and composite entities have no employee filter template", () => {
  const parent = schema("cust_P", ["externalCode"]);
  const child = schema("cust_P_c", ["cust_P_externalCode"]);
  const lonely = schema("cust_Catalogo", ["externalCode"]);
  for (const s of [child, lonely]) {
    const guidance = classifyEntity(s, all(parent, child, lonely)).guidance;
    assert.equal(guidance.suggestedFilter, undefined, s.entitySet);
    assert.equal(guidance.exampleQuery.filter, undefined, s.entitySet);
    assert.equal(guidance.exampleQuery.entityPath, s.entitySet);
  }
  const composite = classifyEntity(child, all(parent, child)).guidance;
  assert.ok(composite.warnings.some((w) => w.includes("cust_P")));
});

test("the reverse-navigation warning appears only when the link targets User", () => {
  const user = schema("cust_A", ["externalCode"], [nav("externalCodeNav", "User")]);
  const emp = schema("cust_B", ["externalCode"], [nav("externalCodeNav", "EmpEmployment")]);
  const lonely = schema("cust_C", ["externalCode"]);
  const has = (s: EntitySchema) => classifyEntity(s, all(user, emp, lonely)).guidance.warnings.some((w) => w.includes("224"));
  assert.equal(has(user), true);
  assert.equal(has(emp), false);
  assert.equal(has(lonely), false);
});

test("guidance prose is a single language and OData templates stay untranslated", () => {
  const s = schema("cust_A", ["externalCode", "effectiveStartDate"], [nav("externalCodeNav", "User")]);
  const en = classifyEntity(s, all(s), "en_US").guidance;
  const es = classifyEntity(s, all(s), "es_ES").guidance;
  assert.notDeepEqual(en.warnings, es.warnings);
  assert.equal(en.suggestedFilter, es.suggestedFilter);
  assert.deepEqual(en.exampleQuery, es.exampleQuery);
  assert.equal(en.locale, "en_US");
  assert.equal(es.locale, "es_ES");
});

test("guidance stays far below the 5 KB per-entity budget (DS-MDF-05)", () => {
  const s = schema("cust_Equipo", ["externalCode", "effectiveStartDate"], [nav("externalCodeNav", "User")]);
  assert.ok(JSON.stringify(classifyEntity(s, all(s)).guidance).length < 2000);
});

test("classification is pure: same input, same output, input untouched", () => {
  const s = schema("cust_A", ["externalCode"], [nav("cust_GerenteNav", "User")]);
  const snapshot = JSON.stringify(s);
  assert.deepEqual(classifyEntity(s, all(s)), classifyEntity(s, all(s)));
  assert.equal(JSON.stringify(s), snapshot);
});

test("details carry entityType, properties and navigationProperties of the schema", () => {
  const s = schema("cust_A", ["externalCode"], [nav("externalCodeNav", "User")]);
  const details = classifyEntity(s, all(s));
  assert.equal(details.entitySet, "cust_A");
  assert.equal(details.entityType, "SFOData.cust_A");
  assert.deepEqual(details.properties, s.properties);
  assert.deepEqual(details.navigationProperties, s.navigationProperties);
});

// --- S4/S7: compact summary ----------------------------------------------------

test("summarizeCustomMdf is flat and compact", () => {
  const s = schema("cust_Equipo", ["externalCode", "effectiveStartDate"], [nav("externalCodeNav", "User")]);
  assert.deepEqual(summarizeCustomMdf(s, all(s)), {
    name: "cust_Equipo",
    isEffectiveDated: true,
    linkType: "DIRECT_USER_KEY",
    targetEntity: "User",
    matchField: "externalCode",
  });
  const lonely = schema("cust_Catalogo", ["externalCode"]);
  assert.deepEqual(summarizeCustomMdf(lonely, all(lonely)), {
    name: "cust_Catalogo",
    isEffectiveDated: false,
    linkType: "UNLINKED_STANDALONE",
  });
});

// --- corrections after independent verification --------------------------------

test("S5: an effective-dated entity with no employee link still uses top=1 for the current record", () => {
  const s = schema("cust_Jerarquia", ["externalCode", "effectiveStartDate"]);
  const guidance = classifyEntity(s, all(s)).guidance;
  assert.equal(guidance.suggestedFilter, undefined);
  assert.equal(guidance.recommendedOrderBy, "effectiveStartDate desc");
  assert.equal(guidance.exampleQuery.filter, undefined);
  assert.equal(guidance.exampleQuery.orderby, "effectiveStartDate desc");
  assert.equal(guidance.exampleQuery.top, 1);
});

test("S5: a non effective-dated entity keeps a list-oriented example (no orderby, top 10)", () => {
  const s = schema("cust_Catalogo", ["externalCode"]);
  const guidance = classifyEntity(s, all(s)).guidance;
  assert.equal(guidance.recommendedOrderBy, undefined);
  assert.equal(guidance.exampleQuery.orderby, undefined);
  assert.equal(guidance.exampleQuery.top, 10);
});
