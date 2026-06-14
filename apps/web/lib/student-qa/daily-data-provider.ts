import type { ChatContext, EmbeddingClient } from "@kimiterrace/ai";
import type { RagAudience, TenantTx } from "@kimiterrace/db";
import { getEffectiveDailyData } from "@/lib/signage/effective-daily-data";
import { parseSignageDate } from "@/lib/signage/rotation";
import { createRagContentProvider } from "./context-provider";
import type { GroundingResult } from "./chat-service";

/**
 * F06 / ADR-040: 生徒/保護者 Q&A の **知識源を編集(daily_data)に再ソース化**する直接注入プロバイダ。
 *
 * ADR-038 D1 は知識源を「school_admin が公開した curated contents」に固定したが、`contents` は実運用で
 * 空（投入の担い手が不在、[[project_teacher_ui_editor_only]]）だった。ADR-040（2026-06-14 ユーザー判断）で
 * **教員が日々作る編集（`daily_data` の連絡/提出物）を知識源に再ソース化**する。daily_data は日付限定・
 * 小規模・高頻度更新・鮮度命のデータで、ベクトル RAG（大量・恒久知識向け）より **直接注入**が適合する
 * （常に最新・バッチ遅延なし・スキーマ/新ジョブ不要）。
 *
 * ## 取得経路（既存資産を不変で再利用）
 * - `getEffectiveDailyData(tx, classId, date)`（`lib/signage/effective-daily-data.ts`）で当該クラスの
 *   **「今日表示中」の notices/assignments** を取得する。表示日数（`isNoticeActive`）・期限+猶予
 *   （`isAssignmentActive`）・クラス階層マージ（class>grade>department>school）・RLS 自校スコープ
 *   （ルール2、手書き `school_id` 非依存）がすべて当該関数に内包される。生徒が今見ているサイネージと
 *   Q&A の知識ソースが一致する。
 * - `date` は JST 今日（`parseSignageDate(undefined)` と同じ既定）。テストは `opts.today` で注入する。
 *
 * ## grounding モード（ADR-028 §3）
 * daily_data の連絡/提出物は **学校が実際に掲示している権威的な内容**ゆえ、1 件以上あれば
 * `mode="grounded"` で返す（フォールバックの `general_supplement` とは異なり、掲示準拠と申告してよい）。
 * 該当が 0 件のときは空 `contexts` を返し、合成プロバイダ（{@link createDailyDataFirstProvider}）が
 * 既存の curated-contents RAG → `general_supplement` フォールバックへ委ねる。
 *
 * ## PII（ルール4・ADR-040 D4）
 * 本プロバイダは title/body を **マスクせず生のまま返す**。マスキングは chat-service の step6 が
 * `maskPII`（電話/メール）+ `redactSuspectedNames`（氏名ヒューリスティック）+ `findUnmaskedPii`
 * fail-closed で一元的に行う既存契約を踏襲する（他プロバイダと同一）。daily_data は自由記述ゆえ curated
 * contents より氏名を含みやすく PII 露出面は広がるが（ADR-030 受容リスクの面拡大）、確定マスク不可な
 * 氏名は fail-closed が最終防御。本プロバイダはこの境界を一切変更しない。
 *
 * ## クラス境界（#481-2）
 * 生徒（`kind:"student"`）の `classId` でクラス可視分のみ取得する。`classId` が無い / 教員
 * （`kind:"staff"`、Q&A は #867 で撤去中）は daily_data 注入の対象外（空を返す）。
 */

/** 注入する連絡/提出物の既定件数（プロンプト肥大とコストを抑える bounded 既定）。 */
const DEFAULT_DAILY_LIMIT = 8;
/** 注入件数の上限（濫用・プロンプト肥大の防御）。 */
const MAX_DAILY_LIMIT = 20;

/** 本モジュールの provider が返す narrow な関数型（{@link ContextProvider} に代入可能）。 */
type GroundingProvider = (
  tx: TenantTx,
  params: { audience: RagAudience; maskedQuestion: string },
) => Promise<GroundingResult>;

/** {@link createDailyDataContentProvider} の設定。 */
export type DailyDataProviderOptions = {
  /** 取得基準日 YYYY-MM-DD（テスト決定性のための注入）。既定/無効値は JST 今日へフォールバック。 */
  today?: string;
  /** 注入する連絡+提出物の最大合計件数（既定 {@link DEFAULT_DAILY_LIMIT}、1〜{@link MAX_DAILY_LIMIT}）。 */
  limit?: number;
};

