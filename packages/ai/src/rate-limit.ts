/**
 * F03 レート制限: school_id あたり 1 分 60 リクエスト（NFR06 コスト方針）。
 *
 * `nowMs` を引数で受け取り内部時計を持たないため、テストで決定的に検証できる（`Date.now()` を
 * 注入する）。固定ウィンドウ方式: ウィンドウ開始からの経過が `windowMs` を超えたらカウンタを
 * リセットする。
 *
 * スコープ注意: このインメモリ実装は **単一プロセス内**でのみ正確。Cloud Run の複数インスタンス
 * 構成では school 単位の全体上限を保証できないため、本番では共有ストア版（ADR-027 採択 = Cloud SQL
 * カウンタ行）を `DistributedRateLimiter` 経由で差し込む（[./rate-limit-distributed.ts]）。
 * インターフェイスを切ってあるのはその差し替えを呼び出し側 (`structureContent`) に波及させないため。
 *
 * 戻り値は `Promise<boolean> | boolean` (Awaitable)。インメモリ版は同期で `boolean` を返し、
 * 共有ストア版（SQL 発行）は `Promise<boolean>` を返す。呼び出し側は `await` するだけで両実装を
 * そのまま扱える（依存逆転の維持、ADR-027 §決定）。
 */

export interface RateLimiter {
  /** `key`（school_id 等）で 1 リクエスト試行。許可なら true を返し 1 消費する。 */
  tryAcquire(key: string, nowMs: number): Promise<boolean> | boolean;
}

interface WindowState {
  windowStart: number;
  count: number;
}

export class FixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, WindowState>();

  /**
   * @param limit    1 ウィンドウあたりの最大リクエスト数（F03 は 60）。
   * @param windowMs ウィンドウ幅ミリ秒（F03 は 60_000）。
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  tryAcquire(key: string, nowMs: number): boolean {
    const state = this.windows.get(key);
    if (state === undefined || nowMs - state.windowStart >= this.windowMs) {
      this.windows.set(key, { windowStart: nowMs, count: 1 });
      return true;
    }
    if (state.count >= this.limit) return false;
    state.count += 1;
    return true;
  }
}

/** F03 既定（60 req / 60 秒 / school_id）のレートリミッタを生成する。 */
export function createPerSchoolRateLimiter(): RateLimiter {
  return new FixedWindowRateLimiter(60, 60_000);
}
