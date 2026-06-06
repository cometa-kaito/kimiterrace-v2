/**
 * `@kimiterrace/ui` 公開バレル。
 *
 * 段1（横断基盤）の presentational プリミティブのみ。interactive 系（Button / Toast /
 * ConfirmDialog / FormField / DataTable / useUnsavedGuard）は後続 PR で追加する。
 */
export { StatusBadge } from "./StatusBadge";
export type { BadgeTone } from "./StatusBadge";
export { EmptyState } from "./EmptyState";
export { Card } from "./Card";
export * as tokens from "./tokens";
