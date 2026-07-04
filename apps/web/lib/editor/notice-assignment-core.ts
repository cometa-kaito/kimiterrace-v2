import type { Validated } from "./schedule-core";
import { DIVIDER_LABEL_MAX, isValidDate } from "./schedule-core";

/**
 * エディタ Notice (連絡) / Assignment (提出物) セクション (#48-I) の純粋ロジック・型・定数。
 *
 * **notices / assignments 要素の正式スキーマをここで確定する** (#48-A では daily_data.notices /
 * daily_data.assignments を opaque JSONB 保持、本スライスが各要素の形を定義)。schedule-core が
 * `ScheduleItem` を確定したのと同じ思想。
 *
 * 要素の形は V1 (`management/src/components/editor/{Notice,Assignment}Section.tsx`) を踏襲:
 * - Notice:    `{ text, isHighlight? }`     (V1 `{ text, is_highlight }`)
 * - Assignment:`{ deadline, subject, task }` (V1 と同名)
 *
 * サイネージ描画 (#48-E1 `SignageBoard.itemLabel`) は要素から代表ラベルを
 * `["title","label","text","subject","name","content"]` の順で防御的に拾う。Notice の `text` と
 * Assignment の `subject` がそれぞれヒットするため、本スキーマは既存描画と整合する。
 *
 * `"use server"` ファイル (notice-assignment-actions.ts) は async export しか持てないため、検証・
 * 型・定数はここに分離する (schedule-core.ts と同じ構成)。`ActionResult` 等は schedule-core から
 * 再利用する (エディタ全体で単一)。
 */

/**
 * 連絡 (お知らせ) の 1 件。`text` は本文 (1..500)、`isHighlight` は重要マーク (既定 false)。
 * `displayDays` は表示日数 (1..{@link NOTICE_MAX_DISPLAY_DAYS}、既定 1=入力日のみ)。入力した日を起点に
 * `displayDays` 日間サイネージに表示する (#243 ②UI-UX「何日後まで表示」)。既定 1 のときは省略。
 * サイネージ (#48-E1) は `text` を代表ラベルとして描画する。
 */
export type NoticeItem = {
  /**
   * 行タイプ。`"divider"` = 区切り線（§5.3・ダッシュ行ハックの正規化）。divider 行は「**本文が罫線であるだけの
   * 行**」＝ `text` を任意ラベル（空文字なら純粋な罫線）として使い、`displayDays` は通常行と**同じライフサイクル**
   * を持つ（多日連絡のグルーピングが翌日崩れない・将来の pinned もそのまま乗る）。`isHighlight` のみ意味を
   * 持たない（罫線に強調概念なし・validate が剥がす）。省略（undefined）は通常の連絡行。JSONB なので migration 不要。
   */
  kind?: "divider";
  text: string;
  isHighlight?: boolean;
  displayDays?: number;
  /**
   * 固定表示（「ずっと」・F-C §5.4）。`true` のとき入力日以降**無期限**でサイネージ・学校管理ハブに表示し続ける。
   * `displayDays` の番兵値ではなく独立フラグ＝「ずっと」は期間の一種ではなく**固定**という別概念
   * （`NOTICE_MAX_DISPLAY_DAYS=14` が遡及窓の根拠である不変条件を壊さない）。pinned のとき `displayDays` は
   * 保存しない（validate が剥がす＝排他）。divider 行にも許可（校訓掲示板で「区切り線ごと固定」を成立させる）。
   * 旧リーダ（pinned を知らない盤面）では既定 1=入力日のみ表示に劣化するだけで壊れない（fail-soft）。
   * JSONB なので migration 不要。明示 `true` のみ保存する（isHighlight と同作法）。
   */
  pinned?: boolean;
};

/**
 * 提出物 (課題) の 1 件。`deadline` は提出期限 (YYYY-MM-DD)、`subject` は科目名 (1..32)、
 * `task` は提出物の内容 (1..200)、`isHighlight` は重要マーク（★・F-B1 §5.2、明示 true のみ保存）。
 * サイネージ (#48-E1) は `subject` を代表ラベルとして描画する。
 * 提出物は手動の表示日数を持たず、**入力日〜「期限 + {@link ASSIGNMENT_GRACE_DAYS} 日」まで自動表示**し、
 * 以後はサイネージから自動的に消える (#243、表示判定は signage の effective-daily-data が deadline から行う)。
 */
