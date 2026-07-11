import { z } from "zod";
import { stripCodeFence } from "./assistant-core";
import { isValidDate } from "./schedule-core";

/**
 * 年間行事予定表ファイル取込（ADR-049 PR-B）の **純コア**。DB / Vertex 非依存で全て単体テスト可能
 * （assistant-core / schedule-core と同方針）。ファイル抽出テキスト → AI 構造化の「型・年度窓・
 * プロンプト・パース・サニタイズ」をここに集約し、モデル呼び出しは calendar-import-draft.ts、
 * Server Action / 保存（`school_calendar_events` への `file:` 名前空間書き込み）は PR-C が担う。
 *
 * 年度文脈（ADR-049 決定3）: 年間表の「4/8」等は年が省略されるため、{@link fiscalYearWindow} の
 * 年度窓（4/1〜翌 3/31）と年推定規則（4〜12 月→年度年・1〜3 月→翌年）をプロンプトに明示注入する。
 * 365 行の日付表は注入しない（曜日は行事構造化に不要・トークン浪費）。モデル出力は
 * {@link sanitizeImportedEvents} が実在暦日・年度窓・重複・上限を機械強制し、**切り捨ては必ず件数で
 * 返す**（沈黙の切り捨て禁止・ADR-049 決定3）。
 */

/**
 * 1 回のファイル取込で受け入れる行事イベント数の上限。ADR-045 の iCal 取込上限
 * `MAX_EVENTS_PER_SOURCE`（apps/jobs/src/weather/run.ts）と同水準（年間行事表は通常 数百件）。
 */
export const MAX_FILE_IMPORT_EVENTS = 2000;

/** 行事名の最大長（サイネージ/エディタ表示前提の短文。超過行はスキーマ防御で malformed 扱い）。 */
export const CALENDAR_EVENT_SUMMARY_MAX = 200;

/** 場所の最大長（schedule-core の LOCATION_MAX=50 より広め: 行事は「◯◯市民会館 大ホール」等がある）。 */
export const CALENDAR_EVENT_LOCATION_MAX = 100;

/** 年度（4/1〜翌 3/31）の窓。日付は JST の暦日を YYYY-MM-DD で持つ（文字列比較で順序が決まる）。 */
export interface FiscalYearWindow {
  /** 年度（例 2026 = 2026-04-01〜2027-03-31）。 */
  fiscalYear: number;
  /** 年度開始日（YYYY-04-01）。 */
  start: string;
  /** 年度末日（YYYY+1-03-31）。 */
  end: string;
}

/**
 * 基準時刻（epoch ms）が属する **JST の年度窓** を返す（4/1 開始・翌 3/31 終わり）。
 * 1〜3 月は前年が年度年（例 2027-01-15 → 年度 2026）。引数を取るので決定的（`nowMs` でテスト可能・
 * `jstDateLabel` と同作法）。
 */
export function fiscalYearWindow(epochMs: number): FiscalYearWindow {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date(epochMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? Number.NaN);
  const year = get("year");
  const month = get("month");
  const fiscalYear = month >= 4 ? year : year - 1;
  return { fiscalYear, start: `${fiscalYear}-04-01`, end: `${fiscalYear + 1}-03-31` };
}

const DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 空文字/空白のみの任意フィールドを「省略」に正規化する（モデルが "" を出しても行ごと落とさない）。 */
const emptyToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim().length === 0 ? undefined : v;

/**
 * AI 構造化出力の行事イベント 1 件のスキーマ（ADR-049 決定3）。**構造と長さのみ**を防御し、
 * 実在暦日・年度窓・重複・上限は {@link sanitizeImportedEvents} が担う（YYYY-MM-DD の形だけ
 * ここで強制し、"2026-02-30" のような非実在日はサニタイズ側で件数付き drop にする）。
 */
