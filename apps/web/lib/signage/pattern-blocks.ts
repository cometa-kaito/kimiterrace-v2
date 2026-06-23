/**
 * **パターン → 表示ブロックの宣言的マッピング（単一ソース）**。
 *
 * サイネージのデザインパターン（{@link SignageDesignPattern}）ごとに「盤面に出る表示ブロック」を**1 箇所で
 * 宣言**し、盤面（`SignageClient` の PatternNBoard）・公開データ層（`signage-display.ts` の取得ゲート）・
 * エディタ（編集セクション出し分け）・AI アシスタント（パターン準拠の振り分け先）を**同一ソースで駆動**する。
 * これまで「どのパターンがどのブロックを出すか」は各盤面コンポーネント・データ取得・エディタに**暗黙重複**で
 * 散らばっており（pattern1 校でも来校者/呼び出しエディタを無条件描画する等、指摘ログ finding①）、ドリフトの
 * 温床だった。本モジュールに集約してドリフトを機械的に排す。
 *
 * **現在の consumer**: データ層 `signage-display.ts`（取得ゲート）＋盤面 `SignageClient`（region ドリフト
 * ガードで一致を機械担保）。エディタ（不要セクションの無条件描画の解消）と AI アシスタント（振り分け先）の
 * consume は後続レーン（UI / AI レーン）が本マッピングを import して行う＝本モジュールはその keystone。
 *
 * ## 将来パターン拡張前提（if 分岐ハードコード禁止・ユーザー指示）
 * 「今後もサイネージパターンは増える可能性がある」前提で設計する。**新パターン追加＝{@link PATTERN_BLOCKS}
 * に 1 行**（＋新ブロックなら {@link SignageBlockKind} と {@link SIGNAGE_BLOCK_META} に 1 エントリ＋盤面
 * 実装）だけで、エディタ／AI／データ層が**自動追従**する。各レーンが pattern1/2 を `switch`/`if` で個別分岐
 * しないこと（このマッピングを参照する）。
 *
 * ## client-safe 制約
 * `./design-pattern` のみに依存し postgres を引き込まない（"use client" な `SignageClient`・エディタの
 * client コンポーネントからも import するため。#148 の client/server バンドル分離を踏襲）。学校レベルの
 * 実効パターン解決（DB 読み取り）は server 専用 `./signage-design` の `getSignageDesignPattern` が担う。
 */

import { DEFAULT_SIGNAGE_DESIGN_PATTERN, type SignageDesignPattern } from "./design-pattern";

/**
 * サイネージ盤面に出る表示ブロックの種別（単一ソース）。`schedule`/`notice`/`assignment`/`callout`/
 * `visitor` は教員が日次入力する**編集対象**、`presence`/`train`/`news`/`weather`/`ad` はシステム供給の
 * **自動ブロック**（エディタ対象外）。静粛時間（quietHours）は盤面に出さない学校設定なので含めない。
 * 将来ブロックを増やす時はここに追加し {@link SIGNAGE_BLOCK_META} に対応エントリを足す。
 */
export type SignageBlockKind =
  | "schedule" // 予定
  | "notice" // 連絡
  | "assignment" // 提出物
  | "callout" // 生徒呼び出し
  | "visitor" // 来校者一覧
  | "presence" // 人感センサカウンタ
  | "train" // 鉄道
  | "news" // 時事ニュース（旧称「工学ニュース」・外部取得キャッシュの見出し+出典・ADR-043）
  | "safety_alert" // 防災・安全（気象警報/注意報 + 熱中症警戒。アクティブ時のみ条件付き表示・ADR-044）
  | "weather" // 天気（予定列ヘッダーに内包・独立リージョン無し）
  | "ad"; // 広告

