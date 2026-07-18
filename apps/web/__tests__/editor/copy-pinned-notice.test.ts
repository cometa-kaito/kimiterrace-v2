import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * copyDayFromAction（ほかの日からコピー・日経路）が **対象日の固定連絡（pinned・§5.4「ずっと」表示）を
 * 保全する**ことの回帰テスト（2026-07-18 #1289 レビュー指摘）。コピーは対象日の連絡列を全置換するため、
 * これが無いと教員が対象日に置いた固定連絡が複製で静かに消える（AI 反映は preservePinnedNotices で保全
 * するのにコピーだけ抜けていた本番ギャップ）。
 *
 * ここでは他の action テスト（copy-restore-action / morning-draft-actions）と違い **tx を実行する**:
 * withSession をコールバック直実行に差し替え、tx 内コア（copyOneDay の連絡マージ配線）が実際に
 * upsertDailySectionForTarget へ渡す notices を実測する。純マージ自体の正しさは assistant-chat-core の
 * preservePinnedNotices ユニットが担う。DB / 認可 / パターン解決の各シーム（query・guard・withSession・
 * signage-design・daily-data-write・@kimiterrace/db）だけを stub し、**pinned の純ロジック
 * （copyableNoticeItems / preservePinnedNotices）はモックせず実体を通す**（保全挙動そのものを検証するため）。
 * RLS/越境封じは packages/db の実 PG テストへ委譲。
 */

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getClassName: vi.fn(),
  getClassSchedule: vi.fn(),
  getClassNotices: vi.fn(),
  getClassAssignments: vi.fn(),
  getSignageDesignPattern: vi.fn(),
  getClassSignageUrl: vi.fn(),
  upsert: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: h.requireRole }));
// withSession はコールバックを fake tx で直実行する（tx 内コア＝pinned 保全の配線を実測するため）。
vi.mock("../../lib/db", () => ({
  withSession: (cb: (tx: unknown) => unknown) => cb({}),
}));
// パターン解決・DB シームは全 stub（tx は触らせない）。他の非 mock モジュールは @kimiterrace/db を型
// （import type）でしか参照しないため、この 4 モジュールを stub すると @kimiterrace/db の実行時消費は
// copy-day-actions 自身だけになる（下の @kimiterrace/db stub はそのぶんだけ提供すれば足りる）。
vi.mock("../../lib/signage/signage-design", () => ({
  getSignageDesignPattern: h.getSignageDesignPattern,
}));
vi.mock("../../lib/editor/schedule-queries", () => ({
  getClassName: h.getClassName,
  getClassSchedule: h.getClassSchedule,
}));
vi.mock("../../lib/editor/notice-assignment-queries", () => ({
  getClassNotices: h.getClassNotices,
  getClassAssignments: h.getClassAssignments,
}));
vi.mock("@kimiterrace/db", () => ({
  auditLog: {},
  getClassSignageUrl: h.getClassSignageUrl,
  // pattern1 は visitor / callout ブロックを持たないため下記は呼ばれない（import 解決のためだけの stub）。
  getVisitorsForClass: vi.fn(),
  getCalloutsForClass: vi.fn(),
  replaceClassVisitors: vi.fn(),
  replaceStudentCallouts: vi.fn(),
}));
// daily-data-write は upsert のみ実行（spy）。catch で使う EditorTargetNotFoundError / isUniqueViolation は
// @kimiterrace/db に依存しない自己完結物なので stub を提供して実体ロードを避ける。
vi.mock("../../lib/editor/daily-data-write", () => ({
  EditorTargetNotFoundError: class EditorTargetNotFoundError extends Error {},
  isUniqueViolation: () => false,
  upsertDailySectionForTarget: h.upsert,
}));

import { copyDayFromAction } from "../../lib/editor/copy-day-actions";

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const FROM = "2026-06-01";
const TO = "2026-06-02";
const teacher = { uid: USER_ID, role: "teacher" as const, schoolId: SCHOOL_ID };

