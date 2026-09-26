/**
 * The server's one `PoolController`. The extension registry is built per ws
 * connection, so handlers reach the long-lived controller through here.
 */
import type { PoolController } from "./controller.ts";

let current: PoolController | undefined;

export const setPoolController = (controller: PoolController | undefined) => {
  current = controller;
};

export const getPoolController = () => current;
