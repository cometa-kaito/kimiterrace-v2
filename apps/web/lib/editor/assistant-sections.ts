import type { SignageDesignPattern } from "@/lib/signage/design-pattern";
import {
  type SignageBlockKind,
  blockLabel,
  editableBlocksForPattern,
} from "@/lib/signage/pattern-blocks";
import type { DraftSectionKind } from "./assistant-chat-core";

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
 */
export function assistantGreeting(pattern: SignageDesignPattern): string {
  const drafted = resolveDraftSectionLabels(pattern);
  const manual = resolveManualSectionLabels(pattern);
  const head = "今日の連絡、話しかけてください。話す・書く・ファイルでOK。";
  const draftPart = drafted.length > 0 ? `${drafted.join("・")}にまとめて下書きします。` : "";
  // ADR-034（氏名を AI に送らない・AI 自動生成しない）の規律を文言でも保つ（設計書 §6.4）。
  const manualPart =
    manual.length > 0
      ? `${manual.join("・")}は氏名を含むため下のフォームから入力してください。`
      : "";
  return `${head}${draftPart}${manualPart}`;
}