/** unknown を non-empty string として取り出す（JSONB 由来の項目を防御的に読む）。 */
function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 実効 daily_data の notices/assignments を {@link ChatContext} 配列へ整形する純関数。
 * items は `unknown[]`（JSONB）なので各フィールドを型ガードで取り出し、本文の無い項目は捨てる。
 * 連絡 → 提出物の順、合計 `limit` 件にクランプ。id は合成（非 PII、evidence 参照用）。
 */
export function buildDailyDataContexts(
  notices: readonly unknown[],
  assignments: readonly unknown[],
  classId: string,
  date: string,
  limit: number,
): ChatContext[] {
  const contexts: ChatContext[] = [];

  notices.forEach((item, i) => {
    const text = asText((item as { text?: unknown })?.text);
    if (text === null) return;
    contexts.push({
      id: `daily-notice:${classId}:${date}:${i}`,
      title: "連絡（お知らせ）",
      body: text,
    });
  });

  assignments.forEach((item, i) => {
    const subject = asText((item as { subject?: unknown })?.subject);
    const task = asText((item as { task?: unknown })?.task);
    const deadline = asText((item as { deadline?: unknown })?.deadline);
    // 本文（task）が無い項目は知識として無価値なので捨てる。subject/deadline は補助。
    if (task === null) return;
    const title = subject === null ? "提出物" : `提出物（${subject}）`;
    const body = deadline === null ? task : `${task}（期限: ${deadline}）`;
    contexts.push({ id: `daily-assignment:${classId}:${date}:${i}`, title, body });
  });

  return contexts.slice(0, limit);
}

/**
 * 編集(daily_data)を知識源にする {@link ContextProvider} を生成する（ADR-040、直接注入）。
 *
 * - 生徒（`classId` あり）のみ対象。staff / classId なしは空（合成側が RAG フォールバックへ委ねる）。
 * - `getEffectiveDailyData` で今日表示中の連絡/提出物を取得 → {@link buildDailyDataContexts} で整形。
 * - 1 件以上で `mode="grounded"`、0 件は空配列（mode は便宜上 general_supplement だが contexts 空が要点）。
 */
export function createDailyDataContentProvider(
  opts: DailyDataProviderOptions = {},
): GroundingProvider {
  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? DEFAULT_DAILY_LIMIT)),
    MAX_DAILY_LIMIT,
  );

  return async (tx, params): Promise<GroundingResult> => {
    const { audience } = params;
    if (audience.kind !== "student" || audience.classId === null) {
      return { mode: "general_supplement", contexts: [] };
    }
    const date = parseSignageDate(opts.today);
    const effective = await getEffectiveDailyData(tx, audience.classId, date);
    if (!effective) {
      return { mode: "general_supplement", contexts: [] };
    }
    const contexts = buildDailyDataContexts(
      effective.notices.items,
      effective.assignments.items,
      audience.classId,
      date,
      limit,
    );
    if (contexts.length === 0) {
      return { mode: "general_supplement", contexts: [] };
    }
    return { mode: "grounded", contexts };
  };
}

/** {@link createDailyDataFirstProvider} の設定。 */
export type DailyDataFirstProviderOptions = {
  /** curated contents RAG フォールバック用の Vertex embedding クライアント。 */
  embeddingClient: EmbeddingClient;
  /** 取得基準日（テスト注入、既定 JST 今日）。 */
  today?: string;
  /** grounding 件数上限（daily_data・RAG 双方に適用、既定 {@link DEFAULT_DAILY_LIMIT}）。 */
  limit?: number;
};

/**
 * **daily_data 優先**の合成 {@link ContextProvider}（ADR-040 本番経路、sse-handler が注入）。
 *
 * 1. {@link createDailyDataContentProvider} で当該クラスの今日表示中の連絡/提出物を取得。grounded
 *    文脈が 1 件以上あればそれを採用する（学校が実掲示している権威的内容＝掲示準拠）。
 * 2. daily_data に該当が無ければ、既存の {@link createRagContentProvider}（curated contents の
 *    ベクトル RAG → 0 件なら最近の公開掲示物 `general_supplement`）へフォールバックする。これにより
 *    将来 curated contents を運用したくなった場合の経路を温存する（ADR-040 D3、embedding Job は未 apply）。
 */
export function createDailyDataFirstProvider(
  opts: DailyDataFirstProviderOptions,
): GroundingProvider {
  const daily = createDailyDataContentProvider({ today: opts.today, limit: opts.limit });
  const rag = createRagContentProvider({
    embeddingClient: opts.embeddingClient,
    limit: opts.limit,
  });

  return async (tx, params): Promise<GroundingResult> => {
    const fromDaily = await daily(tx, params);
    if (fromDaily.contexts.length > 0) {
      return fromDaily;
    }
    return rag(tx, params);
  };
}
