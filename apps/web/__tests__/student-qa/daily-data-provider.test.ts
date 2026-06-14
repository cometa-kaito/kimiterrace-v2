import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-040: 編集(daily_data)直接注入プロバイダの **合成ロジック**を決定的に固める。
// daily_data 取得（鮮度窓+クラス階層+RLS）の実 PG 挙動は signage 側 / packages/db の結合テストが担い、
// ここでは getEffectiveDailyData を mock して provider の整形・分岐・フォールバックのみ検証する（ADR-012）。
vi.mock("@/lib/signage/effective-daily-data", () => ({
  getEffectiveDailyData: vi.fn(),
}));
// RAG フォールバック（createRagContentProvider）は @kimiterrace/db を引くため空に倒し、
// 「daily_data 0 件 → general_supplement(空)」へ落ちることを決定的にする。
vi.mock("@kimiterrace/db", () => ({
  listContents: vi.fn(async () => []),
  getContentDetail: vi.fn(async () => null),
  getRelevantPublishedContent: vi.fn(async () => []),
}));

import type { EmbeddingClient } from "@kimiterrace/ai";
import type { EffectiveDailyData } from "@/lib/signage/effective-daily-data";
import { getEffectiveDailyData } from "@/lib/signage/effective-daily-data";
import type { RagAudience, TenantTx } from "@kimiterrace/db";
import {
  buildDailyDataContexts,
  createDailyDataContentProvider,
  createDailyDataFirstProvider,
} from "../../lib/student-qa/daily-data-provider";

const mockEff = vi.mocked(getEffectiveDailyData);

const tx = { __brand: "fake-tx" } as unknown as TenantTx;
const CLASS_ID = "00000000-0000-0000-0000-0000000000bb";
const TODAY = "2026-06-14";
const STUDENT: RagAudience = { kind: "student", classId: CLASS_ID };
const STUDENT_NO_CLASS: RagAudience = { kind: "student", classId: null };
const STAFF: RagAudience = { kind: "staff" };

/** マスク済み質問は空でよい（RAG フォールバックは embedding を呼ばず直接取得 MVP へ落ちる）。 */
const PARAMS = (audience: RagAudience) => ({ audience, maskedQuestion: "" });

/** RAG フォールバック用のダミー embedding クライアント（空質問なので実呼び出しはされない）。 */
const embeddingClient = {
  embed: vi.fn(async (xs: string[]) => xs.map(() => [0.1])),
} as unknown as EmbeddingClient;

function effectiveOf(notices: unknown[], assignments: unknown[]): EffectiveDailyData {
  return {
    date: TODAY,
    schedules: { items: [], source: null },
    notices: { items: notices, source: "class" },
    assignments: { items: assignments, source: "class" },
    quietHours: { items: [], source: null },
  } as EffectiveDailyData;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildDailyDataContexts (純関数)", () => {
  it("連絡→提出物の順で ChatContext に整形する", () => {
    const out = buildDailyDataContexts(
      [{ text: "体育館は使用禁止です", displayDays: 3 }],
      [{ subject: "数学", task: "p.12-15 を解く", deadline: "2026-06-20" }],
      CLASS_ID,
      TODAY,
      8,
    );
    expect(out).toEqual([
      {
        id: `daily-notice:${CLASS_ID}:${TODAY}:0`,
        title: "連絡（お知らせ）",
        body: "体育館は使用禁止です",
      },
      {
        id: `daily-assignment:${CLASS_ID}:${TODAY}:0`,
        title: "提出物（数学）",
        body: "p.12-15 を解く（期限: 2026-06-20）",
      },
    ]);
  });

  it("期限なし提出物は本文に期限を付けない / subject なしは汎用タイトル", () => {
    const out = buildDailyDataContexts(
      [],
      [{ task: "読書感想文" }, { subject: "英語", task: "音読", deadline: "2026-06-18" }],
      CLASS_ID,
      TODAY,
      8,
    );
    expect(out[0]).toMatchObject({ title: "提出物", body: "読書感想文" });
    expect(out[1]).toMatchObject({ title: "提出物（英語）", body: "音読（期限: 2026-06-18）" });
  });

  it("本文の無い項目（text/task 欠落・空白）は捨てる", () => {
    const out = buildDailyDataContexts(
      [{ text: "   " }, { isHighlight: true }, { text: "有効な連絡" }],
      [{ subject: "理科" }, { subject: "国語", task: "漢字" }],
      CLASS_ID,
      TODAY,
      8,
    );
    expect(out.map((c) => c.body)).toEqual(["有効な連絡", "漢字"]);
  });

  it("合計 limit 件にクランプする（連絡優先）", () => {
    const out = buildDailyDataContexts(
      [{ text: "n1" }, { text: "n2" }],
      [{ subject: "x", task: "a" }],
      CLASS_ID,
      TODAY,
      2,
    );
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.body)).toEqual(["n1", "n2"]);
  });

  it("空入力は空配列", () => {
    expect(buildDailyDataContexts([], [], CLASS_ID, TODAY, 8)).toEqual([]);
  });
});

