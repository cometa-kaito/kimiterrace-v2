/**
 * F06 (#42 第1スライス): 生徒 Q&A の **二重キー・レートリミット**。
 *
 * 受け入れ条件: 「magic_link あたり 1 分 10 質問、1 端末 cookie あたり 1 分 10 質問」。
 * 2 つの独立した上限（magic_link 単位・cookie 単位）を **両方満たしたときだけ**許可する。
 *
 * `apps/web/lib/guide/rate-limit.ts` の単一キー {@link
 * file://../guide/rate-limit.ts FixedWindowRateLimiter} と同じ固定ウィンドウ算法だが、
 * **check-then-commit を原子的に行う**点が異なるため自己完結で実装する: 片方のゲートが超過した
 * とき、もう片方のスロットを誤って消費しない（cross-gate のスロット漏れを防ぐ）。両ゲートが
 * 通る場合のみ両方を 1 消費する。`nowMs` は注入式でテスト決定的（内部時計を持たない）。
 *
 * **スコープと限界（正直に明記）**: 状態は module-level の Map で Cloud Run の 1 インスタンス内に
 * 閉じる **per-instance** 制限。複数インスタンス構成での全体上限は #155（分散レート制限・共有
 * ストア）が要る。本 limiter は単一プロセス内の濫用・暴走への第一防壁（defense-in-depth）。
 */

/** 1 分あたりの質問上限（magic_link / cookie それぞれ）。 */
export const QA_QUESTION_LIMIT = 10;
/** ウィンドウ幅（ミリ秒）。1 分固定ウィンドウ。 */
export const QA_QUESTION_WINDOW_MS = 60 * 1000;

/** {@link StudentQaRateLimiter.tryAcquire} の結果。`blockedBy` で超過ゲートを機械判別する。 */
export type QaRateResult =
  | { allowed: true }
  | { allowed: false; blockedBy: "magic_link" | "cookie" };

interface Window {
  windowStart: number;
  count: number;
}

/**
 * magic_link 単位・cookie 単位の 2 ゲートを原子的に評価する固定ウィンドウ・レートリミッタ。
 */
export class StudentQaRateLimiter {
  private readonly byMagicLink = new Map<string, Window>();
  private readonly byCookie = new Map<string, Window>();

  /**
   * @param limit    各ゲートの 1 ウィンドウあたり上限（既定 {@link QA_QUESTION_LIMIT}）。
   * @param windowMs ウィンドウ幅ミリ秒（既定 {@link QA_QUESTION_WINDOW_MS}）。
   */
  constructor(
    private readonly limit: number = QA_QUESTION_LIMIT,
    private readonly windowMs: number = QA_QUESTION_WINDOW_MS,
  ) {}

  /**
   * `magicLinkId` と `cookieId` の両ゲートを評価する。両方が上限未満のときだけ両方を 1 消費して
   * `allowed: true` を返す。いずれかが上限なら **何も消費せず** `allowed: false` と超過ゲートを返す
   * （magic_link を先に判定）。
   */
  tryAcquire(params: { magicLinkId: string; cookieId: string; nowMs: number }): QaRateResult {
    const { magicLinkId, cookieId, nowMs } = params;
    // 先に「消費せず」両ゲートの残量を確認する（check）。
    if (!this.hasCapacity(this.byMagicLink, magicLinkId, nowMs)) {
      return { allowed: false, blockedBy: "magic_link" };
    }
    if (!this.hasCapacity(this.byCookie, cookieId, nowMs)) {
      return { allowed: false, blockedBy: "cookie" };
    }
    // 両ゲート OK のときだけ両方を消費する（commit）。
    this.consume(this.byMagicLink, magicLinkId, nowMs);
    this.consume(this.byCookie, cookieId, nowMs);
    return { allowed: true };
  }

  /** 全状態を破棄（テスト隔離 / 運用リセット）。 */
  reset(): void {
    this.byMagicLink.clear();
    this.byCookie.clear();
  }

  /** `key` が現ウィンドウで 1 件以上消費できるか（消費しない）。期限切れウィンドウは満充電扱い。 */
  private hasCapacity(map: Map<string, Window>, key: string, nowMs: number): boolean {
    const w = map.get(key);
    if (w === undefined || nowMs - w.windowStart >= this.windowMs) return true;
    return w.count < this.limit;
  }

  /** `key` を 1 消費する。期限切れ/未登録は新ウィンドウを開始する。 */
  private consume(map: Map<string, Window>, key: string, nowMs: number): void {
    const w = map.get(key);
    if (w === undefined || nowMs - w.windowStart >= this.windowMs) {
      map.set(key, { windowStart: nowMs, count: 1 });
      return;
    }
    w.count += 1;
  }
}

/**
 * 生徒 Q&A 用 module-level シングルトン。module スコープに置くことで同一インスタンス内の複数
 * リクエストで状態を共有する（per-instance、上記の限界どおり）。
 */
export const studentQaRateLimiter = new StudentQaRateLimiter();