export const calendarImportEventSchema = z.object({
  /** 行事名（例 体育祭・中間考査）。 */
  summary: z.string().trim().min(1).max(CALENDAR_EVENT_SUMMARY_MAX),
  /** 開始日（YYYY-MM-DD）。 */
  startDate: z.string().regex(DATE_SHAPE_RE),
  /** 終了日（複数日行事のみ・単日は省略）。 */
  endDate: z.preprocess(emptyToUndefined, z.string().regex(DATE_SHAPE_RE).optional()),
  /** 終日行事か（年間表は時刻を持たないことが多いため既定 true）。 */
  allDay: z.boolean().default(true),
  /** 場所（入力に明示がある場合のみ）。 */
  location: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).max(CALENDAR_EVENT_LOCATION_MAX).optional(),
  ),
});

/** 取込行事イベント（スキーマから導出・手書き再定義しない、ルール3）。 */
export type CalendarImportEvent = z.infer<typeof calendarImportEventSchema>;

/** モデル生 JSON のパース結果。malformed = スキーマ不適合で drop した行数（沈黙で捨てない）。 */
export interface CalendarImportParseResult {
  events: CalendarImportEvent[];
  malformed: number;
}

/**
 * モデルの生 JSON テキストから行事イベント配列を取り出す。エンベロープ（`{"events":[...]}`）が
 * 壊れていれば null（呼び出し側が no_result 判定）。**行単位**では lenient に扱い、スキーマ不適合の
 * 行だけを malformed として件数付きで drop する（年間数百行のうち 1 行の不良で全体を失敗させない）。
 */
export function parseCalendarImportProposal(text: string): CalendarImportParseResult | null {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) {
    return null;
  }
  const rows = (json as { events?: unknown }).events;
  if (!Array.isArray(rows)) {
    return null;
  }
  const events: CalendarImportEvent[] = [];
  let malformed = 0;
  for (const row of rows) {
    const v = calendarImportEventSchema.safeParse(row);
    if (v.success) {
      events.push(v.data);
    } else {
      malformed += 1;
    }
  }
  return { events, malformed };
}

/** サニタイズで drop した理由別の件数（監査可能な形・沈黙の切り捨て禁止）。 */
export interface CalendarImportSanitizeDropped {
  /** startDate が実在暦日でない（例 2026-02-30）。 */
  invalidDate: number;
  /** startDate が年度窓（4/1〜翌 3/31）の外。 */
  outOfWindow: number;
  /** 同一 (summary, startDate) の後勝ち分（先勝ち dedupe）。 */
  duplicates: number;
  /** {@link MAX_FILE_IMPORT_EVENTS} 超過分のクランプ。 */
  overCap: number;
  /** endDate のみ不正（非実在/開始日より前/年度窓超過）で endDate を落とし単日化した行数（行は残る）。 */
  endDateStripped: number;
}

/**
 * スキーマ通過済みイベントを機械強制でサニタイズする（ADR-049 決定3）:
 * 1. startDate が実在暦日でない行を drop（invalidDate）
 * 2. startDate が年度窓外の行を drop（outOfWindow）
 * 3. endDate が非実在 / `endDate < startDate` / 年度窓超過なら **endDate だけ** 落として単日行事として
 *    残す（endDateStripped。行ごと失わない）
 * 4. 同一 (summary, startDate) は先勝ちで dedupe（duplicates）
 * 5. {@link MAX_FILE_IMPORT_EVENTS} でクランプ（overCap）
 * すべての drop は理由別件数で返す（呼び出し側が UI/監査に明示できる）。
 */
