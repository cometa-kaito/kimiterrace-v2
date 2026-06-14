import { describe, expect, it } from "vitest";
import { isRoleAllowed } from "../../lib/auth/guard";
import {
  DEFAULT_PUBLISH_SCOPE,
  PUBLISHER_ROLES,
  PUBLISH_SCOPES,
  TITLE_MAX_LENGTH,
  isPublishScope,
  isUuid,
  isValidTargets,
  resolveEditorDefaults,
  validateCreateInput,
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

describe("PUBLISHER_ROLES (#166: /app/contents を publisher 専用にする認可集合)", () => {
  // /app/contents[/[id]] は `requireRole(PUBLISHER_ROLES)` で gate する。requireRole は
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

describe("validateCreateInput (#509 S3a)", () => {
  const ok = { title: "進路だより", body: "本文", publishScope: "class" as const };

  it("正常な入力は null (検証通過)", () => {
    expect(validateCreateInput(ok)).toBeNull();
  });

  it("body 省略は許容 (既定空文字)", () => {
    expect(validateCreateInput({ title: "t", publishScope: "private" })).toBeNull();
  });

  it("title 空 / 非文字列は invalid_input", () => {
    expect(validateCreateInput({ ...ok, title: "" })).toMatchObject({ code: "invalid_input" });
    expect(validateCreateInput({ ...ok, title: undefined as unknown as string })).toMatchObject({
      code: "invalid_input",
    });
  });

  it("title 上限超過は invalid_input", () => {
    expect(validateCreateInput({ ...ok, title: "あ".repeat(TITLE_MAX_LENGTH + 1) })).toMatchObject({
      code: "invalid_input",
    });
  });

  it("publishScope は必須 (未知値は invalid_input)", () => {
    expect(validateCreateInput({ ...ok, publishScope: "everyone" })).toMatchObject({
      code: "invalid_input",
    });
  });

  it("非配列 targets は invalid_input", () => {
    expect(validateCreateInput({ ...ok, targets: { classId: "x" } })).toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("resolveEditorDefaults (F01: AI 提案 → 編集 UI 既定値の pre-fill)", () => {
  it("提案なし (undefined) は private + 期間未設定にフォールバック", () => {
    expect(resolveEditorDefaults()).toEqual({
      publishScope: DEFAULT_PUBLISH_SCOPE,
      period: {},
    });
    expect(DEFAULT_PUBLISH_SCOPE).toBe("private");
  });

  it("空の提案も private + 期間未設定にフォールバック", () => {
    expect(resolveEditorDefaults({})).toEqual({ publishScope: "private", period: {} });
  });

  it("公開先の提案 (許可値) を既定に採用する", () => {
    expect(resolveEditorDefaults({ publishScope: "school" }).publishScope).toBe("school");
    expect(resolveEditorDefaults({ publishScope: "class" }).publishScope).toBe("class");
  });

  it("掲示期間の提案 (両端) を pre-fill する", () => {
    expect(
      resolveEditorDefaults({ period: { start: "2026-06-10", end: "2026-06-20" } }).period,
    ).toEqual({ start: "2026-06-10", end: "2026-06-20" });
  });

  it("掲示期間は片端だけの提案も保持する (end のみ)", () => {
    expect(resolveEditorDefaults({ period: { end: "2026-06-20" } }).period).toEqual({
      end: "2026-06-20",
    });
  });

  it("空文字・非文字列の期間端は落とす (防御的)", () => {
    expect(
      resolveEditorDefaults({
        period: { start: "", end: undefined as unknown as string },
      }).period,
    ).toEqual({});
  });

  it("無効な公開先提案は private にフォールバック (越境入力を信用しない)", () => {
    expect(resolveEditorDefaults({ publishScope: "everyone" as never }).publishScope).toBe(
      "private",
    );
  });
});
