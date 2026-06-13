import { findSuspectedPersonalNames } from "@kimiterrace/ai";
import { ContentNotFoundError, getContentDetail, publishContent } from "@kimiterrace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P-02 / SEC-029: 即公開フロー安全網のバイパス・形骸化耐性の敵対監査
 * (Part of #243、トラック③ `docs/testing/tracks/03-security-pentest.md`)。
 *
 * 脅威: 承認フロー非採用の「即公開」(ADR-015) を支える安全網が、リファクタや「警告がうるさい」等の理由で
 * **形骸化 (vestigial 化)** し、誤公開の予防/事後対応が実質無効になる。本スイートは安全網を**能動的に駆動**し、
 * 「黙って無効化できない」不変条件を固定する (期待: SEC-029「ダイアログ skip 不能 / confidence 閾値 /
 * rollback 猶予 / 端末記録」)。
 *
 * ─── 実装された安全網 (ADR-015 + ADR-030) と本テストの対象 ───
 *  A. AI 確信度フラグ (F04.3): needsReview / REVIEW_CONFIDENCE_THRESHOLD ……… 閾値の形骸化耐性を固定
 *  B. PII soft-gate (ADR-030、即公開の「確認」機構): publishContentAction …… バイパス不能 + fail-closed + 監査必須
 *  C. 公開先明示 (F04.4): DEFAULT_PUBLISH_SCOPE / resolveEditorDefaults …… 既定が最狭から黙って広がらない
 *
 * ─── 範囲正直 (scope honesty) ───
 * - **「確認ダイアログ」**: ADR-015 は承認フロー非採用ゆえ**ブロッキング確認モーダルを持たない**。実装された
 *   誤公開防止機構は (a) PII soft-gate override (ADR-030) と (b) 公開先明示セレクタ (既定未選択・全校を強調しない)。
 *   本テストはこの**実在機構**のバイパス不能性を固定する (skip すべきモーダルがそもそも無い)。
 * - **confidence 閾値**: ADR-015 §F04.3 authoritative = **0.7**。security-track doc SEC-029 の「0.8」は
 *   **ドキュメントのドリフト** (ADR が型/設計の単一ソース、ADR が勝つ)。閾値変更は ADR-015 改訂必須。
 * - **rollback 猶予 ≥ 5 分**: 実装は時間窓の猶予でなく**永続バージョン履歴** (content_versions 全保管・常時 1-click)
 *   で「≥ 5 分」を上回る。巻き戻しの実体は **packages/db ドメイン層 = 本レーン外**、不変条件の実証は実 PG E2E。
 * - **publish_target_devices / 端末記録**: 公開操作の audit_log 記録は packages/db ドメインサービスが担い、端末 ID
 *   一覧記録は signage/device 配線 (F12/F15) = **本レーン外 / staging E2E**。action 層では PII override の
 *   **件数のみ監査** (生氏名非複製、ルール4) を固定する。
 * - 実 RLS / 実 tx / 実公開・巻き戻しは実 PG E2E (#372 系) に委譲。本テストは action の*配線*と安全網の
 *   *形骸化耐性*を mock 下で固定する。PII 検出器の**ヒューリスティック精度**は @kimiterrace/ai 自身の責務 (#474);
 *   ここは検出器の出力 (N 件 / 0 件 / 例外) に対する **action の gate 挙動**を固定する。
 */

// @kimiterrace/db は部分 mock (ContentNotFoundError 等の実クラスを保持しつつ、gate が呼ぶ getContentDetail /
// publishContent だけ vi.fn 化)。@kimiterrace/ai の検出器は**完全制御**の vi.fn にし、N 件/0 件/例外を駆動する。
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return { ...actual, getContentDetail: vi.fn(), publishContent: vi.fn() };
});
vi.mock("@kimiterrace/ai", () => ({ findSuspectedPersonalNames: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));
vi.mock("../../lib/auth/guard", () => ({
  requireUser: vi.fn(),
  isRoleAllowed: (role: string, allowed: readonly string[]) => allowed.includes(role),
}));
vi.mock("../../lib/db", () => ({ withSession: vi.fn(), withUserSession: vi.fn() }));

import { requireUser } from "../../lib/auth/guard";
import { publishContentAction } from "../../lib/contents/publish-actions";
import {
  DEFAULT_PUBLISH_SCOPE,
  type ExtractionSuggestions,
  resolveEditorDefaults,
} from "../../lib/contents/publish-core";
import {
  REVIEW_CONFIDENCE_THRESHOLD,
  SCOPE_OPTIONS,
  needsReview,
} from "../../lib/contents/publish-view";
import { withSession } from "../../lib/db";

const requireUserMock = vi.mocked(requireUser);
const withSessionMock = vi.mocked(withSession);
const getContentDetailMock = vi.mocked(getContentDetail);
const publishContentMock = vi.mocked(publishContent);
const findSuspectsMock = vi.mocked(findSuspectedPersonalNames);

const CONTENT_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
// 公開系の正常系 actor = publisher（finding⑧ で teacher を PUBLISHER_ROLES から除外したため school_admin）。
const teacher = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };

/** getContentDetail の戻り値を body 指定で組む (gate は content.body のみ読む)。 */
function detailWithBody(body: string): NonNullable<Awaited<ReturnType<typeof getContentDetail>>> {
  return {
    content: {
      id: CONTENT_ID,
      title: "お知らせ",
      body,
      publishScope: "school",
      status: "draft",
      targets: [],
      updatedAt: new Date(0),
    },
    versions: [],
    activePublish: null,
  };
}

/** withSession の callback を実行する fakeTx。`insert().values()` (監査書込) を記録する。 */
function makeFakeTx() {
  const inserted: unknown[] = [];
  const tx = { insert: () => ({ values: (v: unknown) => inserted.push(v) }) };
  // biome-ignore lint/suspicious/noExplicitAny: 最小 tx スタブ (実 RLS tx は実 PG E2E が担う)。
  return { tx: tx as any, inserted };
}

/** 検出器が「N 件の疑わしい氏名」を返すよう仕込む。 */
function detectorReturns(...surfaces: string[]) {
  findSuspectsMock.mockReturnValue(
    // biome-ignore lint/suspicious/noExplicitAny: 検出器戻り値は action が .length / .surface のみ読む。
    surfaces.map((surface) => ({ surface }) as any),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue(teacher);
  // 既定: 検出器は「疑わしい氏名なし」。各テストで上書きする。
  findSuspectsMock.mockReturnValue([]);
  // 公開ドメインサービスの既定戻り値。
  publishContentMock.mockResolvedValue({ publishId: "pub-1", versionId: "v-1", version: 1 });
});

// ───────────────────────── A. AI 確信度フラグ (F04.3) の形骸化耐性 ─────────────────────────

describe("A. 確信度閾値が黙って無効化されない (F04.3 / ADR-015 §F04.3)", () => {
  it("閾値は非退化な帯域 (0 < t < 1) にある — 0/負/1+ への黙改変で flag が死ぬのを防ぐ", () => {
    // 攻撃/不注意リファクタ: 閾値を 0 や負に下げると needsReview が常に false = 安全網が vestigial 化。
    // 帯域固定でこれを破断させる。realistic な下限 (0.5) も併せて要求する。
    expect(REVIEW_CONFIDENCE_THRESHOLD).toBeGreaterThanOrEqual(0.5);
    expect(REVIEW_CONFIDENCE_THRESHOLD).toBeLessThan(1);
  });

  it("ADR-015 authoritative = 0.7 を pin (doc SEC-029 の 0.8 はドリフト、ADR が勝つ / 変更は ADR-015 改訂必須)", () => {
    expect(REVIEW_CONFIDENCE_THRESHOLD).toBe(0.7);
  });

  it("既定経路で realistic な低確信 AI 出力を必ず要確認にする (閾値定数の黙改変で破断する)", () => {
    // threshold 引数を渡さず**既定束縛**で駆動する。閾値定数を黙って下げると、これらが false に転んで破断する。
    expect(needsReview(0.5)).toBe(true);
    expect(needsReview(0.69)).toBe(true);
    // 正の対比: 高確信は要確認にしない (= 常に true の空虚 flag ではない)。
    expect(needsReview(0.85)).toBe(false);
    expect(needsReview(0.95)).toBe(false);
  });

  it("人手作成 (score 無し) を誤って要確認にしない — flag の信頼性を保つ", () => {
    // 誤 flag が多発すると教員が flag を無視し始め、安全網が事実上死ぬ。null/undefined は出さない。
    expect(needsReview(null)).toBe(false);
    expect(needsReview(undefined)).toBe(false);
  });
});

// ───────────────────────── B. PII soft-gate (即公開の「確認」機構) のバイパス不能性 ─────────────────────────

describe("B. PII soft-gate を黙ってすり抜けられない (ADR-030)", () => {
  it("検出器が例外を投げたら fail-closed: 公開しない (gate を try/catch で握り潰す形骸化を破断)", async () => {
    // 形骸化の典型: 「検出器が落ちると公開できないと困る」と検出を try/catch で握り潰し [] 扱い → gate が常時開く。
    // 現実装は例外を伝播させ mapDomainError が再 throw (= 5xx、公開せず)。fail-OPEN への退行を破断する。
    findSuspectsMock.mockImplementation(() => {
      throw new Error("detector boom");
    });
    getContentDetailMock.mockResolvedValue(detailWithBody("本文"));
    const { tx, inserted } = makeFakeTx();
    withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
    await expect(publishContentAction(CONTENT_ID)).rejects.toThrow("detector boom");
    // 公開も監査も走らない (fail-closed)。
    expect(publishContentMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it.each([
    ["opts 省略", undefined],
    ["空 opts {}", {}],
    ["acknowledgePii=false", { acknowledgePii: false }],
  ])("override 無し (%s) は検出ありで公開しない — 既定で gate は閉じる", async (_label, opts) => {
    detectorReturns("佐藤さん");
    getContentDetailMock.mockResolvedValue(detailWithBody("佐藤さんが受賞しました。"));
    const { tx, inserted } = makeFakeTx();
    withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
    const res = await publishContentAction(CONTENT_ID, opts as { acknowledgePii?: boolean });
    expect(res).toMatchObject({ ok: false, code: "pii_warning" });
    expect(publishContentMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("override (acknowledgePii=true) は公開を許す — gate は hard-block でなく soft (正の対比)", async () => {
    detectorReturns("佐藤さん");
    getContentDetailMock.mockResolvedValue(detailWithBody("佐藤さんが受賞しました。"));
    const { tx } = makeFakeTx();
    withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
    const res = await publishContentAction(CONTENT_ID, { acknowledgePii: true });
    expect(res).toEqual({ ok: true, data: { publishId: "pub-1", version: 1 } });
    expect(publishContentMock).toHaveBeenCalledTimes(1);
  });

  it("override 公開は常に監査される & 複数氏名でも件数のみ (生氏名を audit に複製しない、ルール4)", async () => {
    // 「確認を承知で公開」した事実は必ず痕跡が残る (R-01 否認防止)。多氏名でも件数だけ・表層は漏らさない。
    detectorReturns("佐藤さん", "鈴木くん", "田中先生");
    getContentDetailMock.mockResolvedValue(
      detailWithBody("佐藤さん・鈴木くん・田中先生が表彰されました。"),
    );
    const { tx, inserted } = makeFakeTx();
    withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
    const res = await publishContentAction(CONTENT_ID, { acknowledgePii: true });
    expect(res).toMatchObject({ ok: true });
    // 監査が必ず 1 件書かれる (override の立証)。
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      tableName: "contents",
      recordId: CONTENT_ID,
      operation: "update",
      actorUserId: USER_ID,
      schoolId: SCHOOL_ID,
      diff: { piiOverride: true, suspectedNameCount: 3 },
    });
    // 件数は実際の検出数と一致し、生の疑わしい氏名は監査 JSON に一切出ない。
    const auditJson = JSON.stringify(inserted[0]);
    for (const name of ["佐藤", "鈴木", "田中"]) {
      expect(auditJson).not.toContain(name);
    }
  });

  it("gate は実際に公開する本文 (getContentDetail) に対して走る — 検出対象のすり替えが無い", async () => {
    // 検出を空文字や別ソースに対して走らせる形骸化を防ぐ: 公開対象の本文がそのまま検出器に渡る。
    detectorReturns("匿名さん");
    getContentDetailMock.mockResolvedValue(detailWithBody("本文ABC"));
    const { tx } = makeFakeTx();
    withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
    await publishContentAction(CONTENT_ID);
    expect(findSuspectsMock).toHaveBeenCalledWith("本文ABC");
  });

  it("検出なし (clean) は override 無しで公開し、PII 監査は書かない (正の対比)", async () => {
    findSuspectsMock.mockReturnValue([]);
    getContentDetailMock.mockResolvedValue(detailWithBody("体育祭は6月10日に開催します。"));
    const { tx, inserted } = makeFakeTx();
    withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
    const res = await publishContentAction(CONTENT_ID);
    expect(res).toEqual({ ok: true, data: { publishId: "pub-1", version: 1 } });
    expect(inserted).toHaveLength(0);
  });

  it("不可視/不存在 (getContentDetail=null) は検出器に到達する前に not_found で停止", async () => {
    getContentDetailMock.mockResolvedValue(null);
    const { tx } = makeFakeTx();
    withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
    const res = await publishContentAction(CONTENT_ID);
    expect(res).toMatchObject({ ok: false, code: "not_found" });
    expect(findSuspectsMock).not.toHaveBeenCalled();
    expect(publishContentMock).not.toHaveBeenCalled();
  });

  it("ドメイン例外 (公開中に ContentNotFound) は握り潰さず error 結果へ (公開成功を偽装しない)", async () => {
    detectorReturns(); // 0 件
    getContentDetailMock.mockResolvedValue(detailWithBody("本文"));
    publishContentMock.mockRejectedValue(new ContentNotFoundError(CONTENT_ID));
    const { tx } = makeFakeTx();
    withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
    const res = await publishContentAction(CONTENT_ID);
    expect(res).toMatchObject({ ok: false, code: "not_found" });
  });
});

// ───────────────────────── C. 公開先明示 (F04.4) の形骸化耐性 ─────────────────────────

describe("C. 公開先の既定が最狭から黙って広がらない (F04.4)", () => {
  it("既定スコープは最狭の private — 全校/クラス等の広域へ黙改変できない", () => {
    // DEFAULT_PUBLISH_SCOPE を school 等に黙って変えると、公開先未選択が自動で広域配信になる。private を固定。
    expect(DEFAULT_PUBLISH_SCOPE).toBe("private");
  });

  it("セレクタは全校を既定/先頭にせず末尾側に置く (誤って広域を選ばせない)", () => {
    expect(SCOPE_OPTIONS[0]?.value).not.toBe("school");
    expect(SCOPE_OPTIONS.at(-1)?.value).toBe("school");
  });

  it("AI 提案が無い/不正なら最狭 private にフォールバック (越境入力を信用しない)", () => {
    // 提案欠如 → private。
    expect(resolveEditorDefaults().publishScope).toBe("private");
    expect(resolveEditorDefaults({}).publishScope).toBe("private");
    // 不正値 (enum 外) → 広域でなく private に倒す (AI 出力の汚染で勝手に全校化させない)。
    const tainted = { publishScope: "everyone" } as unknown as ExtractionSuggestions;
    expect(resolveEditorDefaults(tainted).publishScope).toBe("private");
  });

  it("正の対比: 妥当な AI 提案 (class) は尊重する — フォールバックは常時 private の空虚さではない", () => {
    const suggestion = { publishScope: "class" } as ExtractionSuggestions;
    expect(resolveEditorDefaults(suggestion).publishScope).toBe("class");
  });
});
