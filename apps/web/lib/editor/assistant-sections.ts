import type { SignageDesignPattern } from "@/lib/signage/design-pattern";
import {
  type SignageBlockKind,
  blockLabel,
  editableBlocksForPattern,
} from "@/lib/signage/pattern-blocks";
import type { AssistantDraft, DraftSectionKind } from "./assistant-chat-core";

/**
 * 会話型 AI アシスタントの**パターン準拠セクション解決**（finding①）。其他レーンの **単一ソース
 * `PATTERN_BLOCKS`**（`editableBlocksForPattern`）を consume し、クラスの実効パターンが盤面に出す編集
 * ブロックを「会話型 AI が下書きできるセクション」へ射影する。**AI レーンで独自の pattern→セクション表は
 * 定義しない**（二重定義＝ドリフト回避・調整ポイント1）。pattern が増えても本モジュールは無改修で追従する。
 */

/**
 * サイネージ表示ブロック種別 → 会話型 AI が下書きできるセクション。**callout（生徒呼び出し）/ visitor
 * （来校者）は ADR-034（決定3/5: 氏名を Vertex に送らない・AI 自動生成しない）で AI 生成しない**ため
 * 含めない（pattern2 でこれらは教員手入力へ誘導する）。schedule/notice/assignment のみ。presence/train/
 * weather/ad は自動ブロック（編集対象外）でそもそも `editableBlocksForPattern` に出ない。
 */
const BLOCK_TO_DRAFT_SECTION: Partial<Record<SignageBlockKind, DraftSectionKind>> = {
  schedule: "schedules",
  notice: "notices",
  assignment: "assignments",
};

/**
 * クラスの実効パターンで会話型 AI が下書きできるセクションを順序付きで解決する。
 * 例: pattern1 → `[schedules, notices, assignments]`、pattern2 → `[schedules]`
 * （来校者/呼び出しは AI 生成しないため除外）。
 */
export function resolveAllowedSections(pattern: SignageDesignPattern): DraftSectionKind[] {
  const out: DraftSectionKind[] = [];
  for (const block of editableBlocksForPattern(pattern)) {
    const section = BLOCK_TO_DRAFT_SECTION[block];
    if (section) {
      out.push(section);
    }
  }
  return out;
}

/**
 * 実効パターンの編集ブロックのうち、**AI が下書きしない（＝教員が手入力する）**ブロックのラベル一覧
 * （例 pattern2 → `["生徒呼び出し", "来校者一覧"]`）。会話型 AI の system プロンプトが「これらは氏名を含む
 * ため AI では作らず、手入力フォームから追加してください」と誘導するために使う（pattern1 では空）。
 * ラベルはパターン別上書き込みの {@link blockLabel}（§6.2・盤面 region 名／エディタ見出しと同源）。
 */
export function resolveManualSectionLabels(pattern: SignageDesignPattern): string[] {
  return editableBlocksForPattern(pattern)
    .filter((block) => BLOCK_TO_DRAFT_SECTION[block] === undefined)
    .map((block) => blockLabel(pattern, block));
}

/**
 * 実効パターンで **AI が下書きするセクションの表示ラベル**（盤面の並び順・{@link blockLabel} 経由 §6.2）。
 * 例: pattern1 → `["予定","連絡","提出物"]`／pattern2 → `["予定"]`／pattern5 → `["お知らせ","今日の予定"]`。
 * 歓迎文（{@link assistantGreeting}）と UI の文言合成が共有する。
 */
export function resolveDraftSectionLabels(pattern: SignageDesignPattern): string[] {
  return editableBlocksForPattern(pattern)
    .filter((block) => BLOCK_TO_DRAFT_SECTION[block] !== undefined)
    .map((block) => blockLabel(pattern, block));
}

