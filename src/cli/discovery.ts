/**
 * Live entity discovery for the `ssff-mcp init` wizard (FR-52 / FR-53 / FR-54):
 * validates credentials against `$metadata`, returns the EntitySets, and
 * prewarms the disk metadata cache under the wizard's alias.
 */

import type { EnvironmentConfig } from "../config.js";
import { envTargetFor, type FetchImpl } from "../http.js";
import { MetadataService } from "../metadata.js";

export interface DiscoverOptions {
  environment: EnvironmentConfig;
  alias: string;
  fetchImpl?: FetchImpl;
  cacheDir?: string;
  disableDiskCache?: boolean;
}

export async function discoverEntities(options: DiscoverOptions): Promise<string[]> {
  const service = new MetadataService({
    fetchImpl: options.fetchImpl,
    cacheDir: options.cacheDir,
    disableDiskCache: options.disableDiskCache,
  });
  const parsed = await service.getParsedMetadata(envTargetFor(options.environment, options.alias), options.alias);
  return [...parsed.entitySets].sort((a, b) => a.localeCompare(b));
}