export function sanitizeImportedEvents(
  events: readonly CalendarImportEvent[],
  window: FiscalYearWindow,
): { events: CalendarImportEvent[]; dropped: CalendarImportSanitizeDropped } {
  const kept: CalendarImportEvent[] = [];
  const seen = new Set<string>();
  const dropped: CalendarImportSanitizeDropped = {
    invalidDate: 0,
    outOfWindow: 0,
    duplicates: 0,
    overCap: 0,
    endDateStripped: 0,
  };
  for (const ev of events) {
    if (!isValidDate(ev.startDate)) {
      dropped.invalidDate += 1;
      continue;
    }
    // YYYY-MM-DD はゼロ埋め固定長ゆえ文字列比較 = 日付順序（weekly-timetable-core 等と同作法）。
    if (ev.startDate < window.start || ev.startDate > window.end) {
      dropped.outOfWindow += 1;
      continue;
    }
    // (summary, startDate) の先勝ち dedupe。区切りの \u0000 は summary（Zod 通過済み文字列）に実質現れない。
    const key = `${ev.startDate}\u0000${ev.summary}`;
    if (seen.has(key)) {
      dropped.duplicates += 1;
      continue;
    }
    seen.add(key);
    let endDate = ev.endDate;
    if (
      endDate !== undefined &&
      (!isValidDate(endDate) || endDate < ev.startDate || endDate > window.end)
    ) {
      endDate = undefined;
      dropped.endDateStripped += 1;
    }
    kept.push({ ...ev, endDate });
  }
  dropped.overCap = Math.max(0, kept.length - MAX_FILE_IMPORT_EVENTS);
  return { events: kept.slice(0, MAX_FILE_IMPORT_EVENTS), dropped };
}

/**
 * Gemini への system 指示（年間行事取込・ADR-049 決定3）。年度窓と年推定規則（月日のみ→4〜12 月は
 * 年度年・1〜3 月は翌年）を明示注入し、モデルに暦算術をさせない（`jstUpcomingDateTable` の年度版思想。
 * ただし曜日は行事構造化に不要なので 365 行の日付表は注入しない）。学校公開行事のみ・個人名禁止・
 * 読み取れない行は捨てる、を明記（ADR-049 残存リスク②）。
 */
export function buildCalendarImportSystem(window: FiscalYearWindow): string {
  return [
    "あなたは日本の学校の「年間行事予定表」から行事イベントを抽出するアシスタントです。",
    "入力されたテキスト（Excel/CSV/PDF/画像から抽出済み・学校ごとに書式はバラバラ）から行事を構造化します。",
    '出力は必ず次の JSON のみ: {"events":[{"summary":string,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","allDay":boolean,"location":string}]}',
    `- 対象は年度 ${window.fiscalYear}（${window.start}〜${window.end}）の行事のみ。`,
    `- 「4/8」「10月3日」のように年が書かれていない日付は、4〜12月は ${window.fiscalYear} 年、1〜3月は ${window.fiscalYear + 1} 年として YYYY-MM-DD に補完する。`,
    `- summary は行事名を簡潔に（最大${CALENDAR_EVENT_SUMMARY_MAX}文字。例: 体育祭、中間考査、終業式）。`,
    "- endDate は複数日にまたがる行事のみ入れ、単日の行事では省略する。location は入力に明示がある場合のみ入れる（創作しない）。",
    "- allDay は終日行事なら true。時刻が読み取れない場合も true とする。",
    "- 学校の公開行事（式典・考査・学校行事・休業日など）だけを対象にする。担当者名・個人名・電話番号などの個人情報は出力に含めない。",
    "- 日付や行事名が読み取れない行・行事でない行（凡例・注記など）は出力に含めない（推測で創作しない）。",
    "- マスクトークン（例 {{STAFF_001}}）が入力にあればそのまま保持する。",
    "JSON 以外の文字（説明文・コードフェンス）は一切出力しない。",
  ].join("\n");
}

/** ユーザープロンプト（対象年度 + マスク済み抽出テキスト）。 */
export function buildCalendarImportUser(maskedInput: string, window: FiscalYearWindow): string {
  return `対象年度: ${window.fiscalYear}年度（${window.start}〜${window.end}）\n\n次の年間行事予定表テキストから行事イベントを抽出してください:\n\n${maskedInput}`;
}
