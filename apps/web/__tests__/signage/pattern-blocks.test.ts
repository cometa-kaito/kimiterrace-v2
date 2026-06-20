import { describe, expect, it } from "vitest";
import {
  SIGNAGE_DESIGN_PATTERNS,
  type SignageDesignPattern,
} from "../../lib/signage/design-pattern";
import {
  PATTERN_BLOCKS,
  SIGNAGE_BLOCK_META,
  type SignageBlockKind,
  blocksForPattern,
  editableBlocksForPattern,
  isEditableBlock,
  patternIncludesBlock,
} from "../../lib/signage/pattern-blocks";

/**
 * パターン → 表示ブロックの宣言的マッピング（単一ソース）の検証。盤面・データ層・エディタ・AI が同源で
 * 駆動するための前提（全パターンが定義済み・ブロックにメタ有り・編集対象の出し分けが正）を機械的に固定し、
 * 将来パターン追加時に「マッピング 1 行追加」を忘れたらテストで落ちるようにする（finding①・ドリフト排除）。
 */

describe("PATTERN_BLOCKS 単一ソースの整合性", () => {
  it("全デザインパターンに表示ブロックを定義している（追加忘れ防止）", () => {
    for (const pattern of SIGNAGE_DESIGN_PATTERNS) {
      const blocks = PATTERN_BLOCKS[pattern];
      expect(blocks, `${pattern} の PATTERN_BLOCKS が未定義`).toBeDefined();
      expect(blocks.length, `${pattern} の表示ブロックが空`).toBeGreaterThan(0);
    }
  });

  it("各パターンの全ブロックに SIGNAGE_BLOCK_META エントリがある", () => {
    for (const pattern of SIGNAGE_DESIGN_PATTERNS) {
      for (const kind of PATTERN_BLOCKS[pattern]) {
        expect(SIGNAGE_BLOCK_META[kind], `${kind} のメタが無い`).toBeDefined();
      }
    }
  });

  it("各パターン内にブロックの重複が無い", () => {
    for (const pattern of SIGNAGE_DESIGN_PATTERNS) {
      const blocks = PATTERN_BLOCKS[pattern];
      expect(new Set(blocks).size, `${pattern} にブロック重複`).toBe(blocks.length);
    }
  });

  it("どのパターンも予定（schedule）を含む（共通の主役ブロック）", () => {
    for (const pattern of SIGNAGE_DESIGN_PATTERNS) {
      expect(patternIncludesBlock(pattern, "schedule")).toBe(true);
    }
  });
});

describe("編集対象ブロックの出し分け", () => {
  it("pattern1 の編集対象は 予定 / 連絡 / 提出物", () => {
    expect(editableBlocksForPattern("pattern1")).toEqual(["schedule", "notice", "assignment"]);
  });

  it("pattern2 の編集対象は 予定 / 生徒呼び出し / 来校者一覧（連絡 / 提出物は出さない）", () => {
    expect(editableBlocksForPattern("pattern2")).toEqual(["schedule", "callout", "visitor"]);
  });

  it("pattern3（廊下）は pattern2 と同一ブロック（内容据え置き・デザインのみ最適化）", () => {
    // 先方確定コンテンツを変えない＝表示ブロックも順序も pattern2 と完全一致（違いは盤面レイアウトのみ）。
    expect(PATTERN_BLOCKS.pattern3).toEqual(PATTERN_BLOCKS.pattern2);
    expect(editableBlocksForPattern("pattern3")).toEqual(["schedule", "callout", "visitor"]);
  });

  it("編集対象には自動ブロック（天気 / 広告 / センサ / 鉄道）を含めない", () => {
    for (const pattern of SIGNAGE_DESIGN_PATTERNS) {
      for (const kind of editableBlocksForPattern(pattern)) {
        expect(isEditableBlock(kind), `${kind} は editable でない`).toBe(true);
      }
    }
    expect(isEditableBlock("weather")).toBe(false);
    expect(isEditableBlock("ad")).toBe(false);
    expect(isEditableBlock("presence")).toBe(false);
    expect(isEditableBlock("train")).toBe(false);
    expect(isEditableBlock("news")).toBe(false);
  });

  it("編集対象は盤面の表示順を保つ（盤面と同じ順で編集できる）", () => {
    for (const pattern of SIGNAGE_DESIGN_PATTERNS) {
      const editable = editableBlocksForPattern(pattern);
      const full = blocksForPattern(pattern).filter(isEditableBlock);
      expect(editable).toEqual(full);
    }
  });
});