/** 表示ブロック 1 種のメタ情報。 */
export type SignageBlockMeta = {
  /**
   * 盤面リージョン／編集セクションの表示名。盤面の `aria-label`（region 名）と一致させ、ドリフトガード
   * テスト・エディタ見出し・AI 振り分けラベルで共用する。
   */
  readonly label: string;
  /**
   * 教員が日次入力する**編集対象**ブロックか。`true`＝エディタ／AI アシスタントが編集セクションを出す。
   * `false`＝システム供給の自動ブロック（天気／センサ／鉄道／広告）でエディタ対象外。
   */
  readonly editable: boolean;
  /**
   * 盤面で `role=region`（`<section aria-label>`）の独立 landmark を持つか。盤面ドリフトガードの
   * リージョン照合に使う（`hasRegion` ブロックの集合＝盤面に出る region 名の集合）。`ad` は `<aside>`＝
   * complementary landmark、`weather` は予定列ヘッダー内包なので、いずれも region landmark を持たない
   * （`false`）。
   */
  readonly hasRegion: boolean;
};

/**
 * 各ブロックのメタ情報（単一ソース）。`editable`／`hasRegion` はこの 1 箇所で定義し、エディタ・AI・盤面
 * ドリフトガードが参照する。`label` は盤面の `aria-label` と一致（盤面実装と齟齬が出たらガードテストが落ちる）。
 */
export const SIGNAGE_BLOCK_META: Record<SignageBlockKind, SignageBlockMeta> = {
  schedule: { label: "予定", editable: true, hasRegion: true },
  notice: { label: "連絡", editable: true, hasRegion: true },
  assignment: { label: "提出物", editable: true, hasRegion: true },
  callout: { label: "生徒呼び出し", editable: true, hasRegion: true },
  visitor: { label: "来校者一覧", editable: true, hasRegion: true },
  presence: { label: "人感センサカウンタ", editable: false, hasRegion: true },
  train: { label: "鉄道", editable: false, hasRegion: true },
  news: { label: "時事ニュース", editable: false, hasRegion: true },
  // 防災・安全（気象警報 + 熱中症）。**アクティブな時だけ**条件付きで出す自動ブロック（ADR-044）。盤面では
  // weather と同様に独立 region landmark を作らず（`hasRegion=false`）、帯は `role="group"` でまとめる。これは
  // 「条件付き描画（無アラート時は帯ごと出さない）」と盤面 region ドリフトガード（描画 region 集合 ↔ hasRegion
  // ブロック集合の一致）を両立させるため（pattern3 週間天気帯と同じ作法）。aria-label は本 label と一致させる。
  safety_alert: { label: "防災・安全", editable: false, hasRegion: false },
  weather: { label: "天気", editable: false, hasRegion: false },
  ad: { label: "広告", editable: false, hasRegion: false },
};

/**
 * **パターン → 表示ブロック（順序付き）の単一ソース**。配列の順序は盤面の主要コンテンツ読み順に合わせ、
 * `editableBlocksForPattern` が返す編集セクションの並びもこれに従う（教員が盤面と同じ順で編集できる）。
 * 自動ブロック（weather／ad）は編集フローの末尾に置く。
 *
 * - **pattern1**（既定・v1 レイアウト）: 防災・安全（条件付き）／予定／連絡／提出物 ＋ 天気（予定内包）／広告。
 * - **pattern2**（掲示盤面）: 予定／生徒呼び出し／来校者一覧／鉄道／人感センサ／時事ニュース ＋ 天気／広告。
 * - **pattern3**（廊下設置）: pattern2 と同じブロック（予定／呼び出し／来校者／鉄道／人感センサ／時事ニュース
 *   ＋ 天気／広告）。時事ニュースは最下段フッタに 1 件ずつ自動送りで常時表示する（2026-06-22 再導入。要約優先＋
 *   不足時のみ見出し補完で鮮度を保つ・#1156）。違いは盤面レイアウト（廊下の「遠目・一瞥」向けの拡大タイポ／
 *   時刻主役ヘッダー／今日強調／週間天気帯／鉄道・センサ・ニュースのフッタ集約）で、`PATTERN_BOARDS` の
 *   `Pattern3Board` がデザイン層を差し替える。
 * - **pattern4**（教員入力最小）: **天気・ニュースを主役**の自動コンテンツに据え、教員が入力するのは
 *   **連絡（フリーワード）のみ**。それ以外は全自動／API（防災・安全＝条件付き／鉄道／人感センサ／広告）で
 *   教員入力ゼロ（2026-06-20 ユーザー確定）。**予定・呼び出し・来校者・提出物は持たない**（教員入力を要する
 *   ブロックは連絡を除き載せない）＝pattern4 だけは「全パターン共通の主役 schedule」を持たない例外
 *   （`Pattern4Board` がレイアウトを担う）。pattern3（教員入力前提の廊下運用）と対になる「自動寄り」の盤面。
 *
 * 時事ニュース（news・ADR-043）は鉄道（train）と同じシステム供給の自動ブロックで、**pattern2／pattern3／
 * pattern4** に出す（pattern1 は対象外）。防災・安全（safety_alert・ADR-044）は **pattern1／pattern4** が出す
 * （いずれもアクティブ時のみ条件付き描画）。
 *
 * 新パターンはここに 1 行追加するだけで全消費者が追従する（finding①「宣言的マッピングで一括駆動」）。
 */
