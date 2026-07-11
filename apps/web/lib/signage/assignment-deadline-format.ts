/**
 * サイネージ盤面「提出物」の**期日表示形式**（学校別設定・#1258 教員フィードバック対応③）。
 *
 * - `daysLeft`（既定）: 残り日数ラベル（あと3日 / 今日 / 明日 / N日超過）。従来表示＝完全互換。
 * - `until`: 日付ベース（`M/Dまで`・当日は「今日まで」・超過は従来どおり `N日超過`）。
 *
 * 保存先は `school_configs`（scope='school', kind='display_settings'）の `value.assignmentDeadlineFormat`
 * （JSONB へのキー追加のみ＝migration 不要）。同じ行の `signageDesign` / `editorDayCutover` と相乗りする。
 *
 * **client-safe（postgres 非依存）**: `design-pattern.ts` と同じ規約で、"use client" な設定フォームと
 * server の payload ビルダーの両方から import できる純粋モジュールに保つ。DB 読み書きは
 * `signage-design.ts`（読み）/ `display-settings-actions.ts`（書き）側に置く。未知値・形不正はすべて
 * 既定 `daysLeft` に倒す（fail-soft、盤面を壊さない）。
 */

export const ASSIGNMENT_DEADLINE_FORMATS = ["daysLeft", "until"] as const;

export type AssignmentDeadlineFormat = (typeof ASSIGNMENT_DEADLINE_FORMATS)[number];

/** 未設定・不正値時の既定（従来の残り日数ラベル表示＝後方互換）。 */
export const DEFAULT_ASSIGNMENT_DEADLINE_FORMAT: AssignmentDeadlineFormat = "daysLeft";

/** 設定 UI（学校管理のラジオ）に出す表示ラベル。 */
export const ASSIGNMENT_DEADLINE_FORMAT_LABELS: Record<AssignmentDeadlineFormat, string> = {
  daysLeft: "残り日数（あと3日 / 今日 / 明日）",
  until: "日付（7/15まで）",
};

/** 文字列が既知の期日表示形式か型ガードする。 */
export function isAssignmentDeadlineFormat(value: unknown): value is AssignmentDeadlineFormat {
  return (
    typeof value === "string" && (ASSIGNMENT_DEADLINE_FORMATS as readonly string[]).includes(value)
  );
}

/**
 * `display_settings` config の `value`（JSONB, opaque）から `assignmentDeadlineFormat` を **defensive に**
 * 取り出す。形が想定外・キー欠落・未知値はいずれも既定 `daysLeft` に倒す（fail-soft、
 * `parseSignageDesignPattern` と同作法）。
 */
export function parseAssignmentDeadlineFormat(configValue: unknown): AssignmentDeadlineFormat {
  if (configValue && typeof configValue === "object" && !Array.isArray(configValue)) {
    const v = (configValue as Record<string, unknown>).assignmentDeadlineFormat;
    if (isAssignmentDeadlineFormat(v)) {
      return v;
    }
  }
  return DEFAULT_ASSIGNMENT_DEADLINE_FORMAT;
}
