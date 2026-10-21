/**
 * Static catalog and resolution utilities for SAP SuccessFactors Data Centers.
 *
 * Implements PRD-feature-datacenter-catalog.md (D-82..D-88, FR-108..FR-115).
 * Maps canonical data center codes (e.g. "DC2", "DC4", "DC55") and web portal
 * hostnames to canonical OData v2 API Server base URLs and OAuth token endpoints.
 */

export interface DataCenterDefinition {
  /** Canonical data center identifier (e.g. "DC2", "DC4", "DC12", "DC55"). */
  code: string;
  /** Descriptive human-readable location and region name. */
  name: string;
  /** Macro region. */
  region: "EMEA" | "NA" | "APJ" | "LATAM" | "GOV";
  /** Environment tier: production or preview/staging. */
  environmentType: "production" | "preview";
  /** Canonical OData API hostname (e.g. "api2.successfactors.eu"). */
  apiHost: string;
  /** Full base URL without trailing slash (e.g. "https://api2.successfactors.eu"). */
  apiBaseUrl: string;
  /** Canonical OAuth 2.0 token issuance endpoint. */
  oauthTokenUrl: string;
  /** Typical web portal domain patterns associated with this DC. */
  webPortalDomains: readonly string[];
}

function makeDc(
  code: string,
  name: string,
  region: DataCenterDefinition["region"],
  environmentType: DataCenterDefinition["environmentType"],
  apiHost: string,
  webPortalDomains: string[] = []
): DataCenterDefinition {
  return Object.freeze({
    code,
    name,
    region,
    environmentType,
    apiHost,
    apiBaseUrl: `https://${apiHost}`,
    oauthTokenUrl: `https://${apiHost}/oauth/token`,
    webPortalDomains: Object.freeze([...webPortalDomains]),
  });
}

/**
 * Immutable catalog of canonical SAP SuccessFactors Data Centers.
 */
