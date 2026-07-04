import { describe, expect, it } from "vitest";
import {
  SIGNAGE_DESIGN_PATTERNS,
  type SignageDesignPattern,
} from "../../lib/signage/design-pattern";
import {
  PATTERN_BLOCKS,
  PATTERN_BLOCK_LABEL_OVERRIDES,
  PATTERN_BLOCK_ROW_CAPACITY,
  SIGNAGE_BLOCK_META,
  type SignageBlockKind,
  blockLabel,
  blockRowCapacity,
  blocksForPattern,
  editableBlocksForPattern,
  isEditableBlock,
  patternIncludesBlock,
  scheduleInputVariant,
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

  it("pattern1/2/3 は予定（schedule）を主役ブロックに含む（pattern4 は教員入力最小で予定を持たない例外）", () => {
    // pattern1/2/3 は予定が共通の主役。pattern4 だけは「教員入力を連絡のみに絞る」設計上、予定を持たない
    // （2026-06-20 ユーザー確定）。将来パターンが予定を持つ/持たないはここで明示し、安易な全パターン前提を避ける。
    for (const pattern of ["pattern1", "pattern2", "pattern3"] as const) {
      expect(patternIncludesBlock(pattern, "schedule")).toBe(true);
    }
    expect(patternIncludesBlock("pattern4", "schedule")).toBe(false);
  });
});

