import { type APIRequestContext, test as setup } from "@playwright/test";
import { initializeApp } from "firebase-admin/app";
import { type Auth, getAuth } from "firebase-admin/auth";
import { type AuthPrincipal, AUTH_PRINCIPALS, isSignageDbAvailable } from "./global-setup";

/**
 * 認証セットアップ (F0 #48-O 第 3 増分: Firebase Auth emulator + ログイン到達 / #243 で多ロール化)。
 *
 * Playwright の **setup project** として globalSetup (migrate+seed) と webServer 起動の後に走る。
 * ここで各ロールの「ログイン済みセッション」を**アプリ本来の発行経路**で作り storageState に保存する。
 * 認可マトリクス / クロステナント分離 e2e (#243) のため、教員に加え school_admin / system_admin /
 * SCHOOL2 教員を `AUTH_PRINCIPALS` の宣言から **同じ経路**で発行する (各 principal = 1 setup test)。
 *
 * 各 principal について:
 *   1. Auth emulator にユーザー (localId = principal.uid(UUID) / email / password) を作成し、custom
 *      claims `{role, school_id}` を付与する (system_admin は school_id を載せない = テナント外)。`uid`
 *      は localId (ID トークン sub) から来るので custom claim にしない (`uid` 名の claim は firebase 予約
 *      で上書きされる)。→ verifySessionCookie の decoded.uid が UUID になり normalizeClaims が受理、
 *      withSession→RLS が所属校にスコープされる。globalSetup は同じ localId で DB 行 (users /
 *      system_admins) を seed 済み (FK / RLS 整合)。
 *   2. emulator の Identity Toolkit REST (`accounts:signInWithPassword`) で **ID トークン**を得る。
 *      emulator は API キーを検証しないため key は明白なダミー値で良い (実 credential 不要、ルール5)。
 *   3. その ID トークンを実 webServer の `/api/auth/session` へ POST し本物の `__session` cookie を得る
 *      (app の発行経路 createSessionCookie をそのまま通す = test 用バックドアを作らない)。
 *   4. レスポンスの Set-Cookie を principal.storageState に書き、各 spec が `storageState` で再利用する。
 *
 * **emulator 接続 (コード変更不要、env のみ)**: firebase-admin は `FIREBASE_AUTH_EMULATOR_HOST` が
 * 立っていれば emulator を信頼する (本番 adminApp.ts は ADC、ここは setup 専用の別 App を起こす)。
 * CI / ローカルとも emulator が無い (placeholder DB) 場合は skip し、storageState は書かない
 * (各 spec も同じ判定で skip。偽 green ではなく「DB+emulator がある時だけ実行」)。
 */

/** webServer のベース URL。playwright.config.ts の PORT と一致させる。 */
const BASE_URL = "http://localhost:3100";

/**
 * Auth emulator が立っているか (= 認証 e2e を実行できるか)。
 * emulator host が無い、または DB が placeholder (users 行が seed されない) なら実行不能。
 */
function isAuthEmulatorAvailable(): boolean {
  return (
    !!process.env.FIREBASE_AUTH_EMULATOR_HOST && isSignageDbAvailable(process.env.DATABASE_URL)
  );
}

/**
 * 1 つの principal について emulator ユーザーを作成 → claims 付与 → ID トークン取得 →
 * /api/auth/session で __session 発行 → storageState 保存、までを行う共有ヘルパ。
 *
 * custom claims は **role / school_id のみ** (uid は localId から来るので claim にしない)。
 * system_admin は schoolId=null なので school_id claim を載せない (normalizeClaims が許容する形)。
 */
async function provisionPrincipal(
  request: APIRequestContext,
  adminAuth: Auth,
  principal: AuthPrincipal,
): Promise<void> {
  // 既存ユーザーがあれば消してから作る (emulator は使い捨てだが reuseExistingServer ローカルで冪等に)。
  try {
    const existing = await adminAuth.getUserByEmail(principal.email);
    await adminAuth.deleteUser(existing.uid);
  } catch {
    // 未作成なら getUserByEmail が throw。無視して作成に進む。
  }

  // emulator は localId を明示指定して作成できる。localId = principal.uid(UUID) にし、ID トークンの
  // sub (= verifySessionCookie の decoded.uid) を users.id / system_admins.identity_uid と一致させる。
  await adminAuth.createUser({
    uid: principal.uid,
    email: principal.email,
    password: principal.password,
    emailVerified: true,
  });
  // custom claims: role は必須、school_id は所属校がある場合のみ載せる (system_admin は載せない)。
  const claims: Record<string, string> =
    principal.schoolId !== null
      ? { role: principal.role, school_id: principal.schoolId }
      : { role: principal.role };
  await adminAuth.setCustomUserClaims(principal.uid, claims);

  // 2. emulator の Identity Toolkit REST で ID トークンを得る。key は emulator では非検証のダミー。
  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST as string;
  const signInUrl = `http://${emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const signInRes = await request.post(signInUrl, {
    data: {
      email: principal.email,
      password: principal.password,
      returnSecureToken: true,
    },
  });
  if (!signInRes.ok()) {
    throw new Error(
      `emulator signInWithPassword 失敗 [${principal.name}] (${signInRes.status()}): ${await signInRes.text()}`,
    );
  }
  const { idToken } = (await signInRes.json()) as { idToken?: string };
  if (!idToken) {
    throw new Error(`emulator から idToken が得られませんでした [${principal.name}]`);
  }

  // 3. 実 webServer の /api/auth/session に POST して本物の __session cookie を発行させる。
  const sessionRes = await request.post(`${BASE_URL}/api/auth/session`, {
    data: { idToken },
  });
  if (!sessionRes.ok()) {
    throw new Error(
      `/api/auth/session 失敗 [${principal.name}] (${sessionRes.status()}): ${await sessionRes.text()}`,
    );
  }

  // 4. request コンテキストの cookie (Set-Cookie で入った __session) を storageState に保存する。
  await request.storageState({ path: principal.storageState });
}

// principal ごとに 1 setup test を登録する (失敗を分離・並列化)。test 名は `authenticate <name>`。
// 教員 (`authenticate teacher`) は従来どおり登録され続けるため admin-auth.spec の依存は壊れない。
for (const principal of AUTH_PRINCIPALS) {
  setup(`authenticate ${principal.name}`, async ({ request }) => {
    setup.skip(
      !isAuthEmulatorAvailable(),
      "FIREBASE_AUTH_EMULATOR_HOST 未設定 / DATABASE_URL placeholder (認証 e2e は emulator + 実 DB 必須)",
    );

    const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? "demo-kimiterrace";
    // emulator 専用の firebase-admin App を起こす (本番 adminApp.ts とは別インスタンス、ADC を汚さない)。
    // principal ごとに一意な App 名にして並列 setup でも衝突しない。
    const adminApp = initializeApp({ projectId }, `e2e-auth-setup-${principal.name}-${Date.now()}`);
    const adminAuth = getAuth(adminApp);

    await provisionPrincipal(request, adminAuth, principal);
  });
}