export const PATTERN_BLOCKS: Record<SignageDesignPattern, readonly SignageBlockKind[]> = {
  // safety_alert（防災・安全）は安全情報なので先頭（盤面では予定の直上＝最も目立つ位置）。アクティブな
  // 警報/熱中症がある時だけ条件付きで描画する（無い時は帯ごと出さない・fail-soft、ADR-044）。
  pattern1: ["safety_alert", "schedule", "notice", "assignment", "weather", "ad"],
  pattern2: ["schedule", "callout", "visitor", "train", "presence", "news", "weather", "ad"],
  // pattern3（廊下）は pattern2 と同じブロック。時事ニュース（news）は最下段のフッタ帯に 1 件ずつ自動切替で
  // 常時表示する（2026-06-22 ユーザー確定で再導入）。デザイン層（拡大タイポ／週間天気帯／罫線区切り／鉄道・センサ・
  // ニュースのフッタ集約）は Pattern3Board が担う。
  pattern3: ["schedule", "callout", "visitor", "train", "presence", "news", "weather", "ad"],
  // pattern4（教員入力最小）: 天気・ニュースを主役に、教員入力は連絡（notice・フリーワード）のみ。防災・安全は
  // 条件付きで先頭、その後 天気→ニュース→連絡→鉄道→人感センサ、広告は末尾。schedule/callout/visitor/assignment
  // は教員入力を要するため**載せない**（editableBlocksForPattern→[notice] のみ。2026-06-20 ユーザー確定）。
  pattern4: ["safety_alert", "weather", "news", "notice", "train", "presence", "ad"],
};

/**
 * パターンの表示ブロック一覧（順序付き）を返す。未知パターン（型外の値が来た場合の保険）は既定
 * `pattern1` のブロックに倒す（fail-soft・盤面を壊さない。`design-pattern` の解決と同じ作法）。
 */
export function blocksForPattern(pattern: SignageDesignPattern): readonly SignageBlockKind[] {
  return PATTERN_BLOCKS[pattern] ?? PATTERN_BLOCKS[DEFAULT_SIGNAGE_DESIGN_PATTERN];
}

/** ブロックが教員の編集対象か（{@link SIGNAGE_BLOCK_META} の `editable` を引く）。 */
export function isEditableBlock(kind: SignageBlockKind): boolean {
  return SIGNAGE_BLOCK_META[kind].editable;
}

/**
 * パターンが盤面に出す**編集対象ブロック**を順序付きで返す（エディタ／AI アシスタントの出し分け用）。
 * 例: pattern1 → `[schedule, notice, assignment]`、pattern2 → `[schedule, callout, visitor]`。
 */
export function editableBlocksForPattern(
  pattern: SignageDesignPattern,
): readonly SignageBlockKind[] {
  return blocksForPattern(pattern).filter(isEditableBlock);
}

