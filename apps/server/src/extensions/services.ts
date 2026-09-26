/**
 * Fork services that live as long as the server (background processes,
 * watchers). server.ts provides this layer through one `t3-ext` line, so a new
 * long-lived fork service is one entry here and no upstream edit.
 */
import * as Layer from "effect/Layer";

import { PoolLive } from "./pool/layer.ts";

export const ForkServicesLive = Layer.mergeAll(PoolLive);
