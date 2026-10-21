import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SAP_DATA_CENTERS,
  resolveDataCenter,
  findDataCenterByWebUrl,
  isWebPortalUrl,
  suggestApiBaseUrl,
  type DataCenterDefinition,
} from "../src/datacenters.js";

describe("SAP Data Centers Catalog (FR-108, D-82)", () => {
  it("exports an immutable catalog of 20+ SAP SuccessFactors data centers", () => {
    const keys = Object.keys(SAP_DATA_CENTERS);
    assert.ok(keys.length >= 20, `expected at least 20 data centers, got ${keys.length}`);

    for (const [code, dc] of Object.entries(SAP_DATA_CENTERS)) {
      assert.equal(dc.code, code);
      assert.ok(dc.name.length > 0, `name should be non-empty for ${code}`);
      assert.ok(
        ["EMEA", "NA", "APJ", "LATAM", "GOV"].includes(dc.region),
        `invalid region ${dc.region} for ${code}`
      );
      assert.ok(
        ["production", "preview"].includes(dc.environmentType),
        `invalid environmentType ${dc.environmentType} for ${code}`
      );
      assert.ok(dc.apiHost.length > 0, `apiHost should be non-empty for ${code}`);
      assert.equal(dc.apiBaseUrl, `https://${dc.apiHost}`);
      assert.equal(dc.oauthTokenUrl, `https://${dc.apiHost}/oauth/token`);
      assert.ok(Array.isArray(dc.webPortalDomains), `webPortalDomains should be array for ${code}`);
    }
  });

  describe("resolveDataCenter", () => {
    it("resolves exactly by uppercase canonical code", () => {
      const dc2 = resolveDataCenter("DC2");
      assert.ok(dc2);
      assert.equal(dc2.code, "DC2");
      assert.equal(dc2.apiHost, "api2.successfactors.eu");
      assert.equal(dc2.apiBaseUrl, "https://api2.successfactors.eu");

      const dc4 = resolveDataCenter("DC4");
      assert.ok(dc4);
      assert.equal(dc4.code, "DC4");
      assert.equal(dc4.apiHost, "api4.successfactors.com");
    });

    it("resolves case-insensitively and handles whitespace or prefixes", () => {
      assert.equal(resolveDataCenter("dc2")?.code, "DC2");
      assert.equal(resolveDataCenter("  DC4  ")?.code, "DC4");
      assert.equal(resolveDataCenter("dc12")?.code, "DC12");
      assert.equal(resolveDataCenter("Dc55")?.code, "DC55");
      assert.equal(resolveDataCenter("dc02")?.code, "DC2");
    });

    it("resolves by API hostname or full URL", () => {
      assert.equal(resolveDataCenter("api2.successfactors.eu")?.code, "DC2");
      assert.equal(resolveDataCenter("https://api2.successfactors.eu")?.code, "DC2");
      assert.equal(resolveDataCenter("https://api4.successfactors.com/odata/v2")?.code, "DC4");
      assert.equal(resolveDataCenter("api55.sapsf.eu")?.code, "DC55");
    });

    it("returns undefined for unknown identifiers", () => {
      assert.equal(resolveDataCenter(""), undefined);
      assert.equal(resolveDataCenter("DC999"), undefined);
      assert.equal(resolveDataCenter("invalid.host.example.com"), undefined);
    });
  });

  describe("Web Portal Detection (FR-113, D-87)", () => {
    it("identifies SuccessFactors web portal URLs", () => {
      assert.equal(isWebPortalUrl("https://performancemanager.successfactors.eu/login"), true);
      assert.equal(isWebPortalUrl("performancemanager4.successfactors.com"), true);
      assert.equal(isWebPortalUrl("https://pmsalesdemo8.successfactors.com/sf/liveprofile"), true);
      assert.equal(isWebPortalUrl("https://performancemanager15.sapsf.cn"), true);
    });

    it("returns false for legitimate API server URLs", () => {
      assert.equal(isWebPortalUrl("https://api2.successfactors.eu"), false);
      assert.equal(isWebPortalUrl("api4.successfactors.com"), false);
      assert.equal(isWebPortalUrl("https://api55.sapsf.eu/odata/v2"), false);
      assert.equal(isWebPortalUrl("https://custom-gateway.internal.corp"), false);
    });

    it("maps web portal URLs to the corresponding data center", () => {
      const dc2 = findDataCenterByWebUrl("https://performancemanager.successfactors.eu");
      assert.ok(dc2);
      assert.equal(dc2.code, "DC2");

      const dc4 = findDataCenterByWebUrl("performancemanager4.successfactors.com/sf/home");
      assert.ok(dc4);
      assert.equal(dc4.code, "DC4");

      const dc8 = findDataCenterByWebUrl("performancemanager8.successfactors.com");
      assert.ok(dc8);
      assert.equal(dc8.code, "DC8");

      const dc12 = findDataCenterByWebUrl("https://performancemanager12.successfactors.eu");
      assert.ok(dc12);
      assert.equal(dc12.code, "DC12");

      const dc68 = findDataCenterByWebUrl("https://pmsalesdemo8.successfactors.com");
      assert.ok(dc68);
      assert.equal(dc68.code, "DC68");
    });

    it("suggestApiBaseUrl suggests the correct API base URL for a web portal URL", () => {
      const suggestion = suggestApiBaseUrl("https://performancemanager.successfactors.eu/login");
      assert.ok(suggestion);
      assert.equal(suggestion.dataCenter.code, "DC2");
      assert.equal(suggestion.suggestedBaseUrl, "https://api2.successfactors.eu");
    });
  });
});
