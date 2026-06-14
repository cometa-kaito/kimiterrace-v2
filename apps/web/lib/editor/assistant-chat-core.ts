import {
  type AssignmentItem,
  type NoticeItem,
  validateAssignmentItems,
  validateNoticeItems,
} from "./notice-assignment-core";
import { type ScheduleItem, validateScheduleItems } from "./schedule-core";

/**
 * 会話型 AI アシスタント（学校エディタ・finding 2b 作り直し）の **API 契約 + 共有型**。
 *
 * このモジュールは AI レーンの「契約（UIへ）」の正本。`"use server"` でも DB/Vertex 依存でもない
 * **純ロジック/型**に保ち（assistant-core / schedule-core と同方針）、UI shell（チャット・コンポーザ・
 * 下書きカード・盤面プレビュー）と SSE バックエンド（assistant-chat-sse.ts / route）が **同じ型**で会話する。
 *
 * ## 既存「おまかせ」(ADR-036) との違い
 * ADR-036 の `assistDraftAllAction` は **1 入力→1 応答**（フォーム型・単発分類）。本契約は **多ターン会話**:
 * - 教員の発話/入力を `messages`（履歴）として送り、AI は **スレッド内の応答（prose）** と
 *   **構造化下書き（編集可能カード）** を SSE で同時に返す。
 * - 「2限を英語に」のような **自然言語修正** は、現在の下書き（`draft`）を文脈に乗せることで成立する
 *   （AI は現下書き + 指示 → 更新後の下書きを返す）。
 *
 * ## パターン準拠（finding①）と ADR-034 の不変条件（型で担保）
 * 会話型 AI が **生成できるセクション** = `schedules | notices | assignments`（= daily_data の
 * 編集可能セクション {@link "./daily-data-write".DailySectionField} と単一ソース、ルール3）。
 * **来校者(class_visitors) / 呼び出し(student_callouts) は本下書き型に含めない**: ADR-034 決定3/5 が
 * 「氏名は Vertex に送らない・AI 自動生成しない（職員が手入力）」を定めるため、会話型 AI の round-trip
 * 対象から **構造的に除外**する（型に存在しない＝LLM 経路に氏名が乗らない）。pattern2 では許可セクションを
 * `[schedules]` に絞り（連絡/提出物は盤面に出ないため提案しない）、来校者/呼び出しは UI の手入力フォームへ
 * 誘導する（AI は「下に手入力で追加してください」と促すのみ）。※将来 ADR-034 を改訂する場合のみ本型を拡張。
 *
 * ## SSE フレーム契約（server → UI）
 * 1 ターンの応答は `text/event-stream` で次を送出する（拒否の返し方は notice-draft-sse と同思想）:
 * - `meta`    : ターン開始時に 1 回。`{pattern, allowedSections}`（UI がパターン文脈を把握）。
 * - `message` : AI の会話応答（prose）の差分。`{delta}` を逐次。
 * - `draft`   : 構造化下書きの**現在スナップショット**（許可セクションのみ）。`AssistantDraft`。
 * - `error`   : リクエスト/ストリーム拒否。`{status, reason, suspectedSurfaces?, message?}`。
 * - `done`    : 確定スナップショット。`{draft}`。監査は handler が件数のみ記録（本文は残さない）。
 *
 * AI 無効(503)・不正ボディ(400/401/403) は **200 SSE を開く前**に実 HTTP(JSON) で返す。soft-gate
 * (pii_warning) / rate-limit / pii_leak / 生成失敗は **200 開始後の SSE `error` フレーム**で返す
 * （UI は入力・完成カードを失わない）。
 */

/**
 * 会話型 AI が下書きできるセクション種別。daily_data の編集可能セクション
 * ({@link "./daily-data-write".DailySectionField}) と同一（ルール3）。来校者/呼び出しは ADR-034 により
 * 含めない（上記モジュール doc 参照）。
 */
export const DRAFT_SECTION_KINDS = ["schedules", "notices", "assignments"] as const;
export type DraftSectionKind = (typeof DRAFT_SECTION_KINDS)[number];