/** 各日付の daily セクションを供給する共通配線（fromDate=複製元 / toDate=対象日の RAW を出し分ける）。 */
function wireDailyByDate(
  byDate: Record<string, { schedule?: unknown[]; notice?: unknown[]; assignment?: unknown[] }>,
) {
  h.getClassSchedule.mockImplementation(async (_tx, _c, date: string) => ({
    items: byDate[date]?.schedule ?? [],
  }));
  h.getClassNotices.mockImplementation(async (_tx, _c, date: string) => ({
    items: byDate[date]?.notice ?? [],
  }));
  h.getClassAssignments.mockImplementation(async (_tx, _c, date: string) => ({
    items: byDate[date]?.assignment ?? [],
  }));
}

/** copyDayFromAction が書いた特定フィールドの notices を取り出す（upsert 引数: tx, actor, target, date, field, value）。 */
function writtenNotices(): { date: string; value: unknown }[] {
  return h.upsert.mock.calls
    .filter((c) => c[4] === "notices")
    .map((c) => ({ date: c[3] as string, value: c[5] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleReset();
});

function requireRoleReset() {
  h.requireRole.mockResolvedValue(teacher);
  h.getClassName.mockResolvedValue("1年1組"); // 可視（非 null）
  h.getSignageDesignPattern.mockResolvedValue("pattern1"); // 連絡ブロックを持つ既定パターン
  h.getClassSignageUrl.mockResolvedValue(null); // 端末別 ?design 無し → 学校既定へ
  h.upsert.mockResolvedValue("row-id");
}

describe("copyDayFromAction — 対象日の固定連絡の保全（#1289）", () => {
  it("対象日の pinned 連絡はコピーで消えず、複製内容の前へ合流する（複製元 pinned は二重掲示にしない）", async () => {
    wireDailyByDate({
      // 複製元: 通常連絡 + 固定連絡（固定は copyableNoticeItems で複製対象外になる想定）。
      [FROM]: {
        schedule: [{ period: 1, subject: "数学" }],
        notice: [{ text: "源の通常連絡" }, { text: "源の固定連絡", pinned: true }],
      },
      // 対象日: 教員が置いた固定連絡 + 通常連絡（コピーは通常連絡を置換、固定は残すべき）。
      [TO]: { notice: [{ text: "対象の固定連絡", pinned: true }, { text: "対象の通常連絡" }] },
    });

    const res = await copyDayFromAction(CLASS_ID, FROM, TO);
    expect(res).toMatchObject({ ok: true });

    const notices = writtenNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.date).toBe(TO);
    // 対象日の固定連絡が先頭に保全され、複製元の**通常**連絡だけが後続する。
    // 複製元の固定連絡（源の固定連絡）は複製されない＝二重掲示にならない。対象日の通常連絡は置換で消える。
    expect(notices[0]?.value).toEqual([
      { text: "対象の固定連絡", pinned: true },
      { text: "源の通常連絡" },
    ]);

    // 「複製しました」件数は複製元由来（通常連絡 1 件）＝プレビューと一致し、保全した pinned は数に含めない。
    if (!res.ok) throw new Error("unreachable");
    const noticeSection = res.data.sections.find((s) => s.block === "notice");
    expect(noticeSection?.count).toBe(1);
    // undo スナップショットは上書き前の RAW（pinned 含む）を控える＝元に戻すで完全復元できる。
    expect(res.data.undo.notice).toEqual([
      { text: "対象の固定連絡", pinned: true },
      { text: "対象の通常連絡" },
    ]);
  });

  it("複製元の連絡が空でも対象日の pinned 連絡は残る（他ブロックがあり total>0 で複製は成立）", async () => {
    wireDailyByDate({
      [FROM]: { schedule: [{ period: 1, subject: "数学" }], notice: [] },
      [TO]: { notice: [{ text: "対象の固定連絡", pinned: true }, { text: "対象の通常連絡" }] },
    });

    const res = await copyDayFromAction(CLASS_ID, FROM, TO);
    expect(res).toMatchObject({ ok: true });

    const notices = writtenNotices();
    expect(notices).toHaveLength(1);
    // 複製元の連絡が空でも固定連絡は保全される（通常連絡は空で置換）。
    expect(notices[0]?.value).toEqual([{ text: "対象の固定連絡", pinned: true }]);

    if (!res.ok) throw new Error("unreachable");
    expect(res.data.sections.find((s) => s.block === "notice")?.count).toBe(0);
  });
});