/**
 * 会話型 AI の**歓迎文をパターンから合成**する（v2-ed47-5 の根治・設計書 §6.4）。旧実装は
 * 「予定・連絡・提出物にまとめて下書きします」の固定文言で、pattern2/3 の呼び出し / 来校者や pattern4/5 の
 * 実セクションと**常に不一致**だった。本関数は下書き対象（{@link resolveDraftSectionLabels}）と手入力誘導
 * （{@link resolveManualSectionLabels}・ADR-034: 氏名は AI 生成しない）をパターンの実セクションから組む。
 *
 * 例:
 * - pattern1 → 「…予定・連絡・提出物にまとめて下書きします。」（従来文言と同値＝回帰なし）
 * - pattern2/3 → 「…予定にまとめて下書きします。生徒呼び出し・来校者一覧は氏名を含むため下のフォームから
 *   入力してください。」
 * - pattern5 → 「…お知らせ・今日の予定にまとめて下書きします。」
 *
 * `dateLabel`（例「7/15（水）」）を渡すと冒頭を**編集対象日つき**にする（2026-07-06 実画面監査 P2-1:
 * 16 時カットオーバー後の編集対象は翌授業日で、固定の「今日の連絡」が嘘になる＋反映先日付がどこにも
 * 出ない、の是正）。省略時は従来文言のまま（既存呼び出し・テストの回帰なし）。
 */
export function assistantGreeting(pattern: SignageDesignPattern, dateLabel?: string): string {
  const drafted = resolveDraftSectionLabels(pattern);
  const manual = resolveManualSectionLabels(pattern);
  const head = dateLabel
    ? `${dateLabel}の盤面を作ります。話しかけてください。話す・書く・ファイルでOK。`
    : "今日の連絡、話しかけてください。話す・書く・ファイルでOK。";
  const draftPart = drafted.length > 0 ? `${drafted.join("・")}にまとめて下書きします。` : "";
  // ADR-034（氏名を AI に送らない・AI 自動生成しない）の規律を文言でも保つ（設計書 §6.4）。
  const manualPart =
    manual.length > 0
      ? `${manual.join("・")}は氏名を含むため下のフォームから入力してください。`
      : "";
  return `${head}${draftPart}${manualPart}`;
}

/**
 * 確認カードの下書き 1 行に**小さく併記する詳細**（2026-07-06 実画面監査 P2-4: AI が正しく抽出した
 * 場所・対象者・重要★等がカードに出ず、反映前に確認できない、の是正）。本文（{@link
 * "@/lib/signage/section-format".formatSignageItem} — 補足 note は本文の括弧で表示済み）に対する
 * **追加メタのみ**を返す。盤面の整形（section-format）は変えない（表示層はカード側で足す）。
 *
 * - 予定: 場所（＠〜）・対象者（対象: 〜）・重要（★）
 * - 連絡: 表示日数>1（N日間表示）・重要（★）。**固定（pinned）は出さない**: AI 経由の保存は
 *   preservePinnedNotices が pinned を意図的に demote するため、カードで「固定」を約束すると保存結果と
 *   乖離する（#1250 Reviewer LOW の吸収・固定は手入力の「ずっと」＋固定中一覧が正規経路）
 * - 提出物: 重要（★）のみ（期限は本文「（〆M/D）」が既に表示）
 *
 * 要素型は検証済み単一ソース（{@link AssistantDraft} = schedule-core / notice-assignment-core・ルール3）
 * から導出し、手書きの item 型を二重定義しない。区切り線（divider）行は validate が詳細フィールドを
 * 剥がすため自然に null になる。併記なしは null（呼び出し側は何も描かない）。
 */
export type DraftSectionItem = { [K in DraftSectionKind]: AssistantDraft[K][number] };

const DRAFT_ITEM_META: { [K in DraftSectionKind]: (item: DraftSectionItem[K]) => string[] } = {
  schedules: (item) => {
    const parts: string[] = [];
    if (item.location) {
      parts.push(`＠${item.location}`);
    }
    if (item.targetAudience) {
      parts.push(`対象: ${item.targetAudience}`);
    }
    if (item.isHighlight === true) {
      parts.push("★");
    }
    return parts;
  },
  notices: (item) => {
    const parts: string[] = [];
    if (typeof item.displayDays === "number" && item.displayDays > 1) {
      parts.push(`${item.displayDays}日間表示`);
    }
    // pinned は表示しない（AI 反映は preservePinnedNotices が pinned を demote する＝「固定」を
    // カードで約束すると保存結果と乖離する。docstring 参照）。
    if (item.isHighlight === true) {
      parts.push("★");
    }
    return parts;
  },
  assignments: (item) => (item.isHighlight === true ? ["★"] : []),
};

export function draftItemMeta<K extends DraftSectionKind>(
  kind: K,
  item: DraftSectionItem[K],
): string | null {
  const parts = DRAFT_ITEM_META[kind](item);
  return parts.length > 0 ? parts.join(" ") : null;
}
