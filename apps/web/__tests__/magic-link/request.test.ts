import { describe, expect, it } from "vitest";
import {
  EXPIRES_MAX_DAYS,
  computeExpiresAt,
  isIssuerRole,
  isUuid,
  parseExtendBody,
  parseIssueBody,
} from "../../lib/magic-link/request";

const CLASS_ID = "33333333-3333-4333-8333-333333333333";

describe("magic-link request validation", () => {
  it("isIssuerRole: teacher/school_admin のみ true", () => {
    expect(isIssuerRole("teacher")).toBe(true);
    expect(isIssuerRole("school_admin")).toBe(true);
    expect(isIssuerRole("student")).toBe(false);
    expect(isIssuerRole("guardian")).toBe(false);
    expect(isIssuerRole("system_admin")).toBe(false);
  });

  it("isUuid: 形式判定", () => {
    expect(isUuid(CLASS_ID)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });

  it("parseIssueBody: classId のみ (expiresInDays 省略) は OK", () => {
    const r = parseIssueBody({ classId: CLASS_ID });
    expect(r).toEqual({ ok: true, value: { classId: CLASS_ID } });
  });

  it("parseIssueBody: 有効な expiresInDays を受理", () => {
    const r = parseIssueBody({ classId: CLASS_ID, expiresInDays: 30 });
    expect(r).toEqual({ ok: true, value: { classId: CLASS_ID, expiresInDays: 30 } });
  });

  it.each([
    ["non-object", "string"],
    ["null", null],
  ])("parseIssueBody: 不正な body (%s) は invalid_body", (_label, body) => {
    expect(parseIssueBody(body)).toEqual({ ok: false, error: "invalid_body" });
  });

  it("parseIssueBody: classId 欠落/非UUID は invalid_class_id", () => {
    expect(parseIssueBody({})).toEqual({ ok: false, error: "invalid_class_id" });
    expect(parseIssueBody({ classId: "x" })).toEqual({ ok: false, error: "invalid_class_id" });
  });

  it.each([
    0,
    -5,
    1.5,
    EXPIRES_MAX_DAYS + 1,
    "30",
  ])("parseIssueBody: 範囲外/非整数の expiresInDays (%s) は invalid_expires_in_days", (bad) => {
    expect(parseIssueBody({ classId: CLASS_ID, expiresInDays: bad })).toEqual({
      ok: false,
      error: "invalid_expires_in_days",
    });
  });

  it("computeExpiresAt: now からの日数を加算", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(computeExpiresAt(10, now).toISOString()).toBe("2026-01-11T00:00:00.000Z");
  });

  it("parseExtendBody: 有効な expiresInDays を受理", () => {
    expect(parseExtendBody({ expiresInDays: 30 })).toEqual({
      ok: true,
      value: { expiresInDays: 30 },
    });
  });

  it.each([
    ["non-object", "string"],
    ["null", null],
  ])("parseExtendBody: 不正な body (%s) は invalid_body", (_label, body) => {
    expect(parseExtendBody(body)).toEqual({ ok: false, error: "invalid_body" });
  });

  it.each([
    ["欠落", undefined],
    ["null", null],
    ["0", 0],
    ["負", -5],
    ["小数", 1.5],
    ["上限超過", EXPIRES_MAX_DAYS + 1],
    ["文字列", "30"],
  ])("parseExtendBody: 必須かつ範囲内整数のみ — %s は invalid_expires_in_days", (_label, bad) => {
    expect(parseExtendBody({ expiresInDays: bad })).toEqual({
      ok: false,
      error: "invalid_expires_in_days",
    });
  });
});
