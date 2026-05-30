import { type App, getApp, getApps, initializeApp } from "firebase-admin/app";
import { type Auth, getAuth } from "firebase-admin/auth";

/**
 * firebase-admin (Identity Platform) App のシングルトン初期化。
 *
 * 認証経路は ADR-003 (Identity Platform を採用、session cookie 検証)。
 *
 * **認証情報の取得 (CLAUDE.md ルール5)**:
 * - 本番 (Cloud Run) は **Application Default Credentials (ADC) = Workload Identity** で
 *   メタデータサーバから取得する。`initializeApp()` を引数なしで呼ぶと ADC が使われる。
 * - **JSON キーファイルを配布・参照しない**。`GOOGLE_APPLICATION_CREDENTIALS` に
 *   キーファイルパスを設定する運用は採らない (ルール5 の NG パターン)。
 * - `projectId` は `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` 等の標準 env か ADC から解決される。
 *   公開値 (秘密ではない) のため env 経由で渡してよい。
 *
 * テスト容易性 (ADR-012):
 * - `getAdminAuth()` は内部キャッシュを返すだけの薄いラッパ。テストでは firebase-admin を
 *   `vi.mock` するか、`__setAdminAuthForTest()` で Auth を差し替える。
 */

let cachedAuth: Auth | null = null;

function initAdminApp(): App {
  // Next.js の HMR / 複数 import で多重初期化しないよう、既存 App があれば再利用する。
  if (getApps().length > 0) {
    return getApp();
  }

  // 明示的に証明書 (JSON キー) を渡す経路は持たない。ADC のみ。
  // GOOGLE_APPLICATION_CREDENTIALS が誤って JSON キーを指していても、本コードはそれを
  // cert() で読み込まない (ルール5: JSON キーファイル禁止)。ADC 経由の Workload Identity を前提とする。
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  return initializeApp(projectId ? { projectId } : undefined);
}

/**
 * Identity Platform の Admin Auth インスタンスを返す (シングルトン)。
 * session cookie の発行・検証に使う。
 */
export function getAdminAuth(): Auth {
  if (cachedAuth) {
    return cachedAuth;
  }
  cachedAuth = getAuth(initAdminApp());
  return cachedAuth;
}

/**
 * テスト専用: Admin Auth を差し替える / リセットする。
 * 本番コードからは呼ばない (ADR-012 の unit + mock 方針)。
 */
export function __setAdminAuthForTest(auth: Auth | null): void {
  cachedAuth = auth;
}
