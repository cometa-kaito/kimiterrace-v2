import {
  type ModelClient,
  findSuspectedPersonalNames,
  findUnmaskedPii,
  maskPII,
  unmaskPII,
} from "@kimiterrace/ai";
import {
  type CalendarImportEvent,
  type CalendarImportSanitizeDropped,
  type FiscalYearWindow,
  buildCalendarImportSystem,
  buildCalendarImportUser,
  fiscalYearWindow,
  parseCalendarImportProposal,
  sanitizeImportedEvents,
} from "./calendar-import-core";

/**
 * 年間行事予定表テキスト → AI 構造化イベントの **モデル呼び出しオーケストレータ**（ADR-049 PR-B）。
 * `runSectionDraft`（assistant-actions.ts）/ `structureContent`（packages/ai）と同じ流儀:
 * soft-gate → mask → fail-closed → 生成 → パース → マスク空間で fail-closed 再検査 → 逆マスク →
 * サニタイズ。DB / env / 認可には触れない（PR-C の Server Action が authorize / rate limit /
 * `audit_log` 書込 / 抽出レイヤ（extractText）配線 / 保存を担う）。model は依存注入
 * （`createVertexModelClient` を PR-C が構築、テストはフェイク）。
 *
 * ルール4（PII）: Vertex へは `maskPII` 済みテキストのみ送信。マスク後残存（`findUnmaskedPii`）は送信前に
 * fail-closed。氏名らしき高確信パターン（ADR-030 soft-gate）は未 override なら送信せず警告。モデル出力の
 * 文字列フィールドは **逆マスク前（マスク空間）** で残存検査する（#1105 と同型: 辞書由来の正規復元値を
 * 誤検知して正しい下書きを丸ごと落とさない）。
 */

/**
 * 年間行事取込テキストの入力上限（文字）。エディタ AI の `ASSIST_INPUT_MAX`（4000・メモ想定）では
 * 年間表 1 枚（数百行事）が収まらないため専用に広げる。超過は **silent truncate せず** too_long で
 * 失敗させる（年の後半だけ黙って欠ける方が誤読より悪い・ADR-049 沈黙の切り捨て禁止）。
 */
export const CALENDAR_IMPORT_INPUT_MAX = 40_000;

/**
 * 応答トークン上限 = gemini-2.5-flash のモデル出力上限（65,535）。旧値 32,768 は「上限 2000 行事が
 * 途切れない」と注記していたが、2000 行事 × 1 行 ≈ 30〜40 トークン ≈ 60k〜80k と矛盾し、実際は
 * 約 900 行事で JSON が途切れる（#1268 レビュー指摘）。モデル上限まで広げても 2000 行事 + 思考トークン
 * （Gemini 2.5 系はこの枠を消費しうる・2048 で思考が出力を食い潰した本番事象の教訓）は収まらない可能性が
 * 残るが、典型的な年間表（数百行事）には十分で、途切れた JSON はパース失敗 → no_result に fail-closed
 * する（沈黙の切り捨てはしない）。明示指定を続ける理由: 暴走時のコスト CAP（未指定＝上限なしにしない）。
 */
export const CALENDAR_IMPORT_MAX_OUTPUT_TOKENS = 65_535;

/** テスト差し替え用の依存（PR-C が実 Vertex model を注入する。既定なし＝本層は env に触れない）。 */
export interface CalendarImportDraftDeps {
  model: ModelClient;
  /** 年度窓の基準時刻（既定 Date.now()）。テストで年度境界を固定する。 */
  nowMs?: number;
}

/** 失敗結果（`AssistDraftError` と同じ語彙のサブセット。PR-C が UI 文言へ写像する）。 */
export type CalendarImportDraftError =
  | { ok: false; reason: "pii_warning"; suspectedSurfaces: string[] }
  | { ok: false; reason: "empty" | "too_long" | "pii_leak" | "no_result" | "error" };

/** 取込ドラフト結果。dropped は監査/確認 UI 用の理由別件数（沈黙の切り捨て禁止）。 */
export type CalendarImportDraftResult =
  | {
      ok: true;
      events: CalendarImportEvent[];
      dropped: CalendarImportSanitizeDropped & {
        /** スキーマ不適合で drop したモデル出力行数。 */
        malformed: number;
      };
      /** 推定に使った年度窓（確認 UI の年度明示表示・ADR-049 決定4 に使う）。 */
      window: FiscalYearWindow;
      /** soft-gate 検出数（override 済で送信した場合の監査記録用）。 */
      suspectedNameCount: number;
    }
  | CalendarImportDraftError;

/**
 * 抽出済み年間行事予定表テキストを AI で行事イベント配列に構造化する（保存しない）。
 * throw しない（すべて {@link CalendarImportDraftResult} に畳む）。
 */
export async function draftCalendarEventsFromText(
  rawText: unknown,
  opts: { acknowledgePii?: boolean },
  deps: CalendarImportDraftDeps,
): Promise<CalendarImportDraftResult> {
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (text.length > CALENDAR_IMPORT_INPUT_MAX) {
    return { ok: false, reason: "too_long" };
  }

  // ADR-030 PII soft-gate: 敬称連接の氏名らしきパターン検出 → 未 override は送信せず警告。
  const suspects = findSuspectedPersonalNames(text);
  if (suspects.length > 0 && opts.acknowledgePii !== true) {
    return {
      ok: false,
      reason: "pii_warning",
      suspectedSurfaces: Array.from(new Set(suspects.map((s) => s.surface))),
    };
  }

  // 書式 PII（電話/メール）をマスク。fail-closed: マスク後に残存があれば送らず中止（ルール4）。
  const { masked, dictionary } = maskPII(text, []);
  if (findUnmaskedPii(masked, []).length > 0) {
    return { ok: false, reason: "pii_leak" };
  }

  const window = fiscalYearWindow(deps.nowMs ?? Date.now());

  let events: CalendarImportEvent[];
  let malformed: number;
  try {
    const res = await deps.model.generate({
      system: buildCalendarImportSystem(window),
      user: buildCalendarImportUser(masked, window),
      maxOutputTokens: CALENDAR_IMPORT_MAX_OUTPUT_TOKENS,
    });
    const parsed = parseCalendarImportProposal(res.text);
    if (!parsed || parsed.events.length === 0) {
      return { ok: false, reason: "no_result" };
    }
    // 逆マスク**前**（マスク空間）で fail-closed 再検査（ルール4・#1105 と同型）。検出されるのは
    // 「モデルが生成した辞書に無い生 PII」（= 真のリーク）のみで、辞書由来の正規値は token のまま。
    for (const ev of parsed.events) {
      for (const field of [ev.summary, ev.location]) {
        if (field !== undefined && findUnmaskedPii(field, []).length > 0) {
          return { ok: false, reason: "pii_leak" };
        }
      }
    }
    // 逆マスクして元の表記に戻す（文字列フィールド = summary / location）。dedupe は復元後の表記で
    // 行うため、サニタイズより先に逆マスクする。
    events = parsed.events.map((ev) => ({
      ...ev,
      summary: unmaskPII(ev.summary, dictionary),
      ...(ev.location !== undefined ? { location: unmaskPII(ev.location, dictionary) } : {}),
    }));
    malformed = parsed.malformed;
  } catch {
    // モデル/通信障害。本文はログに出さない。
    return { ok: false, reason: "error" };
  }

  const sanitized = sanitizeImportedEvents(events, window);
  return {
    ok: true,
    events: sanitized.events,
    dropped: { ...sanitized.dropped, malformed },
    window,
    suspectedNameCount: suspects.length,
  };
}
