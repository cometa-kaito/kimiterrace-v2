import { describe, expect, it } from "vitest";
import {
  TV_COMMAND_LABELS,
  TV_COMMAND_ORDER,
  TV_COMMAND_STATUS_LABELS,
  isTvCommandType,
} from "../../lib/tv/command-core";

/**
 * F15 §4.2 (ADR-022): TV コマンド発行の純粋ロジック・定数の単体テスト。
 *
 * 重点: 許可コマンド種別の検証（クライアント自由入力の遮断）、ラベル/順序が enum 全値を網羅すること、
 * 状態ラベルの網羅。値域は DB enum を単一ソースとする（ルール3）。
 */
describe("command-core", () => {
  it("isTvCommandType: 既知コマンドのみ true、未知/非文字列は false", () => {
    expect(isTvCommandType("signage_reload")).toBe(true);
    expect(isTvCommandType("signage_open")).toBe(true);
    expect(isTvCommandType("signage_exit")).toBe(true);
    expect(isTvCommandType("service_restart")).toBe(true);
    expect(isTvCommandType("drop_table")).toBe(false);
    expect(isTvCommandType("")).toBe(false);
    expect(isTvCommandType(123)).toBe(false);
    expect(isTvCommandType(null)).toBe(false);
    // prototype 経由のキー（"toString" 等）を踏まないこと（in 演算子の落とし穴）。
    expect(isTvCommandType("toString")).toBe(false);
  });

  it("TV_COMMAND_ORDER は 4 種すべてを列挙し、各々にラベルがある", () => {
    expect(TV_COMMAND_ORDER).toEqual([
      "signage_reload",
      "signage_open",
      "signage_exit",
      "service_restart",
    ]);
    for (const c of TV_COMMAND_ORDER) {
      expect(typeof TV_COMMAND_LABELS[c]).toBe("string");
      expect(TV_COMMAND_LABELS[c].length).toBeGreaterThan(0);
    }
  });

  it("TV_COMMAND_STATUS_LABELS は全状態を網羅する", () => {
    expect(Object.keys(TV_COMMAND_STATUS_LABELS).sort()).toEqual([
      "delivered",
      "expired",
      "failed",
      "pending",
    ]);
  });
});
