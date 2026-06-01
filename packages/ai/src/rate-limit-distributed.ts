/**
 * F03 分散レート制限（ADR-027 採択）。
 *
 * 単一プロセス内のみ正確な `FixedWindowRateLimiter` を、Cloud Run 複数インスタンス間で
 * 整合させるための共有ストア版アダプタ。実ストアの SQL 発行 (`INSERT ... ON CONFLICT DO UPDATE
 * WHERE count < limit RETURNING`) は ADR-027 §テーブル設計が拘束する。本ファイル
 * （`packages/ai`）は **DB 非依存** で、ストアの原子性のみ要求する `RateLimitStore` インターフェイス
 * を切り、follow-up PR (#155-B) の `PostgresRateLimitStore`（`packages/db` 側）で実装する。
 *
 * 設計判断:
 *
 * - 既存 `RateLimiter` インターフェイス (`./rate-limit.ts`) の戻り型を `Awaitable<boolean>` に
 *   拡張済。`DistributedRateLimiter` は `Promise<boolean>` を返し、`FixedWindowRateLimiter` は
 *   従来どおり同期 `boolean` を返す。呼び出し側 `structureContent` は `await tryAcquire(...)` の
 *   1 行変更でどちらの実装も透過に扱える（依存逆転の維持、ADR-027 §決定）。
 * - 固定ウィンドウ開始時刻は `Math.floor(nowMs / windowMs) * windowMs` で決定論的に計算し、
 *   テストで `nowMs` を注入できる（既存 inmem 版と同じ規律）。`Date.now()` を内部で読まない。
 * - **ストア境界に原子性を要求する**: store.tryAcquireSlot は「WHERE count < limit を満たすときのみ
 *   インクリメントして allow を返す」契約。SELECT-then-UPDATE 競合は store 内部で吸収する責務
 *   （PG 実装は ADR-027 の RETURNING で原子化、テストは同期 mutex で擬似化）。
 */

/**
 * 共有ストア境界。`packages/ai` は DB に依存せず、この interface のみ要求する。
 *
 * 契約:
 * - `(key, windowStartMs)` をプライマリキーとするウィンドウ行に対して、`count < limit` のときのみ
 *   `count += 1` して true を返す。`count >= limit` なら何もせず false を返す。
 * - 同一 `(key, windowStartMs)` への並列呼び出しは直列化され、limit 超過は構造的に発生しないこと。
 *   PG 実装は ADR-027 の `INSERT ... ON CONFLICT DO UPDATE WHERE count < $limit RETURNING` で
 *   1 文原子化する。
 * - `windowStartMs` が異なれば独立カウンタとして扱う（ウィンドウ跨ぎでリセット）。
 *
 * 失敗時の throw は呼び出し側 `tryAcquire` を経由して `structureContent` に伝播し、
 * Vertex 呼び出しは行われない（fail-closed）。
 */
export interface RateLimitStore {
  /**
   * @param key            テナント識別子（通常 school_id の uuid 文字列）
   * @param windowStartMs  ウィンドウ開始時刻（epoch ms / windowMs を切り捨て）
   * @param limit          ウィンドウ当たりの最大リクエスト数
   * @returns              slot 取得に成功すれば true、上限到達で拒否なら false
   */
  tryAcquireSlot(key: string, windowStartMs: number, limit: number): Promise<boolean>;
}

import type { RateLimiter } from "./rate-limit.js";

/**
 * 共有ストア版レートリミッタ。
 *
 * 既存 `FixedWindowRateLimiter` と同じ固定ウィンドウ方式を、ストアに永続化することで複数
 * インスタンス間で共有する。`nowMs` から `windowStartMs` を算出し、ストアへ原子的な
 * インクリメント要求を投げる（ADR-027 §SQL 契約）。
 */
export class DistributedRateLimiter implements RateLimiter {
  /**
   * @param store     原子的な slot 取得を提供する共有ストア（PG / 等）
   * @param limit     1 ウィンドウあたりの最大リクエスト数（F03 は 60）
   * @param windowMs  ウィンドウ幅ミリ秒（F03 は 60_000）
   */
  constructor(
    private readonly store: RateLimitStore,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(
        `DistributedRateLimiter: limit は正の整数である必要があります (got ${limit})`,
      );
    }
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      throw new Error(
        `DistributedRateLimiter: windowMs は正の整数である必要があります (got ${windowMs})`,
      );
    }
  }

  async tryAcquire(key: string, nowMs: number): Promise<boolean> {
    // 固定ウィンドウ: nowMs を windowMs で切り捨てて開始時刻にする。
    // 同一ウィンドウ内のリクエストは同じ windowStartMs を共有し、ストア側の (key, windowStartMs)
    // 行へ原子的に集約される。ウィンドウ跨ぎでは新規行が作られ、暗黙にカウンタリセットされる。
    const windowStartMs = Math.floor(nowMs / this.windowMs) * this.windowMs;
    return await this.store.tryAcquireSlot(key, windowStartMs, this.limit);
  }
}

/**
 * F03 既定の分散版（60 req / 60 秒 / school_id）を生成する。`createPerSchoolRateLimiter`
 * （インメモリ版、`./rate-limit.ts`）と対になる本番向けファクトリ。
 */
export function createPerSchoolDistributedRateLimiter(store: RateLimitStore): RateLimiter {
  return new DistributedRateLimiter(store, 60, 60_000);
}
