import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-049 PR-C: 年間行事予定表取込 Server Action のセキュリティ分岐検証（assistant-actions.test と同流儀。
 * DB / Vertex / auth はモック、model / rate limiter は deps 注入）。認可・ファイル検証・rate 前置・
 * OCR egress 監査・LLM 監査・保存の再検証と置き換え + 監査の原子化を固める。
 */

// vi.hoisted: vi.mock factory は巻き上げられるため、参照するフェイクは hoisted で先に生成する。
const h = vi.hoisted(() => {
  class FakeAiDisabledError extends Error {}
  class FakeUnsupportedFormatError extends Error {}
  class FakeExtractorNotConfiguredError extends Error {}
  class FakeExtractFailedError extends Error {}
  return {
    AiDisabledError: FakeAiDisabledError,
    UnsupportedFormatError: FakeUnsupportedFormatError,
    ExtractorNotConfiguredError: FakeExtractorNotConfiguredError,
    ExtractFailedError: FakeExtractFailedError,
    assertAiEnabled: vi.fn(),
    extractText: vi.fn(),
    findSuspectedPersonalNames: vi.fn(),
    findUnmaskedPii: vi.fn(),
    maskPII: vi.fn(),
    unmaskPII: vi.fn(),
    requireRole: vi.fn(),
    insertValues: vi.fn(),
    replaceFileImportedEvents: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("@kimiterrace/ai", () => ({
  AiDisabledError: h.AiDisabledError,
  UnsupportedFormatError: h.UnsupportedFormatError,
  ExtractorNotConfiguredError: h.ExtractorNotConfiguredError,
  ExtractFailedError: h.ExtractFailedError,
  assertAiEnabled: h.assertAiEnabled,
  extractText: h.extractText,
  findSuspectedPersonalNames: h.findSuspectedPersonalNames,
  findUnmaskedPii: h.findUnmaskedPii,
  maskPII: h.maskPII,
  unmaskPII: h.unmaskPII,
  createPerSchoolRateLimiter: () => ({ tryAcquire: () => true }),
  createVertexModelClient: () => ({ generate: vi.fn() }),
  createGeminiOcrClient: () => ({ recognize: vi.fn() }),
}));
vi.mock("@/lib/auth/guard", () => ({ requireRole: h.requireRole }));
vi.mock("@/lib/db", () => ({
  withSession: (cb: (tx: unknown) => unknown) => cb({ insert: () => ({ values: h.insertValues }) }),
}));
vi.mock("@kimiterrace/db", () => ({
  auditLog: {},
  replaceFileImportedEvents: h.replaceFileImportedEvents,
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));

import {
  draftCalendarImportAction,
  saveCalendarImportAction,
} from "../../lib/editor/calendar-import-actions";

// 2026-05-01 JST → 年度 2026（2026-04-01〜2027-03-31）。
const NOW_MS = Date.UTC(2026, 4, 1);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function deps(overrides: Partial<{ generate: ReturnType<typeof vi.fn>; acquire: boolean }> = {}) {
  const generate =
    overrides.generate ??
    vi.fn().mockResolvedValue({
      text: '{"events":[{"summary":"体育祭","startDate":"2026-05-20","allDay":true}]}',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelVersion: "fake",
    });
  return {
    model: { generate },
    rateLimiter: { tryAcquire: vi.fn().mockReturnValue(overrides.acquire ?? true) },
    ocr: { recognize: vi.fn() },
    nowMs: NOW_MS,
  };
}

function fileForm(
  name = "annual.xlsx",
  type = XLSX_MIME,
  bytes: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3]),
): FormData {
  const fd = new FormData();
  fd.set("file", new File([bytes], name, { type }));
  return fd;
}

beforeEach(() => {
  h.requireRole.mockResolvedValue({ uid: "u1", schoolId: "s1", role: "teacher" });
  h.assertAiEnabled.mockReset().mockImplementation(() => undefined);
  h.findSuspectedPersonalNames.mockReset().mockReturnValue([]);
  h.findUnmaskedPii.mockReset().mockReturnValue([]);
  h.maskPII.mockReset().mockImplementation((t: string) => ({ masked: t, dictionary: {} }));
  h.unmaskPII.mockReset().mockImplementation((t: string) => t);
  h.extractText.mockReset().mockResolvedValue({ text: "4/20 体育祭", format: "xlsx" });
  h.insertValues.mockReset().mockResolvedValue(undefined);
  h.replaceFileImportedEvents.mockReset().mockResolvedValue({ deleted: 0, inserted: 1 });
  h.revalidatePath.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("draftCalendarImportAction", () => {
  it("ファイル無しは empty（認証前に弾く）", async () => {
    const r = await draftCalendarImportAction(new FormData(), {}, deps());
    expect(r).toEqual({ ok: false, reason: "empty" });
  });

  it("10MB 超は too_large", async () => {
    const fd = fileForm("big.xlsx", XLSX_MIME, new Uint8Array(10 * 1024 * 1024 + 1));
    const r = await draftCalendarImportAction(fd, {}, deps());
    expect(r).toEqual({ ok: false, reason: "too_large" });
  });

  it("docx（エディタ AI では可）は取込では unsupported_format", async () => {
    const fd = fileForm(
      "annual.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const r = await draftCalendarImportAction(fd, {}, deps());
    expect(r).toEqual({ ok: false, reason: "unsupported_format" });
  });

  it("学校に属さない user は forbidden", async () => {
    h.requireRole.mockResolvedValue({ uid: "u1", schoolId: null, role: "teacher" });
    const r = await draftCalendarImportAction(fileForm(), {}, deps());
    expect(r).toEqual({ ok: false, reason: "forbidden" });
  });

  it("AI_ENABLED OFF は disabled", async () => {
    h.assertAiEnabled.mockImplementation(() => {
      throw new h.AiDisabledError();
    });
    const r = await draftCalendarImportAction(fileForm(), {}, deps());
    expect(r).toEqual({ ok: false, reason: "disabled" });
  });

  it("レート制限超過は rate_limited（抽出・生成とも走らない）", async () => {
    const d = deps({ acquire: false });
    const r = await draftCalendarImportAction(fileForm(), {}, d);
    expect(r).toEqual({ ok: false, reason: "rate_limited" });
    expect(h.extractText).not.toHaveBeenCalled();
    expect(d.model.generate).not.toHaveBeenCalled();
  });

  it("PNG を名乗る非画像バイト列は egress 前に unsupported_format（抽出も呼ばない）", async () => {
    const fd = fileForm("photo.png", "image/png", new Uint8Array([1, 2, 3, 4]));
    const r = await draftCalendarImportAction(fd, {}, deps());
    expect(r).toEqual({ ok: false, reason: "unsupported_format" });
    expect(h.extractText).not.toHaveBeenCalled();
  });

  it("抽出失敗（破損等）は extract_failed", async () => {
    h.extractText.mockRejectedValue(new h.ExtractFailedError());
    const r = await draftCalendarImportAction(fileForm(), {}, deps());
    expect(r).toEqual({ ok: false, reason: "extract_failed" });
  });

  it("抽出テキストが空なら no_text", async () => {
    h.extractText.mockResolvedValue({ text: "   ", format: "xlsx" });
    const r = await draftCalendarImportAction(fileForm(), {}, deps());
    expect(r).toEqual({ ok: false, reason: "no_text" });
  });

  it("氏名らしき語があり未 override なら pii_warning（送信しない）", async () => {
    h.findSuspectedPersonalNames.mockReturnValue([{ surface: "田中さん" }]);
    const d = deps();
    const r = await draftCalendarImportAction(fileForm(), {}, d);
    expect(r).toEqual({ ok: false, reason: "pii_warning", suspectedSurfaces: ["田中さん"] });
    expect(d.model.generate).not.toHaveBeenCalled();
  });

  it("正常時はプレビュー用データ（events / 年度窓 / fileName）を返し LLM 呼び出しを監査する", async () => {
    const d = deps();
    const r = await draftCalendarImportAction(fileForm(), {}, d);
    expect(r).toEqual({
      ok: true,
      events: [{ summary: "体育祭", startDate: "2026-05-20", allDay: true, endDate: undefined }],
      dropped: {
        invalidDate: 0,
        outOfWindow: 0,
        duplicates: 0,
        overCap: 0,
        endDateStripped: 0,
        malformed: 0,
      },
      window: { fiscalYear: 2026, start: "2026-04-01", end: "2027-03-31" },
      suspectedNameCount: 0,
      fileName: "annual.xlsx",
    });
    expect(h.insertValues).toHaveBeenCalledOnce();
    const audit = h.insertValues.mock.calls[0]?.[0] as {
      tableName: string;
      diff: { aiAssist: string; eventCount: number };
    };
    expect(audit.tableName).toBe("school_calendar_events");
    expect(audit.diff.aiAssist).toBe("calendar_import_draft_file");
    expect(audit.diff.eventCount).toBe(1);
  });

  it("OCR を通した場合は後続が no_result でも egress 監査を残す（fail-safe）", async () => {
    h.extractText.mockResolvedValue({
      text: "4/20 体育祭",
      format: "png",
      meta: { ocrUsed: true },
    });
    const d = deps({
      generate: vi.fn().mockResolvedValue({ text: "not json", usage: {}, modelVersion: "f" }),
    });
    const fd = fileForm("photo.png", "image/png", new Uint8Array([...PNG_MAGIC, 9, 9]));
    const r = await draftCalendarImportAction(fd, {}, d);
    expect(r).toEqual({ ok: false, reason: "no_result" });
    expect(h.insertValues).toHaveBeenCalledOnce();
    const audit = h.insertValues.mock.calls[0]?.[0] as {
      diff: { ocrEgress: boolean; origin: string };
    };
    expect(audit.diff.ocrEgress).toBe(true);
    expect(audit.diff.origin).toBe("calendar_import");
  });
});

describe("saveCalendarImportAction", () => {
  const VALID_EVENTS = [{ summary: "体育祭", startDate: "2026-05-20", allDay: true }];

  // #1270 M1: 保存 action は時刻注入を公開シグネチャに持たない（クライアントから年度窓をずらせないため）。
  // テストの時刻固定は Date.now の spy で行う（afterEach の vi.restoreAllMocks で解除）。
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("学校に属さない user は forbidden（保存しない）", async () => {
    h.requireRole.mockResolvedValue({ uid: "u1", schoolId: null, role: "teacher" });
    const r = await saveCalendarImportAction(VALID_EVENTS, {});
    expect(r).toEqual({ ok: false, reason: "forbidden" });
    expect(h.replaceFileImportedEvents).not.toHaveBeenCalled();
  });

  it("不正な形（配列以外 / 空 / 年度外）は invalid で行番号付き issues を返し保存しない", async () => {
    const notArray = await saveCalendarImportAction({ evil: true }, {});
    expect(notArray).toMatchObject({ ok: false, reason: "invalid" });
    const empty = await saveCalendarImportAction([], {});
    expect(empty).toMatchObject({ ok: false, reason: "invalid" });
    const outOfWindow = await saveCalendarImportAction(
      [{ summary: "旧年度", startDate: "2026-03-01", allDay: true }],
      {},
    );
    expect(outOfWindow).toMatchObject({
      ok: false,
      reason: "invalid",
      issues: [{ index: 0, message: expect.stringContaining("対象年度") }],
    });
    expect(h.replaceFileImportedEvents).not.toHaveBeenCalled();
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it("正常時は置き換えヘルパ + 監査を同一 tx で呼び、件数を返す", async () => {
    h.replaceFileImportedEvents.mockResolvedValue({ deleted: 3, inserted: 1 });
    const r = await saveCalendarImportAction(
      VALID_EVENTS,
      // dropped の未知キー（bogus）は監査に載せない（allowlist）。
      { fileName: "annual.xlsx", dropped: { invalidDate: 1, bogus: 5 }, suspectedNameCount: 2 },
    );
    expect(r).toEqual({ ok: true, deleted: 3, inserted: 1 });

    expect(h.replaceFileImportedEvents).toHaveBeenCalledOnce();
    const params = h.replaceFileImportedEvents.mock.calls[0]?.[1] as {
      schoolId: string;
      batchId: string;
      fileName: string;
      actorUserId: string;
      events: unknown[];
    };
    expect(params.schoolId).toBe("s1");
    expect(params.actorUserId).toBe("u1");
    expect(params.fileName).toBe("annual.xlsx");
    expect(params.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(params.events).toEqual([
      {
        summary: "体育祭",
        startDate: "2026-05-20",
        endDate: null,
        startAt: null,
        endAt: null,
        allDay: true,
        location: null,
      },
    ]);

    expect(h.insertValues).toHaveBeenCalledOnce();
    const audit = h.insertValues.mock.calls[0]?.[0] as {
      tableName: string;
      diff: Record<string, unknown>;
    };
    expect(audit.tableName).toBe("school_calendar_events");
    expect(audit.diff).toMatchObject({
      calendarFileImport: true,
      fileName: "annual.xlsx",
      deleted: 3,
      inserted: 1,
      dropped: { invalidDate: 1 },
      suspectedNameCount: 2,
      fiscalYear: 2026,
    });
    expect(audit.diff.dropped).not.toHaveProperty("bogus");
    expect(h.revalidatePath).toHaveBeenCalledWith("/app/editor/calendar-import");
  });

  it("メタ未申告でも保存できる（fileName は既定値・監査は 0 埋め）", async () => {
    const r = await saveCalendarImportAction(VALID_EVENTS, {});
    expect(r).toEqual({ ok: true, deleted: 0, inserted: 1 });
    const params = h.replaceFileImportedEvents.mock.calls[0]?.[1] as { fileName: string };
    expect(params.fileName).toBe("(不明なファイル)");
  });

  it("DB 障害は error に畳む（throw しない）", async () => {
    h.replaceFileImportedEvents.mockRejectedValue(new Error("db down"));
    const r = await saveCalendarImportAction(VALID_EVENTS, {});
    expect(r).toEqual({ ok: false, reason: "error" });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
