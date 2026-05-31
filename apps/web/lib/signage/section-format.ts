/**
 * サイネージ盤面の日次セクション要素 → 表示用テキストへの整形 (#48-E1 / #48-E2 共有単一ソース)。
 *
 * **背景**: daily_data の各セクション JSONB は #48-A では opaque 保持され、要素スキーマは後続スライスで
 * 確定した:
 *  - schedules:   {@link ScheduleItem}   `{ period, subject, note? }`   (#48-H)
 *  - notices:     {@link NoticeItem}     `{ text, isHighlight? }`        (#48-I)
 *  - assignments: {@link AssignmentItem} `{ deadline, subject, task }`   (#48-I)
 *  - quietHours:  {@link QuietRange}     `{ start, end }` ("HH:MM")       (#48-J-2)
 *
 * スキーマ確定前は 2 レンダラ (admin プレビュー `SignageBoard` #48-E1 / 公開 `SignageClient` #48-E2) が
 * **同一の lossy な `itemLabel`** を各々重複実装しており、`["title","label","text","subject",...]` の
 * 先頭ヒットだけを拾っていた。その結果:
 *  - 時間割は `subject` のみ表示し**時限 (period) を捨てる**、
 *  - 提出物は `subject` のみ表示し**期限 (deadline)・内容 (task) を捨てる**、
 *  - 連絡は `text` を表示するが**重要マーク (isHighlight) を反映しない**、
 *  - 静粛時間は一致するキーが無いため `JSON.stringify` され `{"start":"12:30",...}` と**生 JSON が露出**
 *    していた (公開サイネージ = 生徒が見る画面の表示バグ)。
 *
 * 本モジュールはその整形を **kind ごとに確定スキーマで rich 化**して一本化する。型は
 * `@/lib/editor/*` / `quiet-hours-core` を単一ソースとし (`import type` のみ — ランタイム値を持ち込まず
 * `"use client"` な `SignageClient` のバンドルを汚さない、CLAUDE.md ルール3 + #148/#48-J の教訓)。
 *
 * **fail-soft**: items は依然 opaque JSONB (旧データ / 将来差分 / エディタ未経由の投入がありうる) なので、
 * kind 別に**防御的に narrow** し、想定形でなければ従来同等の汎用ラベル抽出にフォールバックする
 * (表示は壊さない)。整形は副作用なしの純関数 — node 環境で網羅 unit テスト可能。
 */

/** 日次セクションの種別 (`EffectiveDailyData` のフィールド名と一致)。 */
export type SignageSectionKind = "schedules" | "notices" | "assignments" | "quietHours";

/** 表示用の 1 行。`emphasis` は重要マーク (notice の isHighlight) のときのみ true。 */
export type SignageLine = { text: string; emphasis?: boolean };

/** trim 済みの非空文字列を返す。非文字列・空は null。 */
function str(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** "YYYY-MM-DD" → "M/D" (前ゼロ無しの短縮表記)。形式不正はそのまま返す。 */
function shortDate(deadline: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline);
  if (!m) {
    return deadline;
  }
  return `${Number(m[2])}/${Number(m[3])}`;
}

/** 時間割: "N限 科目（補足）"。`period` を冠して時限を明示する。 */
function formatSchedule(rec: Record<string, unknown>): SignageLine | null {
  const subject = str(rec.subject);
  if (!subject) {
    return null;
  }
  const hasPeriod =
    typeof rec.period === "number" && Number.isInteger(rec.period) && rec.period > 0;
  const head = hasPeriod ? `${rec.period}限 ${subject}` : subject;
  const note = str(rec.note);
  return { text: note ? `${head}（${note}）` : head };
}

/** 連絡: 本文 + 重要マーク (isHighlight=true のみ emphasis)。 */
function formatNotice(rec: Record<string, unknown>): SignageLine | null {
  const text = str(rec.text);
  if (!text) {
    return null;
  }
  return rec.isHighlight === true ? { text, emphasis: true } : { text };
}

/** 提出物: "科目：内容（〆 M/D）"。期限と内容を捨てずに表示する。 */
function formatAssignment(rec: Record<string, unknown>): SignageLine | null {
  const subject = str(rec.subject);
  const task = str(rec.task);
  if (!subject || !task) {
    return null;
  }
  const deadline = str(rec.deadline);
  const body = `${subject}：${task}`;
  return { text: deadline ? `${body}（〆${shortDate(deadline)}）` : body };
}

/** 静粛時間: "開始–終了" (例: "12:30–13:00")。生 JSON を露出させない。 */
function formatQuietHours(rec: Record<string, unknown>): SignageLine | null {
  const start = str(rec.start);
  const end = str(rec.end);
  if (!start || !end) {
    return null;
  }
  return { text: `${start}–${end}` };
}

const FORMATTERS: Record<SignageSectionKind, (rec: Record<string, unknown>) => SignageLine | null> =
  {
    schedules: formatSchedule,
    notices: formatNotice,
    assignments: formatAssignment,
    quietHours: formatQuietHours,
  };

/**
 * 想定スキーマに合致しない opaque 要素の最終フォールバック (旧 `itemLabel` 互換)。
 * 文字列はそのまま、オブジェクトは代表キーの先頭ヒット、いずれも無ければ JSON 文字列。
 */
function genericLabel(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }
  if (item && typeof item === "object") {
    const rec = item as Record<string, unknown>;
    for (const key of ["title", "label", "text", "subject", "name", "content"]) {
      const v = rec[key];
      if (typeof v === "string" && v.length > 0) {
        return v;
      }
    }
  }
  return JSON.stringify(item);
}

/**
 * 日次セクション要素 1 件を表示用テキストに整形する。`kind` で確定スキーマに沿って rich 化し、
 * 形が合わなければ汎用ラベルにフォールバックする (fail-soft、表示を壊さない)。
 */
export function formatSignageItem(kind: SignageSectionKind, item: unknown): SignageLine {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const line = FORMATTERS[kind](item as Record<string, unknown>);
    if (line) {
      return line;
    }
  }
  return { text: genericLabel(item) };
}
