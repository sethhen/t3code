import type { MoveAccount } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { isMoveUnsupported, isWholeSignInCode, orderMoveAccounts } from "./move.logic";

function account(overrides: Partial<MoveAccount> = {}): MoveAccount {
  return {
    id: "claude:a@example.com",
    provider: "claude",
    email: "a@example.com",
    target: "instance",
    ...overrides,
  };
}

describe("orderMoveAccounts", () => {
  it("puts Claude before Codex, then sorts by email, whatever the target", () => {
    const ordered = orderMoveAccounts([
      account({ id: "x-b", provider: "codex", email: "b@example.com" }),
      account({ id: "c-b", email: "b@example.com" }),
      account({ id: "x-z", provider: "codex", email: "z@example.com", target: "default" }),
      account({ id: "c-a", email: "a@example.com" }),
      account({ id: "c-y", email: "y@example.com", target: "default" }),
      account({ id: "x-a", provider: "codex", email: "a@example.com" }),
    ]);
    assert.deepEqual(
      ordered.map((entry) => entry.id),
      ["c-a", "c-b", "c-y", "x-a", "x-b", "x-z"],
    );
  });
});

describe("isWholeSignInCode", () => {
  it("takes code#state with both parts", () => {
    assert.isTrue(isWholeSignInCode("abc#def"));
    assert.isTrue(isWholeSignInCode("  abc#def\n"));
    assert.isTrue(isWholeSignInCode("abc#def#ghi"));
  });

  it("rejects a code missing either part", () => {
    assert.isFalse(isWholeSignInCode("abc"));
    assert.isFalse(isWholeSignInCode("abc#"));
    assert.isFalse(isWholeSignInCode("#def"));
    assert.isFalse(isWholeSignInCode("#"));
  });
});

describe("isMoveUnsupported", () => {
  it("treats a missing pool extension, a missing extension RPC or an old pool as unsupported", () => {
    assert.isTrue(isMoveUnsupported("Unknown extension method pool.status"));
    assert.isTrue(isMoveUnsupported("Unknown request tag: extension.call"));
    assert.isTrue(isMoveUnsupported('Unexpected response: Missing key at ["accounts"]'));
  });

  it("keeps real failures and other extensions' errors", () => {
    assert.isFalse(isMoveUnsupported("Unknown extension method skillsMcp.context.get"));
    assert.isFalse(isMoveUnsupported("Could not read the account list"));
  });
});
