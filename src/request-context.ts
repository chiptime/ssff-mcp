import { AsyncLocalStorage } from "node:async_hooks";
import type { HostedAuthResolution } from "./local-auth.js";

/** One validated HTTP request; never store this mutable authority on a session. */
export interface HostedRequestContext {
  readonly resolution: HostedAuthResolution;
  /** Private config snapshot used for both authentication and authorization. */
  readonly rawConfig: string;
}

export const hostedRequestContext = new AsyncLocalStorage<HostedRequestContext>();
