import type { SignageDesignPattern } from "@/lib/signage/design-pattern";
import {
  SIGNAGE_BLOCK_META,
  type SignageBlockKind,
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
 */
export function resolveManualSectionLabels(pattern: SignageDesignPattern): string[] {
  return editableBlocksForPattern(pattern)
    .filter((block) => BLOCK_TO_DRAFT_SECTION[block] === undefined)
    .map((block) => SIGNAGE_BLOCK_META[block].label);
}
