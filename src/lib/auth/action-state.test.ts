import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createAuthErrorState,
  initialAuthActionState,
} from "./action-state";

describe("authentication action state", () => {
  it("creates a fresh error state for every failed submission", () => {
    const firstFailure = createAuthErrorState(
      initialAuthActionState,
      "invalid-credentials",
    );
    const repeatedFailure = createAuthErrorState(
      firstFailure,
      "invalid-credentials",
    );

    assert.deepEqual(firstFailure, {
      attempt: 1,
      error: "invalid-credentials",
    });
    assert.deepEqual(repeatedFailure, {
      attempt: 2,
      error: "invalid-credentials",
    });
  });
});
