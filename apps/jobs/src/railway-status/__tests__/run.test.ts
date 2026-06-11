import { describe, expect, it, vi } from "vitest";
import type { ParsedTrainStatus } from "../meitetsu.js";
import { runRailwayFetch } from "../run.js";

/**
 * 運行情報取得バッチのオーケストレーション（ADR-035）を、fetch/DB を注入して検証する。取得失敗・パース不能は
 * skip（last-known-good 維持・例外を投げない fail-soft）、成功時のみ upsert することを確認する。
 */
describe("runRailwayFetch", () => {
  const ok: ParsedTrainStatus = { hasDisruption: false, statusText: "平常運転" };

  it("取得成功: saveStatus を呼び updated=true を返す", async () => {
    const saveStatus = vi.fn(async () => {});
    const summary = await runRailwayFetch({
      fetchStatus: async () => ok,
      saveStatus,
    });
    expect(saveStatus).toHaveBeenCalledWith(ok);
    expect(summary).toEqual({ updated: true, hasDisruption: false, skippedReason: null });
  });

  it("乱れ時も upsert し hasDisruption=true を返す", async () => {
    const summary = await runRailwayFetch({
      fetchStatus: async () => ({ hasDisruption: true, statusText: "遅延が発生" }),
      saveStatus: async () => {},
    });
    expect(summary.updated).toBe(true);
    expect(summary.hasDisruption).toBe(true);
  });

  it("取得失敗（fetch が throw）: 書き込まず skippedReason=fetch_failed", async () => {
    const saveStatus = vi.fn(async () => {});
    const summary = await runRailwayFetch({
      fetchStatus: async () => {
        throw new Error("network");
      },
      saveStatus,
    });
    expect(saveStatus).not.toHaveBeenCalled();
    expect(summary).toEqual({ updated: false, hasDisruption: null, skippedReason: "fetch_failed" });
  });

  it("パース不能（fetch が null）: 書き込まず skippedReason=parse_failed", async () => {
    const saveStatus = vi.fn(async () => {});
    const summary = await runRailwayFetch({
      fetchStatus: async () => null,
      saveStatus,
    });
    expect(saveStatus).not.toHaveBeenCalled();
    expect(summary).toEqual({ updated: false, hasDisruption: null, skippedReason: "parse_failed" });
  });
});
