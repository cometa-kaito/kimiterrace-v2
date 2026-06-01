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
 *
 * **メモリ境界（#437 Low-4、公開エンドポイント DoS 対策）**: magic_link / cookie キーは詐称可能で、
 * 攻撃者は毎リクエストでユニークなキーを送り `byMagicLink` / `byCookie` Map を無制限に肥大化させ得る
 * （期限切れ窓も次回同一キーアクセスが無ければ自然解放されない）。各 Map を `maxKeys` で上限化する
 * （`guide/rate-limit.ts` の {@link FixedWindowRateLimiter}（#436）と同型の eviction）。新規キー追加で
 * 上限へ達したら、まず期限切れ窓を一掃し、なお上限なら最古窓から間引く。flood 下でも各 Map は常に
 * `maxKeys` 以内（per-instance のメモリ枯渇を防ぐ。volume 自体の遮断は WAF / Cloud Armor が担う）。
 */

/** 1 分あたりの質問上限（magic_link / cookie それぞれ）。 */
export const QA_QUESTION_LIMIT = 10;
/** ウィンドウ幅（ミリ秒）。1 分固定ウィンドウ。 */
export const QA_QUESTION_WINDOW_MS = 60 * 1000;
/** 各 Map（magic_link / cookie）の追跡キー数上限（メモリ境界、#437 Low-4）。`guide` の DEFAULT_MAX_KEYS と同値。 */
export const QA_MAX_KEYS = 50_000;

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
   * @param maxKeys  各 Map の追跡キー数上限（メモリ境界、既定 {@link QA_MAX_KEYS}）。
   */
  constructor(
    private readonly limit: number = QA_QUESTION_LIMIT,
    private readonly windowMs: number = QA_QUESTION_WINDOW_MS,
    private readonly maxKeys: number = QA_MAX_KEYS,
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

  /** 各 Map の追跡キー数（運用監視 / テスト用）。いずれも常に `maxKeys` 以内。 */
  sizes(): { magicLink: number; cookie: number } {
    return { magicLink: this.byMagicLink.size, cookie: this.byCookie.size };
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
      // 新規キー追加で Map が増える場合のみメモリ境界を維持する（#437 Low-4）。
      // 既存キーの期限切れ→新ウィンドウ作り直しは Map サイズを増やさないため対象外。
      if (w === undefined && map.size >= this.maxKeys) {
        this.evictToBound(map, nowMs);
      }
      map.set(key, { windowStart: nowMs, count: 1 });
      return;
    }
    w.count += 1;
  }

  /**
   * `map` を `maxKeys` 未満に収める（#437 Low-4、{@link FixedWindowRateLimiter} と同型）。
   * まず期限切れ窓（windowMs 経過）を一掃（flood の大半はここで回収）、それでも上限なら最古
   * windowStart の窓から新規 1 件分の空きができるまで間引く。
   */
  private evictToBound(map: Map<string, Window>, nowMs: number): void {
    for (const [k, s] of map) {
      if (nowMs - s.windowStart >= this.windowMs) map.delete(k);
    }
    if (map.size < this.maxKeys) return;
    // 期限内窓だけで上限 = 同一ウィンドウ内に maxKeys 超のユニークキー（flood）。最古から間引く。
    const oldestFirst = Array.from(map.entries()).sort(
      (a, b) => a[1].windowStart - b[1].windowStart,
    );
    const removeCount = map.size - this.maxKeys + 1;
    for (const [k] of oldestFirst.slice(0, removeCount)) {
      map.delete(k);
    }
  }
}

/**
 * 生徒 Q&A 用 module-level シングルトン。module スコープに置くことで同一インスタンス内の複数
 * リクエストで状態を共有する（per-instance、上記の限界どおり）。
 */
export const studentQaRateLimiter = new StudentQaRateLimiter();
