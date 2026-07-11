import type { DailySectionField } from "./daily-data-write";
import {
  type AssignmentItem,
  type NoticeItem,
  validateAssignmentItems,
  validateNoticeItems,
} from "./notice-assignment-core";
import { type ScheduleItem, validateScheduleItems } from "./schedule-core";

/**
 * AI ドラフトで生成できる daily_data セクション。書込コアの {@link DailySectionField}
 * (schedules / notices / assignments) と**単一ソース**（型を二重宣言しない、ルール3）。
 */
export type DraftSection = DailySectionField;

/**
 * 段C: エディタ AI アシスタント（連絡ドラフト）の **純ロジック**。`"use server"` ファイル
 * (assistant-actions.ts) は async export しか持てないため、型・プロンプト・JSON パースをここに分離する
 * (schedule-core / notice-assignment-core と同方針)。DB / Vertex 非依存でテスト可能。
 *
 * AI 下書きは「連絡(notices)」に加え「予定(schedules)」「提出物(assignments)」も対象にできる。
 * セクション共通の user プロンプト構築 ({@link buildSectionAssistUser}) と、セクションごとの system
 * プロンプト ({@link SECTION_ASSIST_SYSTEM}) / パーサ ({@link parseScheduleProposal} 等) をここに集約する。
 * いずれも AI 出力を既存の `validate*Items` に通して正規化する（要素型は schedule-core /
 * notice-assignment-core の単一ソースを再利用、ルール3）。
 */

/**
 * AI ドラフトの**失敗結果（全セクション共通）**。ok:false のバリアントをここに集約し、連絡/予定/提出物の
 * 各結果型 ({@link AssistDraftResult}/{@link ScheduleDraftResult}/{@link AssignmentDraftResult}) が
 * ok:true 部分だけ差し替えて再利用する（型の二重定義を避ける）。
 */
export type AssistDraftError =
  | {
      // ADR-030 PII soft-gate: 氏名らしき高確信パターン検出・未 override で送信保留。surfaces は警告表示用。
      ok: false;
      reason: "pii_warning";
      suspectedSurfaces: string[];
    }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "disabled" // AI_ENABLED OFF
        | "rate_limited"
        | "pii_leak" // マスク漏れ fail-closed 作動
        | "empty" // 入力空
        | "too_long" // 入力過大
        | "too_large" // ファイルサイズ上限超過
        | "unsupported_format" // 対応外ファイル形式（画像 OCR 未配線含む）
        | "no_text" // ファイルからテキストを抽出できなかった
        | "extract_failed" // ファイル解析失敗（破損/暗号化等）
        | "no_result" // モデル応答が空/不正
        | "error";
    };

/** AI 連絡(notices)ドラフトの結果（client が UI に写像）。本文/生PIIは ok 時の notices のみ。 */
export type AssistDraftResult = { ok: true; notices: NoticeItem[] } | AssistDraftError;

/** AI 予定(schedules・時間割)ドラフトの結果。 */
export type ScheduleDraftResult = { ok: true; schedules: ScheduleItem[] } | AssistDraftError;

/** AI 提出物(assignments・課題)ドラフトの結果。 */
export type AssignmentDraftResult = { ok: true; assignments: AssignmentItem[] } | AssistDraftError;

/**
 * 「おまかせ」分類ドラフトの中間表現（ADR-036）。1 入力を 3 セクションへ振り分けた束。各配列は既存
 * `validate*Items` を通った正規化済み（型単一ソース、ルール3）。該当が無い種類は空配列。
 */
export type AllDraft = {
  schedules: ScheduleItem[];
  notices: NoticeItem[];
  assignments: AssignmentItem[];
};

/** AI 「おまかせ」ドラフトの結果（3 セクション同時、ADR-036）。 */
export type AllDraftResult =
  | { ok: true; schedules: ScheduleItem[]; notices: NoticeItem[]; assignments: AssignmentItem[] }
  | AssistDraftError;