export const SAP_DATA_CENTERS: Record<string, DataCenterDefinition> = Object.freeze({
  DC2: makeDc("DC2", "Europe (Amsterdam, Netherlands)", "EMEA", "production", "api2.successfactors.eu", [
    "performancemanager.successfactors.eu",
    "performancemanager2.successfactors.eu",
  ]),
  DC4: makeDc("DC4", "US East (Ashburn / Chandler, VA, US)", "NA", "production", "api4.successfactors.com", [
    "performancemanager4.successfactors.com",
  ]),
  DC8: makeDc("DC8", "US East (Ashburn, VA - Preview)", "NA", "preview", "api8.successfactors.com", [
    "performancemanager8.successfactors.com",
  ]),
  DC10: makeDc("DC10", "APJ (Sydney, Australia)", "APJ", "production", "api10.successfactors.com", [
    "performancemanager10.successfactors.com",
  ]),
  DC12: makeDc("DC12", "Europe (Rot / Frankfurt, Germany)", "EMEA", "production", "api12.successfactors.eu", [
    "performancemanager12.successfactors.eu",
    "api012.successfactors.eu",
  ]),
  DC15: makeDc("DC15", "APJ (Shanghai, China)", "APJ", "production", "api15.sapsf.cn", [
    "performancemanager15.sapsf.cn",
  ]),
  DC16: makeDc("DC16", "Middle East (Riyadh, Saudi Arabia Gov)", "GOV", "production", "api16.sapsf.com", [
    "performancemanager16.sapsf.com",
  ]),
  DC17: makeDc("DC17", "North America (Toronto, Canada)", "NA", "production", "api17.sapsf.com", [
    "performancemanager17.sapsf.com",
  ]),
  DC17preview: makeDc("DC17preview", "North America (Toronto, Canada - Preview)", "NA", "preview", "api17preview.sapsf.com", [
    "performancemanager17preview.sapsf.com",
  ]),
  DC18: makeDc("DC18", "Europe (Rot, Germany - Preview)", "EMEA", "preview", "api18.sapsf.eu", [
    "performancemanager18.sapsf.eu",
  ]),
  DC19: makeDc("DC19", "Latin America (São Paulo, Brazil)", "LATAM", "production", "api19.sapsf.com", [
    "performancemanager19.sapsf.com",
  ]),
  DC19preview: makeDc("DC19preview", "Latin America (São Paulo, Brazil - Preview)", "LATAM", "preview", "api19preview.sapsf.com", [
    "performancemanager19preview.sapsf.com",
  ]),
  DC22: makeDc("DC22", "Middle East (Dubai, UAE)", "EMEA", "production", "api22.sapsf.com", [
    "performancemanager22.sapsf.com",
  ]),
  DC22preview: makeDc("DC22preview", "Middle East (Dubai, UAE - Preview)", "EMEA", "preview", "api22preview.sapsf.com", [
    "performancemanager22preview.sapsf.com",
  ]),
  DC23: makeDc("DC23", "Middle East / APJ (Riyadh, Saudi Arabia / Tokyo)", "APJ", "production", "api23.sapsf.com", [
    "performancemanager23.sapsf.com",
  ]),
  DC23preview: makeDc("DC23preview", "Middle East / APJ (Riyadh / Tokyo - Preview)", "APJ", "preview", "api23preview.sapsf.com", [
    "performancemanager23preview.sapsf.com",
  ]),
  DC41: makeDc("DC41", "North America (Virginia, US - Azure)", "NA", "production", "api41.sapsf.com", [
    "performancemanager41.sapsf.com",
  ]),
  DC41preview: makeDc("DC41preview", "North America (Virginia, US - Azure Preview)", "NA", "preview", "api41preview.sapsf.com", [
    "performancemanager41preview.sapsf.com",
  ]),
  DC44: makeDc("DC44", "Europe / APJ (Frankfurt / Singapore - GCP)", "EMEA", "production", "api44.sapsf.com", [
    "performancemanager44.sapsf.com",
  ]),
  DC44preview: makeDc("DC44preview", "Cloud Hyperscaler - Preview", "EMEA", "preview", "api44preview.sapsf.com", [
    "performancemanager44preview.sapsf.com",
  ]),
  DC55: makeDc("DC55", "Europe (Frankfurt / Amsterdam - GCP)", "EMEA", "production", "api55.sapsf.eu", [
    "performancemanager55.sapsf.eu",
  ]),
  DC55preview: makeDc("DC55preview", "Europe (Frankfurt - GCP Preview)", "EMEA", "preview", "api55preview.sapsf.eu", [
    "performancemanager55preview.sapsf.eu",
  ]),
  DC68: makeDc("DC68", "US Central (SalesDemo / Hyperscaler Preview)", "NA", "preview", "api68sales.sapsf.com", [
    "pmsalesdemo8.successfactors.com",
    "salesdemo4.successfactors.com",
    "performancemanager68sales.sapsf.com",
  ]),
});

/**
 * Extracts a normalized hostname from a string that may be a URL or a bare host.
 */
function normalizeHost(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const url = new URL(candidate);
    return url.hostname.toLowerCase();
  } catch {
    return trimmed.split("/")[0].split(":")[0];
  }
}

/**
 * Resolves a DataCenterDefinition from an identifier:
 * - By canonical code: "DC2", "dc2", "DC02", "dc55"
 * - By API host: "api2.successfactors.eu", "https://api2.successfactors.eu"
 * - By partial match on code or host.
 */
