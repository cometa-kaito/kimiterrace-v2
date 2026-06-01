/**
 * #234 (#48-M follow-up): guide 匿名フィードバック投稿 `POST /api/guide/feedback` の濫用対策。
 *
 * `/api/guide/feedback` は **非認証の公開エンドポイント** で、SECURITY DEFINER `submit_feedback`
 * 経由で誰でも 1 行 INSERT できる。閲覧は `system_admin_only` RLS で守られるが、書込側に上限が
 * 無いとスパム投稿・大量 INSERT で feedback テーブルが汚染されうる (PR #227 Reviewer Low-2)。
 * ここでは IP 単位の固定ウィンドウ制限を application 層に置き、casual な spam / bot / 二重送信を
 * 抑える。
 *
 * **スコープと限界 (正直に明記)**:
 * - **per-instance のみ**: 状態は module-level の Map で Cloud Run の 1 インスタンス内に閉じる。
 *   複数インスタンス構成では IP 単位の全体上限を跨インスタンスで保証できない。F03 の
 *   {@link https://github.com/cometa-kaito/kimiterrace-v2/issues/155 分散レート制限 (#155)} と同型の
 *   共有ストア版が本番グローバル制限には要る。インメモリ版は単一プロセス / 単純濫用への第一防壁。
 * - **XFF は client が詐称しうる**: `x-forwarded-for` の左端 (client IP) は client が前置できるため、
 *   key を回す determined な攻撃者は per-IP 制限を回避できる。**ハードな保証は Cloud Armor / WAF
 *   等の infra 層** (#234 のもう一つの対応案) が担う。本 limiter は naive な単一 IP flood と
 *   accidental な二重送信を止める defense-in-depth であって、それ単体の砦ではない。
 *
 * F03 `packages/ai/src/rate-limit.ts` と同じ固定ウィンドウ算法だが、AI パッケージ (Vertex 依存) を
 * web の単純な公開エンドポイントへ結合させないため、ここに自己完結で持つ。`nowMs` を引数で受け
 * 内部時計を持たないので、テストで決定的に検証できる (`Date.now()` を注入する)。
 */

/**
 * 追跡 key 数の既定上限。これを超えると `tryAcquire` が新規 key 追加前に期限切れ窓を一掃し、
 * なお上限なら最古窓から間引いて Map を上限内に保つ (下記メモリ DoS 対策を参照)。
 */
export const DEFAULT_MAX_KEYS = 50_000;

/**
 * 固定ウィンドウ・レートリミッタ (key 単位)。`nowMs` 注入でテスト決定的。
 *
 * **メモリ境界 (公開エンドポイントの DoS 対策)**: key は client IP 等の **詐称可能**な値で、
 * 攻撃者は毎リクエストでユニークな key を送って `windows` Map を無制限に肥大化させ得る
 * (期限切れ窓も次回同一 key アクセスが無ければ自然解放されない)。これを `maxKeys` で上限化する:
 * 新規 key 追加時に上限へ達していれば、まず期限切れ窓 (windowMs 経過) を一掃し、それでも上限なら
 * 最古 windowStart の窓から間引く。これにより flood 下でも Map サイズは常に `maxKeys` 以内に収まる
 * (per-instance のメモリ枯渇を防ぐ defense-in-depth。volume 自体の遮断は WAF / Cloud Armor が担う)。
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { windowStart: number; count: number }>();

  /**
   * @param limit    1 ウィンドウあたりの最大リクエスト数。
   * @param windowMs ウィンドウ幅ミリ秒。
   * @param maxKeys  追跡 key 数の上限 (メモリ境界、既定 {@link DEFAULT_MAX_KEYS})。
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = DEFAULT_MAX_KEYS,
  ) {}

  /** `key` で 1 リクエスト試行。許可なら true を返し 1 消費する。超過なら false。 */
  tryAcquire(key: string, nowMs: number): boolean {
    const state = this.windows.get(key);
    // 同一 key の有効ウィンドウ内: in-place 更新のみ (Map は増えない)。
    if (state !== undefined && nowMs - state.windowStart < this.windowMs) {
      if (state.count >= this.limit) return false;
      state.count += 1;
      return true;
    }
    // 新規 key の追加で Map が増える場合のみメモリ境界を維持する (期限切れ窓の作り直しは増えない)。
    if (state === undefined && this.windows.size >= this.maxKeys) {
      this.evictToBound(nowMs);
    }
    this.windows.set(key, { windowStart: nowMs, count: 1 });
    return true;
  }

  /**
   * Map を `maxKeys` 未満に収める。まず期限切れ窓 (windowMs 経過) を一掃 (flood の大半はここで回収)、
   * それでも上限なら最古 windowStart の窓から新規 1 件分の空きができるまで間引く。
   */
  private evictToBound(nowMs: number): void {
    for (const [k, s] of this.windows) {
      if (nowMs - s.windowStart >= this.windowMs) this.windows.delete(k);
    }
    if (this.windows.size < this.maxKeys) return;
    // 期限内窓だけで上限 = 同一ウィンドウ内に maxKeys 超のユニーク key (flood)。最古から間引く。
    const oldestFirst = Array.from(this.windows.entries()).sort(
      (a, b) => a[1].windowStart - b[1].windowStart,
    );
    const removeCount = this.windows.size - this.maxKeys + 1;
    for (const [k] of oldestFirst.slice(0, removeCount)) {
      this.windows.delete(k);
    }
  }

  /** 現在追跡している key 数 (運用監視 / テスト用)。常に `maxKeys` 以内。 */
  size(): number {
    return this.windows.size;
  }

  /** 全ウィンドウ状態を破棄する (テストの隔離 / 運用リセット用)。 */
  reset(): void {
    this.windows.clear();
  }
}

/**
 * リクエストヘッダから rate-limit の key となる client 識別子を取り出す。
 *
 * Cloud Run / GFE は client IP を `x-forwarded-for` の左端に載せる。複数ホップは `, ` 区切りで
 * 連なるため先頭要素を採る。`x-real-ip` を次点フォールバックにし、いずれも無ければ定数
 * `"unknown"` に倒す (**fail toward limiting**: IP 不明な全リクエストが 1 バケットを共有し、
 * 無制限にはならない)。左端 XFF は client が詐称しうる点は本モジュール docstring 参照。
 */
export function clientKeyFromHeaders(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

/**
 * guide フィードバックの既定上限: 1 IP あたり 10 分で 20 件。
 *
 * フィードバック投稿は低頻度な意図的アクションのため、共有 NAT 越しに複数の教員が同一セッション内で
 * 送っても 20/10min を超えることは稀。一方で単純な spam ループ (毎秒投稿) は確実に頭打ちになる。
 * 値はチューニング容易なよう定数に切り出す。
 */
export const GUIDE_FEEDBACK_LIMIT = 20;
export const GUIDE_FEEDBACK_WINDOW_MS = 10 * 60 * 1000;

/**
 * guide エンドポイント用の module-level シングルトン。module スコープに置くことで Cloud Run の
 * 同一インスタンス内の複数リクエストで状態を共有する (per-instance、上記の限界どおり)。
 */
export const guideFeedbackRateLimiter = new FixedWindowRateLimiter(
  GUIDE_FEEDBACK_LIMIT,
  GUIDE_FEEDBACK_WINDOW_MS,
);