/** Gemini への system 指示（連絡ドラフト専用・個人名/日付の創作を禁止、JSON のみ）。 */
export const NOTICE_ASSIST_SYSTEM = [
  "あなたは日本の学校の掲示「連絡（お知らせ）」作成を補助するアシスタントです。",
  "入力された教員のメモ・発話を、サイネージ掲示用の短い『連絡』に整形します。",
  '出力は必ず次の JSON のみ: {"notices":[{"text":string,"isHighlight":boolean}]}',
  "- notices は 1〜5 件。各 text は1文・最大120文字程度の簡潔な日本語にする。",
  "- 重要な注意喚起のみ isHighlight:true、通常は false。",
  "- 「今日」「明日」「明後日」「昨日」「来週月曜」などの相対的な日付・曜日表現は、ユーザーが与える『基準日（今日）』を用いて具体的な日付（例: 6月8日（月））に変換して出力する。",
  "- 基準日から計算できない日付・入力に無い事実・個人名は創作しない。氏名や電話番号等の個人情報は出力に含めない。",
  "- マスクトークン（例 {{STAFF_001}}）が入力にあればそのまま保持する。",
  "JSON 以外の文字（説明文・コードフェンス）は一切出力しない。",
].join("\n");

/**
 * Gemini への system 指示（連絡ドラフト**ストリーミング版** / ADR-033）。
 *
 * 非ストリーミング版 {@link NOTICE_ASSIST_SYSTEM} と違い、出力の JSON エンベロープ（`{"notices":[...]}`）を
 * **指示しない**。ストリーミングは Vercel AI SDK `streamObject` の array mode を使い、出力構造（連絡の配列・
 * 各要素 `{text, isHighlight}`）は SDK がスキーマで強制するため、ここでは **連絡 1 件あたりの文言ルール**
 * だけを与える（構造の二重指示を避ける）。文言ルール自体は非ストリーミング版と同一思想。
 */
export const NOTICE_ASSIST_STREAM_SYSTEM = [
  "あなたは日本の学校の掲示「連絡（お知らせ）」作成を補助するアシスタントです。",
  "入力された教員のメモ・発話を、サイネージ掲示用の短い『連絡』の配列に整形します。",
  "各連絡（配列の各要素）の作り方:",
  "- text は1文・最大120文字程度の簡潔な日本語にする。連絡は 1〜5 件。",
  "- 重要な注意喚起のみ isHighlight を true、通常は false。",
  "- 「今日」「明日」「明後日」「昨日」「来週月曜」などの相対的な日付・曜日表現は、ユーザーが与える『基準日（今日）』を用いて具体的な日付（例: 6月8日（月））に変換して出力する。",
  "- 基準日から計算できない日付・入力に無い事実・個人名は創作しない。氏名や電話番号等の個人情報は出力に含めない。",
  "- マスクトークン（例 {{STAFF_001}}）が入力にあればそのまま保持する。",
].join("\n");

/**
 * Gemini への system 指示（**予定(時間割)** ドラフト専用）。出力は `{"schedules":[...]}` の JSON のみ。
 * 時限(period)に乗らない事項（朝の会/HR/昼休み/放課後/部活）は予定に入れさせない（連絡で扱う内容ゆえ、
 * period の番号を創作させない）。最終的に `validateScheduleItems` が period 1..12・重複なしを強制する。
 */
export const SCHEDULE_ASSIST_SYSTEM = [
  "あなたは日本の学校の「予定（時間割・その日の時程）」作成を補助するアシスタントです。",
  "入力された教員のメモ・発話を、サイネージ掲示用の『予定』に整形します。",
  '出力は必ず次の JSON のみ: {"schedules":[{"period":number,"subject":string,"note":string,"location":string,"targetAudience":string}]}',
  "- period は時限を表す 1〜12 の整数。「1限」「1時間目」「1コマ目」などは period に正規化する。",
  "- 朝の会・ホームルーム・昼休み・放課後・部活など、時限(コマ)に対応しない事項は schedules に入れない（番号を創作しない。それらは『連絡』で扱う内容）。",
  "- 時限が判別できないコマは作らない。同じ period を 2 つ以上作らない。",
  "- subject は科目・内容の短い名前。note(補足)・location(場所)・targetAudience(対象者)は入力に明示がある場合のみ入れ、無ければ省略する（空文字や創作をしない）。",
  "- 入力に無い事実・科目・時限・個人名は創作しない。氏名や電話番号等の個人情報は出力に含めない。",
  "- マスクトークン（例 {{STAFF_001}}）が入力にあればそのまま保持する。",
  "JSON 以外の文字（説明文・コードフェンス）は一切出力しない。",
].join("\n");