export function resolveDataCenter(identifier: string): DataCenterDefinition | undefined {
  if (!identifier) return undefined;
  const raw = identifier.trim();
  if (!raw) return undefined;

  // 1. Direct code lookup (case-insensitive, normalized)
  const normalizedCode = raw.toUpperCase().replace(/\s+/g, "");
  if (SAP_DATA_CENTERS[normalizedCode]) {
    return SAP_DATA_CENTERS[normalizedCode];
  }

  // Handle leading zero in code (e.g. "DC02" -> "DC2")
  const strippedZeroCode = normalizedCode.replace(/^DC0+(\d+)$/, "DC$1");
  if (SAP_DATA_CENTERS[strippedZeroCode]) {
    return SAP_DATA_CENTERS[strippedZeroCode];
  }

  // 2. Host lookup
  const host = normalizeHost(raw);
  for (const dc of Object.values(SAP_DATA_CENTERS)) {
    if (dc.apiHost.toLowerCase() === host) {
      return dc;
    }
  }

  // 3. Alternate host match (e.g. if apiHost is in raw URL)
  for (const dc of Object.values(SAP_DATA_CENTERS)) {
    if (raw.toLowerCase().includes(dc.apiHost.toLowerCase())) {
      return dc;
    }
  }

  return undefined;
}

/** Regex patterns typical of SuccessFactors web portal access URLs. */
const WEB_PORTAL_PATTERNS = [
  /^performancemanager\d*\.successfactors\.(eu|com)$/i,
  /^performancemanager\d*\.sapsf\.(eu|com|cn)$/i,
  /^pmsalesdemo\d*\.successfactors\.com$/i,
  /^salesdemo\d*\.successfactors\.com$/i,
];

/**
 * Checks whether an input URL or hostname matches known SuccessFactors web portal patterns.
 */
export function isWebPortalUrl(urlOrHost: string): boolean {
  const host = normalizeHost(urlOrHost);
  if (!host) return false;

  // If host is an exact API host, it's not a web portal
  for (const dc of Object.values(SAP_DATA_CENTERS)) {
    if (dc.apiHost.toLowerCase() === host) {
      return false;
    }
  }

  for (const pattern of WEB_PORTAL_PATTERNS) {
    if (pattern.test(host)) return true;
  }

  for (const dc of Object.values(SAP_DATA_CENTERS)) {
    if (dc.webPortalDomains.some((d) => d.toLowerCase() === host)) {
      return true;
    }
  }

  return false;
}

/**
 * Attempts to map a web portal URL/host to its corresponding DataCenterDefinition.
 */
export function findDataCenterByWebUrl(urlOrHost: string): DataCenterDefinition | undefined {
  const host = normalizeHost(urlOrHost);
  if (!host) return undefined;

  // 1. Direct match in configured webPortalDomains
  for (const dc of Object.values(SAP_DATA_CENTERS)) {
    for (const domain of dc.webPortalDomains) {
      if (domain.toLowerCase() === host) {
        return dc;
      }
    }
  }

  // 2. Heuristic parsing for performancemanager[X]
  // e.g. performancemanager4.successfactors.com -> DC4
  // performancemanager.successfactors.eu -> DC2 (default EU portal)
  if (host === "performancemanager.successfactors.eu" || host === "performancemanager2.successfactors.eu") {
    return SAP_DATA_CENTERS.DC2;
  }
  if (host === "performancemanager.successfactors.com") {
    return SAP_DATA_CENTERS.DC4;
  }

  const pmMatch = host.match(/^performancemanager(\d+)\.(successfactors|sapsf)\.(com|eu|cn)$/i);
  if (pmMatch) {
    const num = pmMatch[1];
    const code = `DC${num}`;
    if (SAP_DATA_CENTERS[code]) {
      return SAP_DATA_CENTERS[code];
    }
  }

  const demoMatch = host.match(/^(?:pm)?salesdemo(\d+)\.successfactors\.com$/i);
  if (demoMatch) {
    // Standard SalesDemo in US is DC68
    return SAP_DATA_CENTERS.DC68;
  }

  return undefined;
}

/**
 * Suggests an API base URL if the input is a web portal URL.
 */
export function suggestApiBaseUrl(
  inputUrl: string
): { dataCenter: DataCenterDefinition; suggestedBaseUrl: string } | undefined {
  const dc = findDataCenterByWebUrl(inputUrl);
  if (!dc) return undefined;
  return {
    dataCenter: dc,
    suggestedBaseUrl: dc.apiBaseUrl,
  };
}
