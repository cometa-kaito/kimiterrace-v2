import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 段C: assistDraftNoticesAction のセキュリティ分岐検証（DB/Vertex/auth はモック、model は deps 注入）。
 * PII soft-gate・AI_ENABLED kill-switch・レート制限・正常ドラフト・監査書込を固める。
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
vi.mock("@kimiterrace/db", () => ({ auditLog: {} }));

import {
  assistDraftAllAction,
  assistDraftAssignmentAction,
  assistDraftNoticesAction,
  assistDraftNoticesFromFileAction,
  assistDraftScheduleAction,
  assistDraftScheduleFromFileAction,
} from "../../lib/editor/assistant-actions";

const CLASS_ID = "11111111-1111-4111-8111-111111111111";

function deps(overrides: Partial<{ generate: ReturnType<typeof vi.fn>; acquire: boolean }> = {}) {
  const generate =
    overrides.generate ??
    vi.fn().mockResolvedValue({
      text: '{"notices":[{"text":"連絡A","isHighlight":true}]}',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelVersion: "fake",
    });
  return {
    model: { generate },
    rateLimiter: { tryAcquire: vi.fn().mockReturnValue(overrides.acquire ?? true) },
    nowMs: 1000,
  };
}

beforeEach(() => {
  h.requireRole.mockResolvedValue({ uid: "u1", schoolId: "s1", role: "teacher" });
  h.assertAiEnabled.mockReset().mockImplementation(() => undefined);
  h.findSuspectedPersonalNames.mockReset().mockReturnValue([]);
  h.findUnmaskedPii.mockReset().mockReturnValue([]);
  h.maskPII.mockReset().mockImplementation((t: string) => ({ masked: t, dictionary: {} }));
  h.unmaskPII.mockReset().mockImplementation((t: string) => t);
  h.extractText.mockReset().mockResolvedValue({ text: "明日は短縮授業", format: "pdf" });
  h.insertValues.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("assistDraftNoticesAction", () => {
  it("空入力は empty（認証前に弾く）", async () => {
    const r = await assistDraftNoticesAction("class", CLASS_ID, "   ", {}, deps());
    expect(r).toEqual({ ok: false, reason: "empty" });
  });

  it("氏名らしき語があり未 override なら pii_warning（送信しない）", async () => {
    h.findSuspectedPersonalNames.mockReturnValue([
      { surface: "田中さん" },
      { surface: "田中さん" },
    ]);
    const d = deps();
    const r = await assistDraftNoticesAction("class", CLASS_ID, "田中さんが欠席", {}, d);
    expect(r).toEqual({ ok: false, reason: "pii_warning", suspectedSurfaces: ["田中さん"] });
    expect(d.model.generate).not.toHaveBeenCalled();
  });

  it("acknowledgePii で soft-gate を越えて生成する", async () => {
    h.findSuspectedPersonalNames.mockReturnValue([{ surface: "田中さん" }]);
    const d = deps();
    const r = await assistDraftNoticesAction(
      "class",
      CLASS_ID,
      "連絡を作って",
      { acknowledgePii: true },
      d,
    );
    expect(r.ok).toBe(true);
    expect(d.model.generate).toHaveBeenCalledOnce();
  });

  it("AI_ENABLED OFF は disabled", async () => {
    h.assertAiEnabled.mockImplementation(() => {
      throw new h.AiDisabledError();
    });
    const r = await assistDraftNoticesAction("class", CLASS_ID, "連絡", {}, deps());
    expect(r).toEqual({ ok: false, reason: "disabled" });
  });

  it("レート制限超過は rate_limited（生成しない）", async () => {
    const d = deps({ acquire: false });
    const r = await assistDraftNoticesAction("class", CLASS_ID, "連絡", {}, d);
    expect(r).toEqual({ ok: false, reason: "rate_limited" });
    expect(d.model.generate).not.toHaveBeenCalled();
  });

  it("正常時は notices を返し audit_log に書き込む", async () => {
    const d = deps();
    const r = await assistDraftNoticesAction("class", CLASS_ID, "明日は短縮授業", {}, d);
    expect(r).toEqual({ ok: true, notices: [{ text: "連絡A", isHighlight: true }] });
    expect(h.insertValues).toHaveBeenCalledOnce();
  });

  it("逆マスク後に PII 形になる辞書由来の復元値は pii_leak にしない（マスク空間検査・誤検知解消）", async () => {
    // 教員が連絡に書いた電話をマスク → モデルが token を返す → 逆マスクで復元。復元値は PII 形だが正規（辞書由来）。
    h.maskPII.mockReturnValue({ masked: "メモ", dictionary: { "{{PHONE_1}}": "09012345678" } });
    h.findUnmaskedPii.mockImplementation((s: string) =>
      s.includes("09012345678") ? ["09012345678"] : [],
    );
    h.unmaskPII.mockImplementation((s: string) => s.replace("{{PHONE_1}}", "09012345678"));
    const d = deps({
      generate: vi.fn().mockResolvedValue({
        text: '{"notices":[{"text":"連絡先 {{PHONE_1}}","isHighlight":true}]}',
        usage: {},
        modelVersion: "f",
      }),
    });
    const r = await assistDraftNoticesAction("class", CLASS_ID, "メモ", {}, d);
    expect(r).toEqual({ ok: true, notices: [{ text: "連絡先 09012345678", isHighlight: true }] });
    expect(h.insertValues).toHaveBeenCalledOnce();
  });

  it("モデルが生成した辞書に無い生 PII を下書きに含めば pii_leak（検出力維持）", async () => {
    h.maskPII.mockReturnValue({ masked: "メモ", dictionary: {} });
    h.findUnmaskedPii.mockImplementation((s: string) =>
      s.includes("08099998888") ? ["08099998888"] : [],
    );
    const d = deps({
      generate: vi.fn().mockResolvedValue({
        text: '{"notices":[{"text":"電話 08099998888 へ","isHighlight":false}]}',
        usage: {},
        modelVersion: "f",
      }),
    });
    const r = await assistDraftNoticesAction("class", CLASS_ID, "メモ", {}, d);
    expect(r).toEqual({ ok: false, reason: "pii_leak" });
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it("基準日を user プロンプトに含めて生成する（相対日付の解決）", async () => {
    const d = deps();
    await assistDraftNoticesAction("class", CLASS_ID, "明日は短縮授業", {}, d);
    const arg = d.model.generate.mock.calls[0]?.[0] as { user?: string } | undefined;
    expect(arg?.user).toContain("基準日（今日）:");
    expect(arg?.user).toContain("明日は短縮授業");
  });

  it("モデル応答が壊れていれば no_result", async () => {
    const d = deps({
      generate: vi.fn().mockResolvedValue({ text: "not json", usage: {}, modelVersion: "f" }),
    });
    const r = await assistDraftNoticesAction("class", CLASS_ID, "連絡", {}, d);
    expect(r).toEqual({ ok: false, reason: "no_result" });
  });

  it("学校に属さない user は forbidden", async () => {
    h.requireRole.mockResolvedValue({ uid: "u1", schoolId: null, role: "teacher" });
    const r = await assistDraftNoticesAction("class", CLASS_ID, "連絡", {}, deps());
    expect(r).toEqual({ ok: false, reason: "forbidden" });
  });
});

function pdfFile(name = "notice.pdf", type = "application/pdf"): File {
  return new File(["dummy-content"], name, { type });
}
// 先頭 8 バイトは実 PNG 署名（draftSectionFromFile の egress 前マジックバイト検査 `hasValidImageMagicBytes` を
// 通すため）。残りはダミー（extractText はモックなので画素内容は不問）。
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function imageFile(name = "board.png", type = "image/png"): File {
  return new File([PNG_MAGIC, "dummy-image-bytes"], name, { type });
}
/** image/png を名乗るが先頭バイトが PNG 署名でない偽装画像（マジックバイト検査の拒否経路用）。 */
function fakeImageFile(name = "fake.png", type = "image/png"): File {
  return new File(["this-is-not-a-real-png"], name, { type });
}
function csvFile(name = "table.csv", type = "text/csv"): File {
  return new File(["科目,内容\n数学,ワーク"], name, { type });
}
function fileForm(file: File): FormData {
  const fd = new FormData();
  fd.append("file", file);
  return fd;
}

describe("assistDraftNoticesFromFileAction", () => {
  it("file 無しは empty", async () => {
    const r = await assistDraftNoticesFromFileAction("class", CLASS_ID, new FormData(), {}, deps());
    expect(r).toEqual({ ok: false, reason: "empty" });
  });

  it("画像(PNG) は OCR で抽出 → notices を返し、OCR egress 監査 + draft 監査の 2 行を書く（ADR-038）", async () => {
    h.extractText.mockResolvedValue({ text: "1限 数学", format: "image", meta: { ocrUsed: true } });
    const d = deps();
    const r = await assistDraftNoticesFromFileAction(
      "class",
      CLASS_ID,
      fileForm(imageFile()),
      {},
      d,
    );
    expect(r).toEqual({ ok: true, notices: [{ text: "連絡A", isHighlight: true }] });
    // 画像のみ OCR クライアントを注入して extractText を呼ぶ。
    expect(h.extractText).toHaveBeenCalledOnce();
    expect(h.extractText.mock.calls[0]?.[1]).toMatchObject({ ocr: expect.anything() });
    // OCR egress 監査 + draft 監査 = 2 行。
    expect(h.insertValues).toHaveBeenCalledTimes(2);
  });

  it("画像は OCR egress の前に rate を取り、超過時は OCR を呼ばない（NFR06）", async () => {
    const d = deps({ acquire: false });
    const r = await assistDraftNoticesFromFileAction(
      "class",
      CLASS_ID,
      fileForm(imageFile()),
      {},
      d,
    );
    expect(r).toEqual({ ok: false, reason: "rate_limited" });
    expect(h.extractText).not.toHaveBeenCalled();
  });

  it("image/png を名乗る偽装画像（先頭バイトが PNG 署名でない）は egress 前に unsupported_format で弾く（Vertex 直送しない・監査なし）", async () => {
    const d = deps();
    const r = await assistDraftNoticesFromFileAction(
      "class",
      CLASS_ID,
      fileForm(fakeImageFile()),
      {},
      d,
    );
    expect(r).toEqual({ ok: false, reason: "unsupported_format" });
    // egress（extractText の OCR 呼び出し）に到達しない＝Vertex に直送しない。監査も書かない。
    expect(h.extractText).not.toHaveBeenCalled();
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it("CSV は表として受理し、egress なしのローカル抽出（OCR 注入なし）で notices を返す", async () => {
    h.extractText.mockResolvedValue({ text: "科目 数学 ワーク", format: "text" });
    const d = deps();
    const r = await assistDraftNoticesFromFileAction("class", CLASS_ID, fileForm(csvFile()), {}, d);
    expect(r).toEqual({ ok: true, notices: [{ text: "連絡A", isHighlight: true }] });
    expect(h.extractText).toHaveBeenCalledOnce();
    // 文書/表は OCR を注入しない（2 引数目は ocr 無し）。
    expect(h.extractText.mock.calls[0]?.[1] ?? {}).not.toHaveProperty("ocr");
    // OCR egress なし → draft 監査の 1 行のみ。
    expect(h.insertValues).toHaveBeenCalledOnce();
  });

  it("PDF 正常（テキストレイヤあり）→ notices を返し、OCR egress なし（draft 監査の 1 行のみ）", async () => {
    // 既定 extractText は { text, format:"pdf" }（meta.ocrUsed なし）= テキストレイヤ抽出（egress なし）。
    const d = deps();
    const r = await assistDraftNoticesFromFileAction("class", CLASS_ID, fileForm(pdfFile()), {}, d);
    expect(r).toEqual({ ok: true, notices: [{ text: "連絡A", isHighlight: true }] });
    expect(h.extractText).toHaveBeenCalledOnce();
    // テキスト PDF は ocrUsed=false → egress 監査なし → draft 監査の 1 行のみ。
    expect(h.insertValues).toHaveBeenCalledOnce();
  });

  it("スキャン PDF は OCR にフォールバック（PDF にも OCR 注入）し、egress 監査 + draft 監査の 2 行を書く（ADR-038）", async () => {
    // PdfExtractor が希薄テキストレイヤを検知して OCR フォールバック → meta.ocrUsed=true で返す状況を模す。
    h.extractText.mockResolvedValue({ text: "1限 国語", format: "pdf", meta: { ocrUsed: true } });
    const d = deps();
    const r = await assistDraftNoticesFromFileAction("class", CLASS_ID, fileForm(pdfFile()), {}, d);
    expect(r).toEqual({ ok: true, notices: [{ text: "連絡A", isHighlight: true }] });
    // スキャン PDF フォールバックのため PDF にも OCR クライアントを注入する。
    expect(h.extractText.mock.calls[0]?.[1]).toMatchObject({ ocr: expect.anything() });
    // OCR egress 監査 + draft 監査 = 2 行。
    expect(h.insertValues).toHaveBeenCalledTimes(2);
  });

  it("PDF も OCR egress が発生しうるため egress の前に rate を取り、超過時は extract しない（NFR06）", async () => {
    const d = deps({ acquire: false });
    const r = await assistDraftNoticesFromFileAction("class", CLASS_ID, fileForm(pdfFile()), {}, d);
    expect(r).toEqual({ ok: false, reason: "rate_limited" });
    expect(h.extractText).not.toHaveBeenCalled();
  });

  it("OCR 未配線（ExtractorNotConfigured）は unsupported_format", async () => {
    h.extractText.mockRejectedValue(new h.ExtractorNotConfiguredError());
    const r = await assistDraftNoticesFromFileAction(
      "class",
      CLASS_ID,
      fileForm(pdfFile()),
      {},
      deps(),
    );
    expect(r).toEqual({ ok: false, reason: "unsupported_format" });
  });

  it("解析失敗（ExtractFailed）は extract_failed", async () => {
    h.extractText.mockRejectedValue(new h.ExtractFailedError());
    const r = await assistDraftNoticesFromFileAction(
      "class",
      CLASS_ID,
      fileForm(pdfFile()),
      {},
      deps(),
    );
    expect(r).toEqual({ ok: false, reason: "extract_failed" });
  });

  it("抽出テキストが空なら no_text", async () => {
    h.extractText.mockResolvedValue({ text: "   ", format: "pdf" });
    const r = await assistDraftNoticesFromFileAction(
      "class",
      CLASS_ID,
      fileForm(pdfFile()),
      {},
      deps(),
    );
    expect(r).toEqual({ ok: false, reason: "no_text" });
  });

  it("ファイル経路でも氏名は pii_warning（共有パイプライン・送信しない）", async () => {
    h.extractText.mockResolvedValue({ text: "田中さんが欠席", format: "pdf" });
    h.findSuspectedPersonalNames.mockReturnValue([{ surface: "田中さん" }]);
    const d = deps();
    const r = await assistDraftNoticesFromFileAction("class", CLASS_ID, fileForm(pdfFile()), {}, d);
    expect(r).toEqual({ ok: false, reason: "pii_warning", suspectedSurfaces: ["田中さん"] });
    expect(d.model.generate).not.toHaveBeenCalled();
  });
});

/** 予定/提出物用の generate スタブ（deps() の既定は notices JSON のため section ごとに差し替える）。 */
function depsReturning(text: string) {
  return deps({ generate: vi.fn().mockResolvedValue({ text, usage: {}, modelVersion: "f" }) });
}

describe("assistDraftScheduleAction", () => {
  it("正常時は schedules を返し、section 別 system プロンプトで生成し、audit に書く", async () => {
    const d = depsReturning('{"schedules":[{"period":1,"subject":"数学","location":"体育館"}]}');
    const r = await assistDraftScheduleAction("class", CLASS_ID, "1限は体育館で数学", {}, d);
    expect(r).toEqual({
      ok: true,
      schedules: [{ period: 1, subject: "数学", location: "体育館" }],
    });
    expect(h.insertValues).toHaveBeenCalledOnce();
    const arg = d.model.generate.mock.calls[0]?.[0] as { system?: string; user?: string };
    expect(arg?.system).toContain('"schedules"');
    expect(arg?.user).toContain("予定を作成してください");
  });

  it("壊れた応答は no_result", async () => {
    const d = depsReturning("not json");
    expect(await assistDraftScheduleAction("class", CLASS_ID, "x", {}, d)).toEqual({
      ok: false,
      reason: "no_result",
    });
  });

  it("氏名らしき語は pii_warning（共有 soft-gate・送信しない）", async () => {
    h.findSuspectedPersonalNames.mockReturnValue([{ surface: "田中先生" }]);
    const d = depsReturning('{"schedules":[{"period":1,"subject":"数学"}]}');
    const r = await assistDraftScheduleAction("class", CLASS_ID, "田中先生の数学", {}, d);
    expect(r).toEqual({ ok: false, reason: "pii_warning", suspectedSurfaces: ["田中先生"] });
    expect(d.model.generate).not.toHaveBeenCalled();
  });

  it("レート制限超過は rate_limited（生成しない）", async () => {
    const d = deps({ acquire: false });
    expect(await assistDraftScheduleAction("class", CLASS_ID, "1限数学", {}, d)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(d.model.generate).not.toHaveBeenCalled();
  });
});

describe("assistDraftAssignmentAction", () => {
  it("正常時は assignments を返し audit に書く", async () => {
    const d = depsReturning(
      '{"assignments":[{"deadline":"2026-06-20","subject":"数学","task":"ワークP30"}]}',
    );
    const r = await assistDraftAssignmentAction("class", CLASS_ID, "数学のワーク 金曜まで", {}, d);
    expect(r).toEqual({
      ok: true,
      assignments: [{ deadline: "2026-06-20", subject: "数学", task: "ワークP30" }],
    });
    expect(h.insertValues).toHaveBeenCalledOnce();
    const arg = d.model.generate.mock.calls[0]?.[0] as { user?: string };
    expect(arg?.user).toContain("提出物を作成してください");
  });

  it("実在しない締切は検証で落ちて no_result", async () => {
    const d = depsReturning(
      '{"assignments":[{"deadline":"2026-02-30","subject":"数学","task":"x"}]}',
    );
    expect(await assistDraftAssignmentAction("class", CLASS_ID, "x", {}, d)).toEqual({
      ok: false,
      reason: "no_result",
    });
  });
});

describe("assistDraftAllAction（おまかせ分類）", () => {
  it("1入力を予定/連絡/提出物に分類して 3 セクション返し、おまかせ監査で書き込む", async () => {
    const d = depsReturning(
      '{"schedules":[{"period":1,"subject":"数学"}],"notices":[{"text":"明日は短縮授業"}],"assignments":[{"deadline":"2026-06-20","subject":"英語","task":"音読"}]}',
    );
    const r = await assistDraftAllAction(
      "class",
      CLASS_ID,
      "1限数学 明日短縮 英語音読20日まで",
      {},
      d,
    );
    expect(r).toEqual({
      ok: true,
      schedules: [{ period: 1, subject: "数学" }],
      notices: [{ text: "明日は短縮授業" }],
      assignments: [{ deadline: "2026-06-20", subject: "英語", task: "音読" }],
    });
    expect(h.insertValues).toHaveBeenCalledOnce();
    const arg = d.model.generate.mock.calls[0]?.[0] as { system?: string; user?: string };
    expect(arg?.system).toContain('"schedules"');
    expect(arg?.user).toContain("振り分けて作成してください");
  });

  it("一部セクションだけでも返す（連絡のみ）", async () => {
    const d = depsReturning('{"notices":[{"text":"連絡だけ"}]}');
    const r = await assistDraftAllAction("class", CLASS_ID, "連絡だけ", {}, d);
    expect(r).toEqual({
      ok: true,
      schedules: [],
      notices: [{ text: "連絡だけ" }],
      assignments: [],
    });
  });

  it("3 種すべて空/壊れた応答は no_result", async () => {
    const d = depsReturning('{"schedules":[],"notices":[],"assignments":[]}');
    expect(await assistDraftAllAction("class", CLASS_ID, "x", {}, d)).toEqual({
      ok: false,
      reason: "no_result",
    });
  });

  it("氏名らしき語は pii_warning（共有 soft-gate・送信しない）", async () => {
    h.findSuspectedPersonalNames.mockReturnValue([{ surface: "田中先生" }]);
    const d = depsReturning('{"notices":[{"text":"x"}]}');
    const r = await assistDraftAllAction("class", CLASS_ID, "田中先生", {}, d);
    expect(r).toEqual({ ok: false, reason: "pii_warning", suspectedSurfaces: ["田中先生"] });
    expect(d.model.generate).not.toHaveBeenCalled();
  });
});

describe("assistDraftScheduleFromFileAction", () => {
  it("PDF 正常 → schedules を返し extractText と audit が動く", async () => {
    h.extractText.mockResolvedValue({ text: "1限 数学 / 2限 英語", format: "pdf" });
    const d = depsReturning(
      '{"schedules":[{"period":1,"subject":"数学"},{"period":2,"subject":"英語"}]}',
    );
    const r = await assistDraftScheduleFromFileAction(
      "class",
      CLASS_ID,
      fileForm(pdfFile()),
      {},
      d,
    );
    expect(r).toEqual({
      ok: true,
      schedules: [
        { period: 1, subject: "数学" },
        { period: 2, subject: "英語" },
      ],
    });
    expect(h.extractText).toHaveBeenCalledOnce();
    expect(h.insertValues).toHaveBeenCalledOnce();
  });

  it("画像(PNG) は OCR で schedules を抽出し、OCR egress 監査 + draft 監査を書く（ADR-038）", async () => {
    h.extractText.mockResolvedValue({ text: "1限 数学", format: "image", meta: { ocrUsed: true } });
    const d = depsReturning('{"schedules":[{"period":1,"subject":"数学"}]}');
    const r = await assistDraftScheduleFromFileAction(
      "class",
      CLASS_ID,
      fileForm(imageFile()),
      {},
      d,
    );
    expect(r).toEqual({ ok: true, schedules: [{ period: 1, subject: "数学" }] });
    expect(h.extractText.mock.calls[0]?.[1]).toMatchObject({ ocr: expect.anything() });
    expect(h.insertValues).toHaveBeenCalledTimes(2);
  });

  it("真に非対応な MIME（application/zip）は unsupported_format（抽出前に弾く）", async () => {
    const d = depsReturning('{"schedules":[]}');
    const r = await assistDraftScheduleFromFileAction(
      "class",
      CLASS_ID,
      fileForm(pdfFile("x.zip", "application/zip")),
      {},
      d,
    );
    expect(r).toEqual({ ok: false, reason: "unsupported_format" });
    expect(h.extractText).not.toHaveBeenCalled();
  });
});