/**
 * 構造化された **パターン準拠の作業下書き**。要素型は schedule-core / notice-assignment-core の
 * 検証済み単一ソースを再利用する（ルール3）。許可外セクションは常に空配列（{@link filterDraftToSections}）。
 */
export type AssistantDraft = {
  schedules: ScheduleItem[];
  notices: NoticeItem[];
  assignments: AssignmentItem[];
};

/** 空の下書き（初期状態・フォールバック）。 */
export const EMPTY_DRAFT: AssistantDraft = { schedules: [], notices: [], assignments: [] };

/** 会話の 1 ターン。`assistant` は過去の AI 応答（prose）、`user` は教員の発話/入力。 */
export type ChatRole = "user" | "assistant";
export type ChatTurn = { role: ChatRole; content: string };

/** 文脈に保持する会話ターン数の上限（コスト/プロンプト長保護。超過は本関数が直近 N 件に切り詰める）。 */
export const MAX_CHAT_TURNS = 24;

/** 1 ターンの本文長の上限（assistant-core の {@link "./assistant-core".ASSIST_INPUT_MAX} と揃える）。 */
export const CHAT_MESSAGE_MAX = 4000;

/**
 * 会話型 AI チャットのリクエストボディ。編集対象（scope/targetId）は **クエリ**で渡す
 * （notice-draft route と同方針・ボディ二重読み取り回避）。許可セクションは **サーバが学校/端末の実効
 * パターンから解決**するため **リクエストに含めない**（confused-deputy 防止・クライアントを信用しない）。
 */
export type AssistantChatRequestBody = {
  /** 会話履歴（最新の user ターンを末尾に含む）。最後のターンは `user` であること。 */
  messages: ChatTurn[];
  /** 現在の作業下書き（自然言語修正の文脈。省略時は空下書きから生成）。 */
  draft?: AssistantDraft;
  /** ADR-030 PII soft-gate の override（氏名らしき語の警告を承知の上で送信）。 */
  acknowledgePii?: boolean;
};

/** SSE イベント名の単一ソース（client/handler が同じ文字列を使う）。 */
export const ASSISTANT_CHAT_EVENTS = {
  meta: "meta",
  message: "message",
  draft: "draft",
  error: "error",
  done: "done",
} as const;
export type AssistantChatEvent = (typeof ASSISTANT_CHAT_EVENTS)[keyof typeof ASSISTANT_CHAT_EVENTS];

/** `meta` フレーム: ターン開始時に 1 回。UI がパターン文脈/許可セクションを把握する。 */
export type AssistantChatMetaFrame = {
  /** 実効サイネージパターン（例 "pattern1" / "pattern2"）。 */
  pattern: string;
  /** このクラスで会話型 AI が下書きできるセクション（パターン準拠）。 */
  allowedSections: DraftSectionKind[];
};

/** `message` フレーム: AI 会話応答（prose）の差分（逐次）。 */
export type AssistantChatMessageFrame = { delta: string };

/** `draft` フレーム: 構造化下書きの現在スナップショット（許可セクションのみ）。 */
export type AssistantChatDraftFrame = AssistantDraft;

/** 会話型 AI チャットの拒否理由（UI が文言に写像）。notice-draft-sse の理由集合に揃える。 */
export type AssistantChatErrorReason =
  | "pii_warning" // ADR-030 soft-gate（未 override で氏名らしき語を検出）
  | "rate_limited"
  | "pii_leak" // マスク漏れ fail-closed
  | "no_result" // モデル応答が空/不正
  | "stream_failed" // モデル/通信障害
  | "invalid" // ボディ不正（messages 欠落等）
  | "empty" // 入力空
  | "too_long"; // 入力過大

/** `error` フレーム: リクエスト/ストリーム拒否。 */
export type AssistantChatErrorFrame = {
  status: number;
  reason: AssistantChatErrorReason;
  /** pii_warning 時のみ: 氏名らしき表層（警告表示用）。 */
  suspectedSurfaces?: string[];
  /** 任意の表示用メッセージ（本文/生 PII は含めない）。 */
  message?: string;
};

/** `done` フレーム: 確定した下書きスナップショット。 */
export type AssistantChatDoneFrame = { draft: AssistantDraft };

