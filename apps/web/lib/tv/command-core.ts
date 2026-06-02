// 型・定数は **client-safe な /schema サブパス** や enum 由来の値域から組み立てる。barrel
// (`@kimiterrace/db`) は client.ts 経由で postgres を引き込み、"use client" 制御にバンドルされると
// next build が落ちる（config-edit-core.ts と同じ #148 の罠）。本ファイルは型と純粋ロジックのみで
// postgres を含まない（コマンド種別の許可値は下記 satisfies で enum とズレないことを保証する）。
import type { TvCommandType } from "@kimiterrace/db/schema";

/**
 * F15 §4.2 (ADR-022): TV リモートコマンド発行の純粋ロジック・型・定数・検証。
 *
 * `"use server"` ファイル (command-actions.ts) は async 関数しか export できない Next の制約のため、
 * 検証・型・定数・ラベルはここに分離する（config-edit-core.ts と同じ構成）。client の発行ボタンも
 * ここから許可値・ラベルを import できる（postgres を引き込まない）。
 */

export {
  type ActionResult,
  type TvConfigEditActor as TvCommandActor,
  forbidden,
  invalid,
  notFound,
  isUuid,
  toTvConfigEditActor as toTvCommandActor,
} from "./config-edit-core";

/**
 * UI から発行できるコマンド種別と日本語ラベル（F15 §4.2 の確定値）。`satisfies Record<TvCommandType, ...>`
 * で **DB enum の全値を網羅し、かつ余剰キーを持たない**ことをコンパイル時に強制する（enum を末尾追加
 * したらここもコンパイルエラーで気付ける = ルール3 の値域単一ソース）。順序は UI のボタン並びに使う。
 */
export const TV_COMMAND_LABELS = {
  signage_reload: "サイネージリロード",
  signage_open: "サイネージ強制起動",
  signage_exit: "サイネージ強制終了",
  service_restart: "サービス再起動",
} as const satisfies Record<TvCommandType, string>;

/** 発行可能なコマンド種別（ボタン並び順）。enum 全値を列挙する。 */
export const TV_COMMAND_ORDER: readonly TvCommandType[] = [
  "signage_reload",
  "signage_open",
  "signage_exit",
  "service_restart",
];

/**
 * 受け取った値が許可コマンド種別か（クライアント自由入力の検証）。`Object.hasOwn` で **自身のキー**のみ
 * 判定し、`in` 演算子の prototype チェーン誤判定（"toString" 等を真と誤認）を避ける。
 */
export function isTvCommandType(value: unknown): value is TvCommandType {
  return typeof value === "string" && Object.hasOwn(TV_COMMAND_LABELS, value);
}

/** コマンド状態の日本語ラベル（履歴表示）。enum の全状態を網羅。 */
export const TV_COMMAND_STATUS_LABELS = {
  pending: "送信待ち",
  delivered: "配信済み",
  failed: "失敗",
  expired: "期限切れ",
} as const;