/**
 * パターンの盤面が当該ブロックを出すか。データ層の取得ゲート（pattern2 専用ブロックを pattern1 で取得
 * しない）や盤面の出し分けに使う。
 */
export function patternIncludesBlock(
  pattern: SignageDesignPattern,
  kind: SignageBlockKind,
): boolean {
  return blocksForPattern(pattern).includes(kind);
}

/**
 * **パターン × 編集ブロック → エディタの「空行事前生成数（＝盤面に出る規定枠の目安）」の単一ソース**。
 *
 * **全パターンのエディタ**がこの値を引き、各編集ブロックを**空行でこの数まで事前生成**する（教員が「盤面に出る枠」を
 * 入力前から把握できる・2026-06-23 ユーザー要望）。これが本定数の**普遍的な consumer**（`WysiwygBoardEditor` /
 * `VisitorsCalloutsSection` が `blockRowCapacity(pattern, kind)` を引く）。
 *
 * 一方**盤面側**でこの値を「固定表示行数（規定枠＋超過は自動スクロール）」として引くのは現状 **pattern1 のみ**
 * （`SignageBoardView`）。pattern2 の盤面は #1179（PR-B）以降 **自然高さ＋JS AutoScroll** で固定枠を持たないため、
 * `blockRowCapacity("pattern2", …)` は**盤面の行キャップではなくエディタ事前生成だけ**を駆動する（pattern3 盤面は
 * 独自の `P3_*_VISIBLE_ROWS`、pattern4 連絡はフロー＋スクロールで、いずれも盤面側では本定数を引かない）。盤面側の旧
 * ハードコード（pattern1 の `MIN_ROWS` / pattern3 の `P3_*_VISIBLE_ROWS` / CSS の `--p3-*-visible`）を後続でこの
 * 定数へ寄せ二重管理を排す方針は維持する。
 *
 * - `schedule` は **1 日（1 列）あたり**の行数（列数＝表示日数は別ソース `SIGNAGE_SCHEDULE_DAY_COUNT`）。
 * - `notice` / `assignment` / `callout` / `visitor` は件数。
 * - **パターンが出さないブロックは持たない**（= 事前生成も盤面枠も無し。{@link PATTERN_BLOCKS} の editable 集合と一致）。
 *
 * 値はすべて **5**（2026-06-23 ユーザー確定。本番 pattern1/pattern3 の実表示行数に合わせ、pattern2／pattern4 連絡の
 * エディタ事前生成も 5 に揃える）。将来パターン追加＝ここに 1 行で全消費者（エディタ・pattern1 盤面）が追従。
 */
export const PATTERN_BLOCK_ROW_CAPACITY: Record<
  SignageDesignPattern,
  Partial<Record<SignageBlockKind, number>>
> = {
  pattern1: { schedule: 5, notice: 5, assignment: 5 },
  // pattern2: 盤面は #1179 以降 自然高さ＋JS AutoScroll で固定枠を持たない＝この値はエディタの空行事前生成のみを
  // 駆動する（盤面の行キャップではない）。同ブロック構成の pattern3 と件数を揃える。
  pattern2: { schedule: 5, callout: 5, visitor: 5 },
  pattern3: { schedule: 5, callout: 5, visitor: 5 },
  pattern4: { notice: 5 },
};

/**
 * パターン × ブロックのエディタ空行事前生成数（pattern1 盤面では固定表示行数も兼ねる・上記参照）。当該パターンが
 * そのブロックを出さない場合は `0`（事前生成しない／盤面の固定枠も無い）。未知パターンは既定 `pattern1` に
 * フォールバックする（fail-soft・他ヘルパと同作法）。
 */
export function blockRowCapacity(pattern: SignageDesignPattern, kind: SignageBlockKind): number {
  const table =
    PATTERN_BLOCK_ROW_CAPACITY[pattern] ??
    PATTERN_BLOCK_ROW_CAPACITY[DEFAULT_SIGNAGE_DESIGN_PATTERN];
  return table[kind] ?? 0;
}
