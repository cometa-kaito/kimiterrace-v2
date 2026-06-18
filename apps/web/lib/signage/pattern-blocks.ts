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
  | "news" // 工学ニュース（外部取得キャッシュの見出し+出典・ADR-043）
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
  news: { label: "工学ニュース", editable: false, hasRegion: true },
  weather: { label: "天気", editable: false, hasRegion: false },
  ad: { label: "広告", editable: false, hasRegion: false },
};

/**
 * **パターン → 表示ブロック（順序付き）の単一ソース**。配列の順序は盤面の主要コンテンツ読み順に合わせ、
 * `editableBlocksForPattern` が返す編集セクションの並びもこれに従う（教員が盤面と同じ順で編集できる）。
 * 自動ブロック（weather／ad）は編集フローの末尾に置く。
 *
 * - **pattern1**（既定・v1 レイアウト）: 予定／連絡／提出物 ＋ 天気（予定内包）／広告。
 * - **pattern2**（掲示盤面）: 予定／生徒呼び出し／来校者一覧／鉄道／人感センサ／工学ニュース ＋ 天気／広告。
 * - **pattern3**（廊下設置）: **pattern2 と同一ブロック・同一順序**（先方リクエストの確定コンテンツを維持）。
 *   違いは盤面レイアウトのみ＝廊下の「遠目・一瞥」に合わせた拡大タイポ／時刻主役ヘッダー／今日強調で、
 *   出すブロックは変えない（`PATTERN_BOARDS` の `Pattern3Board` がデザイン層だけ差し替える）。
 *
 * 工学ニュース（news・ADR-043）は鉄道（train）と同じシステム供給の自動ブロックで、pattern2/3 のみに出す
 * （pattern1 は対象外）。
 *
 * 新パターンはここに 1 行追加するだけで全消費者が追従する（finding①「宣言的マッピングで一括駆動」）。
 */
export const PATTERN_BLOCKS: Record<SignageDesignPattern, readonly SignageBlockKind[]> = {
  pattern1: ["schedule", "notice", "assignment", "weather", "ad"],
  pattern2: ["schedule", "callout", "visitor", "train", "presence", "news", "weather", "ad"],
  // pattern3（廊下）は pattern2 と同一ブロック（内容据え置き・デザインのみ最適化）。
  pattern3: ["schedule", "callout", "visitor", "train", "presence", "news", "weather", "ad"],
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