/**
 * Gemini への system 指示（**提出物(課題)** ドラフト専用）。出力は `{"assignments":[...]}` の JSON のみ。
 * deadline は基準日(今日)を用いて相対表現を実在日付に変換させ、確定できないものは作らせない。最終的に
 * `validateAssignmentItems`（`isValidDate` 含む）が実在日付・各フィールド長を強制する。
 */
export const ASSIGNMENT_ASSIST_SYSTEM = [
  "あなたは日本の学校の「提出物（課題）」作成を補助するアシスタントです。",
  "入力された教員のメモ・発話を、サイネージ掲示用の『提出物』に整形します。",
  '出力は必ず次の JSON のみ: {"assignments":[{"deadline":"YYYY-MM-DD","subject":string,"task":string}]}',
  "- deadline は提出期限。「明日まで」「今週金曜」「6月20日」などの相対・省略表現は、ユーザーが与える『基準日（今日）』を用いて実在する YYYY-MM-DD に変換する。",
  "- 基準日から具体的な日付を確定できない提出物は作らない（締切を創作しない）。",
  "- subject は科目名、task は提出物の内容を簡潔に書く。",
  "- 入力に無い事実・科目・締切・個人名は創作しない。氏名や電話番号等の個人情報は出力に含めない。",
  "- マスクトークン（例 {{STAFF_001}}）が入力にあればそのまま保持する。",
  "JSON 以外の文字（説明文・コードフェンス）は一切出力しない。",
].join("\n");

/**
 * セクション → 非ストリーミング system プロンプトの対応表。`runSectionDraft`（assistant-actions）が
 * セクションに応じて system を選ぶための単一ソース。連絡はストリーミング版 system を別に持つ
 * ({@link NOTICE_ASSIST_STREAM_SYSTEM})。
 */
export const SECTION_ASSIST_SYSTEM: Record<DraftSection, string> = {
  schedules: SCHEDULE_ASSIST_SYSTEM,
  notices: NOTICE_ASSIST_SYSTEM,
  assignments: ASSIGNMENT_ASSIST_SYSTEM,
};

/**
 * Gemini への system 指示（**おまかせ＝3 セクション分類**、ADR-036）。1 入力を予定/連絡/提出物に振り分けて
 * 1 つの JSON で返させる。period が判別できない事項・締切を確定できない課題は予定/提出物に入れさせず連絡へ
 * 寄せる（捏造防止）。最終検証は各 `validate*Items`（period 1..12・重複, deadline 実在日付）が強制する。
 */
export const ALL_ASSIST_SYSTEM = [
  "あなたは日本の学校の掲示作成を補助するアシスタントです。",
  "入力された教員のメモ・発話を読み、各項目を『予定（時間割）』『連絡（お知らせ）』『提出物（課題）』の3種類に振り分けて整形します。",
  '出力は必ず次の JSON のみ: {"schedules":[{"period":number,"subject":string,"note":string,"location":string,"targetAudience":string}],"notices":[{"text":string,"isHighlight":boolean}],"assignments":[{"deadline":"YYYY-MM-DD","subject":string,"task":string}]}',
  "振り分けの基準:",
  "- 予定(schedules): 時限(1〜12)に対応する授業・コマ。「1限数学」など period が判別できるものだけ。朝の会/HR/集会/放課後など時限に乗らないものは予定に入れず連絡にする（period を創作しない）。同じ period を2つ以上作らない。",
  "- 提出物(assignments): 締切のある課題。『基準日（今日）』を用いて「明日まで/今週金曜」を実在する YYYY-MM-DD に変換する。締切を確定できないものは作らない。",
  "- 連絡(notices): 上記以外のお知らせ全般。各 text は1文・最大120文字程度。重要な注意喚起のみ isHighlight:true。",
  "- どの種類か迷うもの・必須項目(時限/締切)が欠けるものは連絡に寄せる。該当が無い種類は空配列にする。",
  "共通: 「今日」「明日」等の相対日付は基準日で具体化。入力に無い事実・個人名・確定できない日付/時限は創作しない。氏名や電話番号等の個人情報は出力に含めない。マスクトークン（例 {{STAFF_001}}）は保持する。",
  "JSON 以外の文字（説明文・コードフェンス）は一切出力しない。",
].join("\n");