describe("編集対象ブロックの出し分け", () => {
  it("pattern1 の編集対象は 予定 / 連絡 / 提出物", () => {
    expect(editableBlocksForPattern("pattern1")).toEqual(["schedule", "notice", "assignment"]);
  });

  it("pattern2 の編集対象は 予定 / 生徒呼び出し / 来校者一覧（連絡 / 提出物は出さない）", () => {
    expect(editableBlocksForPattern("pattern2")).toEqual(["schedule", "callout", "visitor"]);
  });

  it("pattern3（廊下）は pattern2 と同一ブロック（時事ニュースはフッタに 1 件ずつ自動切替で再導入・2026-06-22）", () => {
    // 廊下版はニュースを最下段フッタに集約して常時表示する（ユーザー確定 2026-06-22）。ブロック集合・順序は pattern2 と同一。
    expect(PATTERN_BLOCKS.pattern3).toEqual(PATTERN_BLOCKS.pattern2);
    expect(patternIncludesBlock("pattern3", "news")).toBe(true);
    // 編集対象（予定/呼び出し/来校者）は不変（news は自動ブロックで編集対象に元から含まれない）。
    expect(editableBlocksForPattern("pattern3")).toEqual(["schedule", "callout", "visitor"]);
  });

  it("pattern4 の編集対象は 連絡 のみ（教員入力最小・天気/ニュース主役・2026-06-20）", () => {
    // pattern4 は天気・ニュースを主役の自動コンテンツに据え、教員が入力するのは連絡（フリーワード）だけ。
    // 予定/呼び出し/来校者/提出物は教員入力を要するため載せない＝編集対象は notice のみ。
    expect(editableBlocksForPattern("pattern4")).toEqual(["notice"]);
  });

  it("pattern5（掲示板型）の編集対象は お知らせ（notice 先頭＝主役）と 今日の予定（schedule）の 2 つのみ（§6.1）", () => {
    // 掲示板型は notice 主役 + schedule（時刻表示）+ news/weather/ad。callout / visitor / assignment の
    // クラス語彙は出さない（v2-ed47-1 の根治・オーナー決定 1）。編集セクションの並びも notice が先頭。
    expect(PATTERN_BLOCKS.pattern5).toEqual(["notice", "schedule", "news", "weather", "ad"]);
    expect(editableBlocksForPattern("pattern5")).toEqual(["notice", "schedule"]);
    expect(patternIncludesBlock("pattern5", "callout")).toBe(false);
    expect(patternIncludesBlock("pattern5", "visitor")).toBe(false);
    expect(patternIncludesBlock("pattern5", "assignment")).toBe(false);
    expect(patternIncludesBlock("pattern5", "safety_alert")).toBe(false);
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
  it("pattern1 は来校者 / 呼び出し / センサ / 鉄道 / 時事ニュースを出さない（無駄クエリを省く）", () => {
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

  it("防災・安全（safety_alert）は pattern1/pattern4 が取得する（pattern2/3 は出さない・ADR-044）", () => {
    expect(patternIncludesBlock("pattern1", "safety_alert")).toBe(true);
    expect(patternIncludesBlock("pattern4", "safety_alert")).toBe(true);
    expect(patternIncludesBlock("pattern2", "safety_alert")).toBe(false);
    expect(patternIncludesBlock("pattern3", "safety_alert")).toBe(false);
  });

  it("pattern2 は来校者 / 呼び出し / センサ / 鉄道 / 時事ニュースを出し、連絡 / 提出物は出さない", () => {
    expect(patternIncludesBlock("pattern2", "visitor")).toBe(true);
    expect(patternIncludesBlock("pattern2", "callout")).toBe(true);
    expect(patternIncludesBlock("pattern2", "presence")).toBe(true);
    expect(patternIncludesBlock("pattern2", "train")).toBe(true);
    expect(patternIncludesBlock("pattern2", "news")).toBe(true);
    expect(patternIncludesBlock("pattern2", "notice")).toBe(false);
    expect(patternIncludesBlock("pattern2", "assignment")).toBe(false);
  });

  it("pattern4 は 天気/ニュース/防災・安全/鉄道/人感センサ + 連絡 を出し、予定/呼び出し/来校者/提出物は出さない", () => {
    // 自動（API）ブロック: 天気・ニュース・防災安全・鉄道・人感センサ + 広告。教員入力は連絡のみ。
    expect(patternIncludesBlock("pattern4", "weather")).toBe(true);
    expect(patternIncludesBlock("pattern4", "news")).toBe(true);
    expect(patternIncludesBlock("pattern4", "safety_alert")).toBe(true);
    expect(patternIncludesBlock("pattern4", "train")).toBe(true);
    expect(patternIncludesBlock("pattern4", "presence")).toBe(true);
    expect(patternIncludesBlock("pattern4", "notice")).toBe(true);
    // 教員入力を要するブロック（連絡を除く）は載せない。
    expect(patternIncludesBlock("pattern4", "schedule")).toBe(false);
    expect(patternIncludesBlock("pattern4", "callout")).toBe(false);
    expect(patternIncludesBlock("pattern4", "visitor")).toBe(false);
    expect(patternIncludesBlock("pattern4", "assignment")).toBe(false);
  });
});

describe("PATTERN_BLOCK_ROW_CAPACITY / blockRowCapacity（盤面の固定表示行数 = エディタ事前生成数の単一ソース）", () => {
  it("固定枠を持つ編集ブロックはすべて 5 行（2026-06-23 ユーザー確定・本番 pattern1/3 の実表示行数に合わせる）", () => {
    expect(blockRowCapacity("pattern1", "schedule")).toBe(5);
    expect(blockRowCapacity("pattern1", "notice")).toBe(5);
    expect(blockRowCapacity("pattern1", "assignment")).toBe(5);
    expect(blockRowCapacity("pattern2", "schedule")).toBe(5);
    expect(blockRowCapacity("pattern2", "callout")).toBe(5);
    expect(blockRowCapacity("pattern2", "visitor")).toBe(5);
    expect(blockRowCapacity("pattern3", "schedule")).toBe(5);
    expect(blockRowCapacity("pattern3", "callout")).toBe(5);
    expect(blockRowCapacity("pattern3", "visitor")).toBe(5);
    expect(blockRowCapacity("pattern4", "notice")).toBe(5);
    // pattern5（掲示板型）: お知らせ主役 5 行＋今日の予定 5 行（§6.1 初期値。CSS --p5-*-visible と対）。
    expect(blockRowCapacity("pattern5", "notice")).toBe(5);
    expect(blockRowCapacity("pattern5", "schedule")).toBe(5);
  });

  it("パターンが盤面に出さないブロックは 0（事前生成しない / 盤面の固定枠も無い）", () => {
    expect(blockRowCapacity("pattern1", "callout")).toBe(0);
    expect(blockRowCapacity("pattern1", "visitor")).toBe(0);
    expect(blockRowCapacity("pattern2", "notice")).toBe(0);
    expect(blockRowCapacity("pattern2", "assignment")).toBe(0);
    expect(blockRowCapacity("pattern4", "schedule")).toBe(0);
    expect(blockRowCapacity("pattern4", "assignment")).toBe(0);
    // 自動ブロック（教員入力でない）には容量を持たせない。
    expect(blockRowCapacity("pattern1", "weather")).toBe(0);
    expect(blockRowCapacity("pattern2", "news")).toBe(0);
  });

  it("容量を定義したブロックは必ずそのパターンの編集対象ブロック（盤面に出ない/自動ブロックに枠を作らない）", () => {
    for (const pattern of SIGNAGE_DESIGN_PATTERNS) {
      const editable = new Set(editableBlocksForPattern(pattern));
      for (const kind of Object.keys(PATTERN_BLOCK_ROW_CAPACITY[pattern]) as SignageBlockKind[]) {
        expect(editable.has(kind), `${pattern} の容量 ${kind} が編集対象でない`).toBe(true);
      }
    }
  });

  it("未知パターン（型外の値）は既定 pattern1 の容量に倒す（fail-soft）", () => {
    const unknown = "pattern999" as SignageDesignPattern;
    expect(blockRowCapacity(unknown, "schedule")).toBe(5);
    expect(blockRowCapacity(unknown, "notice")).toBe(5);
    expect(blockRowCapacity(unknown, "callout")).toBe(0);
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
      news: "時事ニュース",
      safety_alert: "防災・安全",
      weather: "天気",
      ad: "広告",
    };
    for (const kind of Object.keys(expected) as SignageBlockKind[]) {
      expect(SIGNAGE_BLOCK_META[kind].label).toBe(expected[kind]);
    }
  });
});

describe("blockLabel（パターン別ラベル上書き §6.2・ドリフトガード）", () => {
  it("pattern5 は notice=「お知らせ」/ schedule=「今日の予定」に上書きする", () => {
    expect(blockLabel("pattern5", "notice")).toBe("お知らせ");
    expect(blockLabel("pattern5", "schedule")).toBe("今日の予定");
    // 上書きの無いブロックは共通ラベルのまま（news / weather / ad）。
    expect(blockLabel("pattern5", "news")).toBe(SIGNAGE_BLOCK_META.news.label);
    expect(blockLabel("pattern5", "ad")).toBe(SIGNAGE_BLOCK_META.ad.label);
  });

  it("pattern1〜4 は全ブロックで共通ラベル（SIGNAGE_BLOCK_META.label）と同値＝既存盤面・e2e 非破壊", () => {
    for (const pattern of ["pattern1", "pattern2", "pattern3", "pattern4"] as const) {
      for (const kind of Object.keys(SIGNAGE_BLOCK_META) as SignageBlockKind[]) {
        expect(blockLabel(pattern, kind), `${pattern}/${kind} が上書きされている`).toBe(
          SIGNAGE_BLOCK_META[kind].label,
        );
      }
    }
  });

  it("上書きマップのキーは必ずそのパターンの表示ブロック（出さないブロックへの死にラベルを作らない）", () => {
    for (const [pattern, overrides] of Object.entries(PATTERN_BLOCK_LABEL_OVERRIDES) as [
      SignageDesignPattern,
      Partial<Record<SignageBlockKind, string>>,
    ][]) {
      for (const kind of Object.keys(overrides) as SignageBlockKind[]) {
        expect(
          patternIncludesBlock(pattern, kind),
          `${pattern} の上書き ${kind} がブロック集合に無い`,
        ).toBe(true);
      }
    }
  });

  it("上書きラベルは非空・共通ラベル集合と衝突しない（region 名の一意性＝ドリフトガードの前提）", () => {
    const commonLabels = new Set(Object.values(SIGNAGE_BLOCK_META).map((m) => m.label));
    for (const overrides of Object.values(PATTERN_BLOCK_LABEL_OVERRIDES)) {
      for (const label of Object.values(overrides)) {
        expect(typeof label).toBe("string");
        expect((label as string).length).toBeGreaterThan(0);
        // 「お知らせ」が別ブロックの共通ラベルと同名になると region 照合・エディタ見出しが曖昧になる。
        expect(commonLabels.has(label as string), `上書きラベル ${label} が共通ラベルと衝突`).toBe(
          false,
        );
      }
    }
  });
});

describe("scheduleInputVariant（予定エディタの時限入力形態 §6.2）", () => {
  it("pattern5（掲示板型）だけ time（時刻テキスト入力）・他は period（時限 select）", () => {
    expect(scheduleInputVariant("pattern5")).toBe("time");
    for (const pattern of ["pattern1", "pattern2", "pattern3", "pattern4"] as const) {
      expect(scheduleInputVariant(pattern)).toBe("period");
    }
  });

  it("未知パターン（型外の値）は既定 period に倒す（fail-soft）", () => {
    expect(scheduleInputVariant("pattern999" as SignageDesignPattern)).toBe("period");
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
