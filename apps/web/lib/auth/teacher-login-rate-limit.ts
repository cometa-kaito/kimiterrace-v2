/**
 * ADR-032: 教員「学校共通パスワード」ログインの **失敗回数**レートリミッタ（総当たり抑止）。
 *
 * 共通パスワードは 1 校で共有のため、**多数の教員が同一 NAT（学校の公開 IP）から朝に一斉ログイン**しうる。
 * 全リクエストを数える固定ウィンドウだと正規の一斉ログインを誤ってブロックする。そこで本リミッタは
 * **失敗のみ**を IP 単位で数え、成功（正規ログイン）はカウントしない。連続失敗が閾値に達した IP だけを
 * 一時ブロックする（総当たりは失敗の連続なので確実に頭打ち、正規の一斉ログインは成功ゆえ素通り）。
 *
 * `nowMs` を引数注入し内部時計を持たない（テスト決定的）。状態は module-level Map で **per-instance**
 * （Cloud Run 1 インスタンス内）。分散・厳密上限は WAF / Cloud Armor が担う（guide/rate-limit と同じ限界）。
 * 短いパスワード（4 文字許容）の総当たり耐性は本リミッタ + infra 層 + パスワード長推奨で多層的に補う。
 */

export const TEACHER_LOGIN_MAX_FAILURES = 10;
export const TEACHER_LOGIN_WINDOW_MS = 5 * 60 * 1000;
export const TEACHER_LOGIN_MAX_KEYS = 50_000;

interface FailureWindow {
  windowStart: number;
  count: number;
}

/** 失敗回数の固定ウィンドウ・リミッタ（失敗のみ計上、成功は非計上）。 */
export class LoginFailureLimiter {
  private readonly windows = new Map<string, FailureWindow>();

  constructor(
    private readonly maxFailures: number = TEACHER_LOGIN_MAX_FAILURES,
    private readonly windowMs: number = TEACHER_LOGIN_WINDOW_MS,
    private readonly maxKeys: number = TEACHER_LOGIN_MAX_KEYS,
  ) {}

  /** `key` が現ウィンドウで失敗上限に達しているか（達していれば以後の試行をブロックすべき）。消費しない。 */
  isBlocked(key: string, nowMs: number): boolean {
    const w = this.windows.get(key);
    if (w === undefined || nowMs - w.windowStart >= this.windowMs) {
      return false;
    }
    return w.count >= this.maxFailures;
  }

  /** `key` の失敗を 1 件記録する（期限切れ/未登録は新ウィンドウを開始）。 */
  recordFailure(key: string, nowMs: number): void {
    const w = this.windows.get(key);
    if (w === undefined || nowMs - w.windowStart >= this.windowMs) {
      if (w === undefined && this.windows.size >= this.maxKeys) {
        this.evictToBound(nowMs);
      }
      this.windows.set(key, { windowStart: nowMs, count: 1 });
      return;
    }
    w.count += 1;
  }

  /** 成功時に `key` の失敗カウントを解除する（正規ログインでブロックを残さない）。 */
  clear(key: string): void {
    this.windows.delete(key);
  }

  reset(): void {
    this.windows.clear();
  }

  size(): number {
    return this.windows.size;
  }

  /** Map を maxKeys 未満に保つ（期限切れ一掃 → なお上限なら最古から間引く、guide/rate-limit と同型）。 */
  private evictToBound(nowMs: number): void {
    for (const [k, s] of this.windows) {
      if (nowMs - s.windowStart >= this.windowMs) this.windows.delete(k);
    }
    if (this.windows.size < this.maxKeys) return;
    const oldestFirst = Array.from(this.windows.entries()).sort(
      (a, b) => a[1].windowStart - b[1].windowStart,
    );
    const removeCount = this.windows.size - this.maxKeys + 1;
    for (const [k] of oldestFirst.slice(0, removeCount)) {
      this.windows.delete(k);
    }
  }
}

/** 教員ログイン用 module-level シングルトン（per-instance）。 */
export const teacherLoginFailureLimiter = new LoginFailureLimiter();