/** セクション → user プロンプトで使う和名（「次のメモから〇〇を作成してください」）。 */
const SECTION_NOUN: Record<DraftSection, string> = {
  schedules: "予定",
  notices: "連絡",
  assignments: "提出物",
};

/**
 * トーン/長さ調整プリセット（ADR-033 / 設計 §2.4）。再生成時に user プロンプトへ調整指示を付す。
 * 日本語の敬語は独立軸として一級扱い（ていねいに/かしこまった）。**値はすべてサーバ定義の固定文**で、
 * ユーザー自由入力を含まない（＝新たな PII 面を作らない、ルール4）。
 */
export type NoticeTone =
  | "short"
  | "detailed"
  | "polite"
  | "soft"
  | "concise"
  | "formal"
  | "rephrase"
  | "bullet"
  | "plain";

/** トーンキー → モデルへの調整指示文（固定）。 */
export const NOTICE_TONE_INSTRUCTIONS: Record<NoticeTone, string> = {
  short: "各連絡をできるだけ短く、要点だけにする。",
  detailed: "各連絡に必要な補足を加えて、ややくわしくする。",
  polite: "ていねいな敬体（です・ます）でやわらげる。",
  soft: "保護者にも伝わるよう、やわらかく温かい言い回しにする。",
  concise: "事実を落とさずに簡潔に締める。",
  formal: "かしこまった丁寧な表現にする。",
  rephrase: "意味を保ったまま言い換える。",
  bullet: "各連絡を1文で端的にする（箇条書き的に）。",
  plain: "やさしい日本語（簡単な語・短い文）にする。",
};

const NOTICE_TONES: readonly NoticeTone[] = [
  "short",
  "detailed",
  "polite",
  "soft",
  "concise",
  "formal",
  "rephrase",
  "bullet",
  "plain",
];

/** 任意入力が既知のトーンキーなら返す（未知は null。外部入力を信用しない）。 */
export function parseNoticeTone(value: unknown): NoticeTone | null {
  return NOTICE_TONES.find((t) => t === value) ?? null;
}

/**
 * ユーザープロンプト（基準日 + マスク済みメモ + 任意の調整指示）。基準日（今日・JST）を明示して渡し、
 * 「明日」等の相対表現をモデルが具体的な日付へ変換できるようにする（予定/連絡/提出物すべてで必要）。
 * `section` で「次のメモから〇〇を作成してください」の和名だけが変わり、構造は全セクション共通。
 * `adjust` は再生成時のトーン/長さ調整文（{@link NOTICE_TONE_INSTRUCTIONS} の固定文）で、無ければ付さない。
 */
export function buildSectionAssistUser(
  section: DraftSection,
  maskedInput: string,
  referenceDateLabel: string,
  adjust?: string,
): string {
  const base = `基準日（今日）: ${referenceDateLabel}\n\n次のメモから${SECTION_NOUN[section]}を作成してください:\n\n${maskedInput}`;
  return adjust && adjust.length > 0 ? `${base}\n\n【調整の指示】${adjust}` : base;
}

/**
 * 連絡(notices)用 user プロンプト。{@link buildSectionAssistUser} の後方互換ラッパ（既存呼出 =
 * assistant-actions / notice-draft-sse が依存。出力は従来と同一）。
 */
export function buildNoticeAssistUser(
  maskedInput: string,
  referenceDateLabel: string,
  adjust?: string,
): string {
  return buildSectionAssistUser("notices", maskedInput, referenceDateLabel, adjust);
}

/**
 * 自由指示（加筆・部分修正）の最大長（rate/コスト保護）。短い指示文を想定する。
 * 自由指示は短いディレクティブゆえ書式 PII（電話/メール）の混入を**許さず**（含むと pii_leak）、
 * 氏名らしき語は soft-gate 対象にする（マスク往復は memo のみ、ルール4）。
 */
export const NOTICE_INSTRUCTION_MAX = 200;

/**
 * epoch ミリ秒を JST の「YYYY年M月D日（曜）」表記にする（相対日付解決の基準日ラベル）。
 * 引数を取るので決定的（`deps.nowMs` 基準でテスト可能）。`new Date(epochMs)` は引数あり＝許容。
 */
