import { describe, expect, it } from "vitest";
import { isRoleAllowed } from "../../lib/auth/guard";
import {
  PUBLISH_SCOPES,
  PUBLISHER_ROLES,
  TITLE_MAX_LENGTH,
  isPublishScope,
  isUuid,
  isValidTargets,
  validateUpdateInput,
} from "../../lib/contents/publish-core";

// publish-core.ts の純粋ロジック (検証 / ガード)。Issue #150 M-1 / L-1 の単体テスト。
// "use server" を含まないモジュールなので node 環境で副作用なくテストできる。

describe("PUBLISH_SCOPES", () => {
  it("Drizzle publishScope enum と同一集合 (school/class/homeroom/private)", () => {
    // satisfies + exhaustive チェック (publish-core.ts の _ExhaustivePublishScopeCheck) は
    // コンパイル時に enum とのズレを検出する。ここでは値の集合をランタイムでも固定する。
    expect([...PUBLISH_SCOPES].sort()).toEqual(["class", "homeroom", "private", "school"]);
  });
});

describe("PUBLISHER_ROLES (#166: /admin/contents を publisher 専用にする認可集合)", () => {
  // /admin/contents[/[id]] は `requireRole(PUBLISHER_ROLES)` で gate する。requireRole は
  // 内部で isRoleAllowed を使うため、ここでガード集合の振る舞いを直接固定する。
  it("school_admin / teacher のみ許可する", () => {
    expect(isRoleAllowed("school_admin", PUBLISHER_ROLES)).toBe(true);
    expect(isRoleAllowed("teacher", PUBLISHER_ROLES)).toBe(true);
  });

  it("system_admin を除外する (cross-tenant 全件可視を自校用画面に晒さない)", () => {
    // F04 の自校公開フロー画面に system_admin の横断データを混ぜない (方針 A)。403 に倒れる。
    expect(isRoleAllowed("system_admin", PUBLISHER_ROLES)).toBe(false);
  });

  it("student / guardian も除外する (管理エリア対象外)", () => {
    expect(isRoleAllowed("student", PUBLISHER_ROLES)).toBe(false);
    expect(isRoleAllowed("guardian", PUBLISHER_ROLES)).toBe(false);
  });
});

describe("isUuid", () => {
  it("UUID 形式を受理", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
  });
  it("非 UUID / 非文字列は拒否", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe("isPublishScope", () => {
  it("許可スコープを受理", () => {
    for (const s of PUBLISH_SCOPES) {
      expect(isPublishScope(s)).toBe(true);
    }
  });
  it("未知スコープ / 非文字列は拒否", () => {
    expect(isPublishScope("everyone")).toBe(false);
    expect(isPublishScope(undefined)).toBe(false);
  });
});

describe("isValidTargets", () => {
  it("配列 (空含む) を受理", () => {
    expect(isValidTargets([])).toBe(true);
    expect(isValidTargets(["class-1", "class-2"])).toBe(true);
    expect(isValidTargets([{ classId: "x" }])).toBe(true);
  });
  it("配列でない値は拒否", () => {
    expect(isValidTargets("class-1")).toBe(false);
    expect(isValidTargets({ classId: "x" })).toBe(false);
    expect(isValidTargets(null)).toBe(false);
    expect(isValidTargets(undefined)).toBe(false);
  });
  it("JSON シリアライズ不能 (循環参照) は拒否", () => {
    const circular: unknown[] = [];
    circular.push(circular);
    expect(isValidTargets(circular)).toBe(false);
  });
});

describe("validateUpdateInput", () => {
  it("全フィールド未指定 (空 patch) は null = 検証通過", () => {
    expect(validateUpdateInput({})).toBeNull();
  });

  it("妥当な全フィールドは null", () => {
    expect(
      validateUpdateInput({
        title: "お知らせ",
        body: "本文",
        publishScope: "class",
        targets: ["class-1"],
      }),
    ).toBeNull();
  });

  it("空文字 title は invalid_input", () => {
    expect(validateUpdateInput({ title: "" })).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("title が長すぎる (300 字超) は invalid_input", () => {
    const tooLong = "あ".repeat(TITLE_MAX_LENGTH + 1);
    expect(validateUpdateInput({ title: tooLong })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("title 300 字ちょうどは通過", () => {
    expect(validateUpdateInput({ title: "あ".repeat(TITLE_MAX_LENGTH) })).toBeNull();
  });

  it("非文字列 body は invalid_input (#150 L-1: 従来未検証だった)", () => {
    expect(validateUpdateInput({ body: 123 as unknown as string })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("空文字 body は許容 (DB は NOT NULL default '')", () => {
    expect(validateUpdateInput({ body: "" })).toBeNull();
  });

  it("未知 publishScope は invalid_input", () => {
    expect(validateUpdateInput({ publishScope: "everyone" })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("非配列 targets は invalid_input (#150 L-1: 従来未検証だった)", () => {
    expect(validateUpdateInput({ targets: { classId: "x" } })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });
});