/**
 * 任意入力（リクエストボディ）を {@link ChatTurn}[] に正規化・検証する。
 * - 配列であること・各要素が `{role,content}` で role が user|assistant・content が 1..{@link CHAT_MESSAGE_MAX}。
 * - **末尾は user ターン**（その直前までが文脈、末尾がこのターンの指示）。
 * - 件数は直近 {@link MAX_CHAT_TURNS} 件に制限（古いターンを落とす・コスト保護）。
 * いずれか不正なら `null`（呼び出し側が 400 invalid）。空配列も `null`。
 *
 * 注: 切り詰めの結果、**ウィンドウ先頭が `assistant` ターンになりうる**（直前の user が窓外へ落ちた孤立応答）。
 * Gemini など「履歴は user で始まる」を要求するプロバイダ向けに、先頭が孤立 assistant なら SSE handler
 * (PR③) が落として整形する責務（本層は契約の正規化のみ・プロバイダ形は handler が持つ）。
 */
export function parseChatTurns(raw: unknown): ChatTurn[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const turns: ChatTurn[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const rec = entry as Record<string, unknown>;
    const role = rec.role;
    if (role !== "user" && role !== "assistant") {
      return null;
    }
    if (typeof rec.content !== "string") {
      return null;
    }
    const content = rec.content.trim();
    if (content.length === 0 || content.length > CHAT_MESSAGE_MAX) {
      return null;
    }
    turns.push({ role, content });
  }
  // 末尾は必ず user（このターンの指示）。assistant で終わる履歴は不正。
  if (turns[turns.length - 1]?.role !== "user") {
    return null;
  }
  // 直近 MAX_CHAT_TURNS 件に制限（先頭を落とす）。末尾の user は必ず残る。
  return turns.length > MAX_CHAT_TURNS ? turns.slice(turns.length - MAX_CHAT_TURNS) : turns;
}

/** 末尾の user ターン本文（このターンの指示）。無ければ null。 */
export function latestUserMessage(turns: readonly ChatTurn[]): string | null {
  const last = turns[turns.length - 1];
  return last?.role === "user" ? last.content : null;
}

/**
 * 任意入力（リクエストの現下書き or モデル出力）を {@link AssistantDraft} に **防御的に**正規化する。
 * 各セクションを既存 `validate*Items` に独立して通し、**不正/欠落セクションは空配列**に倒す（fail-soft。
 * 1 フィールドの不整合で下書き全体を失わせない）。要素は検証済み単一ソース型（ルール3）。
 */
export function sanitizeDraft(raw: unknown): AssistantDraft {
  const obj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const s = validateScheduleItems(obj.schedules);
  const n = validateNoticeItems(obj.notices);
  const a = validateAssignmentItems(obj.assignments);
  return {
    schedules: s.ok ? s.value : [],
    notices: n.ok ? n.value : [],
    assignments: a.ok ? a.value : [],
  };
}

/**
 * 下書きを **許可セクションだけ**に絞る（パターン準拠の防御層、finding①）。許可外セクションは空配列にする。
 * AI 出力が誤って許可外セクション（例 pattern2 での notices）を含めても、ここで盤面に出ないものを落とす
 * （プロンプト誘導 + 本フィルタの二段で「パターンに出ないものを提案しない」を担保）。
 */
export function filterDraftToSections(
  draft: AssistantDraft,
  allowed: readonly DraftSectionKind[],
): AssistantDraft {
  const allow = new Set<DraftSectionKind>(allowed);
  return {
    schedules: allow.has("schedules") ? draft.schedules : [],
    notices: allow.has("notices") ? draft.notices : [],
    assignments: allow.has("assignments") ? draft.assignments : [],
  };
}

/** 下書きが 1 件でも項目を持つか（no_result 判定・done 出力の要否）。 */
export function draftHasItems(draft: AssistantDraft): boolean {
  return draft.schedules.length > 0 || draft.notices.length > 0 || draft.assignments.length > 0;
}

/** 下書きの件数（監査記録用・本文は残さず件数のみ、ルール1/4）。 */
export function draftItemCounts(draft: AssistantDraft): Record<DraftSectionKind, number> {
  return {
    schedules: draft.schedules.length,
    notices: draft.notices.length,
    assignments: draft.assignments.length,
  };
}