describe("patternIncludesBlock（データ層の取得ゲート）", () => {
  it("pattern1 は来校者 / 呼び出し / センサ / 鉄道 / 工学ニュースを出さない（無駄クエリを省く）", () => {
    expect(patternIncludesBlock("pattern1", "visitor")).toBe(false);
    expect(patternIncludesBlock("pattern1", "callout")).toBe(false);
    expect(patternIncludesBlock("pattern1", "presence")).toBe(false);
    expect(patternIncludesBlock("pattern1", "train")).toBe(false);
    expect(patternIncludesBlock("pattern1", "news")).toBe(false);
  });

  it("pattern1 は 連絡 / 提出物を出す", () => {
    expect(patternIncludesBlock("pattern1", "notice")).toBe(true);
    expect(patternIncludesBlock("pattern1", "assignment")).toBe(true);
  });

  it("防災・安全（safety_alert）は pattern1 だけが取得する（pattern2/3 は無改修・出さない・ADR-044）", () => {
    expect(patternIncludesBlock("pattern1", "safety_alert")).toBe(true);
    expect(patternIncludesBlock("pattern2", "safety_alert")).toBe(false);
    expect(patternIncludesBlock("pattern3", "safety_alert")).toBe(false);
  });

  it("pattern2 は来校者 / 呼び出し / センサ / 鉄道 / 工学ニュースを出し、連絡 / 提出物は出さない", () => {
    expect(patternIncludesBlock("pattern2", "visitor")).toBe(true);
    expect(patternIncludesBlock("pattern2", "callout")).toBe(true);
    expect(patternIncludesBlock("pattern2", "presence")).toBe(true);
    expect(patternIncludesBlock("pattern2", "train")).toBe(true);
    expect(patternIncludesBlock("pattern2", "news")).toBe(true);
    expect(patternIncludesBlock("pattern2", "notice")).toBe(false);
    expect(patternIncludesBlock("pattern2", "assignment")).toBe(false);
  });
});

describe("blocksForPattern の fail-soft", () => {
  it("未知パターン（型外の値）は既定 pattern1 のブロックに倒す", () => {
    // 解決層が想定外の値を渡しても盤面を壊さない（design-pattern と同じ作法）。型安全を外して保険挙動を検証。
    const unknown = "pattern999" as SignageDesignPattern;
    expect(blocksForPattern(unknown)).toEqual(PATTERN_BLOCKS.pattern1);
  });
});

describe("SIGNAGE_BLOCK_META のラベルは盤面 aria-label と一致（クロスチェック）", () => {
  it("ブロック種別 → 盤面リージョン名の対応が固定されている", () => {
    const expected: Record<SignageBlockKind, string> = {
      schedule: "予定",
      notice: "連絡",
      assignment: "提出物",
      callout: "生徒呼び出し",
      visitor: "来校者一覧",
      presence: "人感センサカウンタ",
      train: "鉄道",
      news: "工学ニュース",
      safety_alert: "防災・安全",
      weather: "天気",
      ad: "広告",
    };
    for (const kind of Object.keys(expected) as SignageBlockKind[]) {
      expect(SIGNAGE_BLOCK_META[kind].label).toBe(expected[kind]);
    }
  });
});

describe("safety_alert ブロックのメタ（条件付き帯・region landmark なし）", () => {
  it("自動ブロック（編集対象外）かつ hasRegion=false（条件付き描画 ↔ ドリフトガード両立）", () => {
    // weather / pattern3 週間天気帯と同じく、条件付き描画と盤面 region ドリフトガードを両立するため
    // region landmark を持たない（role=group でまとめる）。editable=false（教員入力でなく自動取得）。
    expect(isEditableBlock("safety_alert")).toBe(false);
    expect(SIGNAGE_BLOCK_META.safety_alert.hasRegion).toBe(false);
    expect(SIGNAGE_BLOCK_META.safety_alert.label).toBe("防災・安全");
  });

  it("safety_alert は編集対象ブロックに含めない（pattern1 の編集欄は 予定/連絡/提出物 のまま）", () => {
    expect(editableBlocksForPattern("pattern1")).not.toContain("safety_alert");
  });
});