export type AssignmentItem = {
  deadline: string;
  subject: string;
  task: string;
  isHighlight?: boolean;
};

/**
 * 固定表示 (pinned・F-C §5.4) を含む daily_data 1 行ぶんの連絡 (クラス直・入力日つき)。エディタの
 * 「固定中のお知らせ」一覧と削除 (入力日の行の**置換保存**) が使う。`items` は行の連絡**全件**
 * (pinned 以外も含む) — 削除は行全体の置換保存なので全件が要る。client component からも参照するため
 * DB 非依存の本モジュールに置く (取得は notice-assignment-queries の getClassPinnedNoticeRows)。
 */
export type PinnedNoticeRow = { date: string; items: NoticeItem[] };

/** 連絡の表示日数の上限 (入力日を含む日数)。サイネージの遡及読み取り窓の根拠にもなる。 */
export const NOTICE_MAX_DISPLAY_DAYS = 14;

/** 提出物を期限後も表示し続ける猶予日数 (期限 + これ日後まで表示し、以後自動で消える)。 */
export const ASSIGNMENT_GRACE_DAYS = 2;

const MAX_NOTICES = 20;
const NOTICE_TEXT_MAX = 500;

const MAX_ASSIGNMENTS = 30;
const SUBJECT_MAX = 32;
const TASK_MAX = 200;

function normalizeString(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    return null;
  }
  return trimmed;
}

/**
 * {@link validateNoticeItems} のオプション。
 * `allowPinned: false` は **pinned を黙って剥がす**（拒否しない・fail-soft）。固定表示はクラス scope 限定
 * （§5.4 は校訓のクラス用途のみを規定・削除導線 {@link PinnedNoticeRow} もクラスエディタにしか無い）ため、
 * scope=学校/学科/学年 の保存経路 (notice-assignment-actions) が UI 出し分けの**防御の二層目**として渡す。
 * これが無いと「学校 scope で pin → 全クラス盤面に恒久表示なのにどのエディタからも消せない幽霊」が
 * 作れてしまう (2026-07-04 Reviewer HIGH-1)。剥がした行は displayDays があればそれを、無ければ既定 1 に
 * 劣化する（旧リーダの fail-soft と同じ性質）。既定は true（後方互換・読み取り/クラス保存はそのまま）。
 */
export type ValidateNoticeOptions = { allowPinned?: boolean };

/**
 * 連絡配列を検証・正規化する。1 件でも不正なら全体を拒否 (部分保存しない)。
 * 入力順を保持する (連絡は表示順に意味があるため、schedule の period ソートとは異なる)。
 */