export function jstDateLabel(epochMs: number): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(new Date(epochMs));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}年${get("month")}月${get("day")}日（${get("weekday")}）`;
}

/**
 * 基準日から `days` 日分の **実在日付↔曜日の対応表**（例 `2026-07-06(月・今日) / 2026-07-07(火・明日) / …`）。
 * 会話型 AI の system プロンプトに注入し、「来週水曜」等の相対表現をモデルの曜日計算に任せず表引きで
 * 解決させる（2026-07-05 eval: 曜日算術ミス「来週の水曜→07-16(木)」を確認・決定的な根治）。
 * JST は DST が無いため 86,400,000ms 加算で日を進めてよい。決定的（epochMs 基準・テスト可能）。
 */
export function jstUpcomingDateTable(epochMs: number, days = 14): string {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const out: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const parts = fmt.formatToParts(new Date(epochMs + i * 86_400_000));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
    const rel = i === 0 ? "・今日" : i === 1 ? "・明日" : i === 2 ? "・明後日" : "";
    out.push(`${get("year")}-${get("month")}-${get("day")}(${get("weekday")}${rel})`);
  }
  return out.join(" / ");
}

/** 入力長の上限（過大入力を弾く・rate/コスト保護）。 */
export const ASSIST_INPUT_MAX = 4000;

/** モデルの生 JSON テキストから NoticeItem[] を取り出す（パース失敗・形不正は null）。 */
export function parseNoticeProposal(text: string): NoticeItem[] | null {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  const notices = (json as { notices?: unknown } | null)?.notices;
  const v = validateNoticeItems(notices);
  return v.ok ? v.value : null;
}

/**
 * モデルの生 JSON テキストから ScheduleItem[] を取り出す（パース失敗・形不正は null）。
 * `validateScheduleItems` を通すので period 1..12・重複なし・各長が最終強制される（連絡と同方針）。
 */
export function parseScheduleProposal(text: string): ScheduleItem[] | null {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  const schedules = (json as { schedules?: unknown } | null)?.schedules;
  const v = validateScheduleItems(schedules);
  return v.ok ? v.value : null;
}

/**
 * モデルの生 JSON テキストから AssignmentItem[] を取り出す（パース失敗・形不正は null）。
 * `validateAssignmentItems` を通すので deadline は実在日付(`isValidDate`)・各長が最終強制される。
 */
export function parseAssignmentProposal(text: string): AssignmentItem[] | null {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  const assignments = (json as { assignments?: unknown } | null)?.assignments;
  const v = validateAssignmentItems(assignments);
  return v.ok ? v.value : null;
}

/**
 * 「おまかせ」用 user プロンプト（基準日 + マスク済みメモ）。トーン調整軸は持たない（分類は構造抽出）。
 */
export function buildAllAssistUser(maskedInput: string, referenceDateLabel: string): string {
  return `基準日（今日）: ${referenceDateLabel}\n\n次のメモを、予定・連絡・提出物に振り分けて作成してください:\n\n${maskedInput}`;
}

/**
 * モデルの生 JSON から {@link AllDraft}（3 セクション束）を取り出す（ADR-036）。各セクションは「キーが
 * あれば `validate*Items` で検証、無ければ空」。**あって不正なら全体を null（黙ってドロップしない）**。
 * 3 種すべて空なら null（呼び出し側が no_result 判定）。
 */
export function parseAllProposal(text: string): AllDraft | null {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) {
    return null;
  }
  const obj = json as { schedules?: unknown; notices?: unknown; assignments?: unknown };
  const sV = obj.schedules === undefined ? null : validateScheduleItems(obj.schedules);
  const nV = obj.notices === undefined ? null : validateNoticeItems(obj.notices);
  const aV = obj.assignments === undefined ? null : validateAssignmentItems(obj.assignments);
  if ((sV && !sV.ok) || (nV && !nV.ok) || (aV && !aV.ok)) {
    return null;
  }
  const schedules = sV?.ok ? sV.value : [];
  const notices = nV?.ok ? nV.value : [];
  const assignments = aV?.ok ? aV.value : [];
  if (schedules.length === 0 && notices.length === 0 && assignments.length === 0) {
    return null;
  }
  return { schedules, notices, assignments };
}

/** モデルが稀に付ける ```json ... ``` コードフェンスを剥がす（calendar-import-core からも再利用）。 */
export function stripCodeFence(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m?.[1] ?? t;
}
