/**
 * The server's one `MoveController`. The extension registry is built per ws
 * connection, so handlers reach the long-lived controller through here.
 */
import type { MoveController } from "./move.ts";

let current: MoveController | undefined;

export const setMoveController = (controller: MoveController | undefined) => {
  current = controller;
};

export const getMoveController = () => current;