export function validateNoticeItems(
  raw: unknown,
  options?: ValidateNoticeOptions,
): Validated<NoticeItem[]> {
  const allowPinned = options?.allowPinned !== false;
  if (!Array.isArray(raw)) {
    return { ok: false, message: "連絡の形式が不正です。" };
  }
  if (raw.length > MAX_NOTICES) {
    return { ok: false, message: `連絡は最大 ${MAX_NOTICES} 件までです。` };
  }
  const items: NoticeItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "連絡の各件が不正です。" };
    }
    const rec = entry as Record<string, unknown>;
    // 固定表示 (pinned・§5.4)。明示 true のみ採用 (isHighlight と同作法・"true" 等の truthy は無視)。
    // pinned のとき displayDays は保存しない (「ずっと」は期間ではなく固定という別概念＝排他をここで確定)。
    // allowPinned=false (scope=学校/学科/学年 の保存経路・HIGH-1) では黙って剥がし、displayDays 側を生かす。
    const pinned = rec.pinned === true && allowPinned;
    // 表示日数 (任意・行タイプ共通のライフサイクル属性)。未指定は既定 1 (入力日のみ)。1..MAX の整数のみ
    // 許可し、既定 1 は省略して保存する (JSONB を最小化・後方互換)。区切り線も「本文が罫線であるだけの行」
    // として通常行と同一に扱う (§5.3・多日連絡のグルーピングを翌日崩さない)。pinned でも不正値は拒否する
    // (黙って通さない) が、正当値も保存はしない (pinned が勝つ)。
    let displayDays: number | undefined;
    if (rec.displayDays !== undefined) {
      const d = rec.displayDays;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > NOTICE_MAX_DISPLAY_DAYS) {
        return {
          ok: false,
          message: `表示日数は 1〜${NOTICE_MAX_DISPLAY_DAYS} の整数で指定してください。`,
        };
      }
      if (d > 1 && !pinned) {
        displayDays = d;
      }
    }
    // 行タイプ（§5.3）: "divider" のみ受理し、それ以外の kind 値は拒否。divider 行は text を任意ラベル
    // （空可・DIVIDER_LABEL_MAX 以内）として持つ。isHighlight のみ剥がす（罫線に強調概念なし）。
    if (rec.kind !== undefined && rec.kind !== null) {
      if (rec.kind !== "divider") {
        return { ok: false, message: "連絡の行タイプが不正です。" };
      }
      const label = typeof rec.text === "string" ? rec.text.trim() : "";
      if (label.length > DIVIDER_LABEL_MAX) {
        return {
          ok: false,
          message: `区切り線のラベルは ${DIVIDER_LABEL_MAX} 文字以内で入力してください。`,
        };
      }
      items.push({
        kind: "divider",
        text: label,
        // divider にも pinned を許可 (§5.4・「区切り線ごと固定」= 校訓掲示板の見出し用途)。
        ...(pinned ? { pinned: true } : {}),
        ...(displayDays !== undefined ? { displayDays } : {}),
      });
      continue;
    }
    const text = normalizeString(rec.text, NOTICE_TEXT_MAX);
    if (!text) {
      return { ok: false, message: `連絡の本文は 1〜${NOTICE_TEXT_MAX} 文字で入力してください。` };
    }
    const item: NoticeItem = { text };
    // 真偽以外 (文字列 "true" / undefined 等) は false 扱い。重要マークは明示 true のみ。
    if (rec.isHighlight === true) {
      item.isHighlight = true;
    }
    if (pinned) {
      item.pinned = true;
    }
    if (displayDays !== undefined) {
      item.displayDays = displayDays;
    }
    items.push(item);
  }
  return { ok: true, value: items };
}

/**
 * 前日/前週コピーの複製対象となる連絡だけを残す (§6.4)。固定行 (pinned) は**除外**する — 既に全日
 * 表示されており、コピーすると同じ内容が二重表示になるため。区切り線 (divider) はレイアウトの一部
 * なので**含める**。純関数 (copy-day-actions が前営業日/前週の items に適用する)。
 */
export function copyableNoticeItems(items: NoticeItem[]): NoticeItem[] {
  return items.filter((i) => i.pinned !== true);
}

/**
 * 提出物配列を検証・正規化する。1 件でも不正なら全体を拒否 (部分保存しない)。
 * 提出期限 (deadline) の昇順で正規化する (安定ソート＝同一期限内は入力順を保持・保存・描画の決定性)。
 */
export function validateAssignmentItems(raw: unknown): Validated<AssignmentItem[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "提出物の形式が不正です。" };
  }
  if (raw.length > MAX_ASSIGNMENTS) {
    return { ok: false, message: `提出物は最大 ${MAX_ASSIGNMENTS} 件までです。` };
  }
  const items: AssignmentItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "提出物の各件が不正です。" };
    }
    const rec = entry as Record<string, unknown>;
    if (!isValidDate(rec.deadline)) {
      return { ok: false, message: "提出期限は実在する日付 (YYYY-MM-DD) で入力してください。" };
    }
    const subject = normalizeString(rec.subject, SUBJECT_MAX);
    if (!subject) {
      return { ok: false, message: `科目名は 1〜${SUBJECT_MAX} 文字で入力してください。` };
    }
    const task = normalizeString(rec.task, TASK_MAX);
    if (!task) {
      return { ok: false, message: `提出物の内容は 1〜${TASK_MAX} 文字で入力してください。` };
    }
    const item: AssignmentItem = { deadline: rec.deadline, subject, task };
    // 重要マーク（★・§5.2）: 明示 true のみ受理（連絡の isHighlight と同作法）。
    if (rec.isHighlight === true) {
      item.isHighlight = true;
    }
    items.push(item);
  }
  // 期限の昇順で安定ソート (同一期限内は入力順を保持・保存・描画の決定性)。⠿ 並べ替え（D 群）も
  // 同一期限内の入力順として、この安定ソートでそのまま保存される。
  items.sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0));
  return { ok: true, value: items };
}
