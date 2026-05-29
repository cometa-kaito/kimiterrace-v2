import { describe, expect, it } from "vitest";
import { buildHealthPayload } from "../app/api/health/payload";

describe("buildHealthPayload", () => {
  it("returns ok status with provided commit", () => {
    expect(buildHealthPayload("abc1234")).toEqual({
      status: "ok",
      commit: "abc1234",
    });
  });

  it('falls back to "dev" when commit is undefined', () => {
    expect(buildHealthPayload(undefined)).toEqual({
      status: "ok",
      commit: "dev",
    });
  });
});