describe("createDailyDataContentProvider", () => {
  it("生徒 + 該当 daily_data ありで mode=grounded + contexts を返す", async () => {
    mockEff.mockResolvedValue(effectiveOf([{ text: "今日は短縮授業" }], []));
    const provider = createDailyDataContentProvider({ today: TODAY });
    const result = await provider(tx, PARAMS(STUDENT));
    expect(mockEff).toHaveBeenCalledWith(tx, CLASS_ID, TODAY);
    expect(result.mode).toBe("grounded");
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]?.body).toBe("今日は短縮授業");
  });

  it("staff は対象外（getEffectiveDailyData を呼ばず空）", async () => {
    const provider = createDailyDataContentProvider({ today: TODAY });
    const result = await provider(tx, PARAMS(STAFF));
    expect(mockEff).not.toHaveBeenCalled();
    expect(result.contexts).toEqual([]);
  });

  it("classId が無い生徒は対象外（空）", async () => {
    const provider = createDailyDataContentProvider({ today: TODAY });
    const result = await provider(tx, PARAMS(STUDENT_NO_CLASS));
    expect(mockEff).not.toHaveBeenCalled();
    expect(result.contexts).toEqual([]);
  });

  it("クラスが不可視（getEffectiveDailyData=null）なら空", async () => {
    mockEff.mockResolvedValue(null);
    const provider = createDailyDataContentProvider({ today: TODAY });
    const result = await provider(tx, PARAMS(STUDENT));
    expect(result.contexts).toEqual([]);
  });

  it("該当 daily_data が空なら mode=general_supplement + 空（合成側がフォールバックする合図）", async () => {
    mockEff.mockResolvedValue(effectiveOf([], []));
    const provider = createDailyDataContentProvider({ today: TODAY });
    const result = await provider(tx, PARAMS(STUDENT));
    expect(result).toEqual({ mode: "general_supplement", contexts: [] });
  });
});

describe("createDailyDataFirstProvider（合成）", () => {
  it("daily_data に該当があればそれを採用（RAG を引かない）", async () => {
    mockEff.mockResolvedValue(effectiveOf([{ text: "プール開放" }], []));
    const provider = createDailyDataFirstProvider({ embeddingClient, today: TODAY });
    const result = await provider(tx, PARAMS(STUDENT));
    expect(result.mode).toBe("grounded");
    expect(result.contexts.map((c) => c.body)).toEqual(["プール開放"]);
  });

  it("daily_data が空なら curated contents RAG → general_supplement にフォールバック", async () => {
    mockEff.mockResolvedValue(effectiveOf([], []));
    const provider = createDailyDataFirstProvider({ embeddingClient, today: TODAY });
    const result = await provider(tx, PARAMS(STUDENT));
    // @kimiterrace/db を空に mock しているのでフォールバックは general_supplement(空)。
    expect(result).toEqual({ mode: "general_supplement", contexts: [] });
  });
});
