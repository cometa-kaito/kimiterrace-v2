import { test as setup } from "@playwright/test";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { SEED, TEACHER_STORAGE_STATE, isSignageDbAvailable } from "./global-setup";

/**
 * 認証セットアップ (F0 #48-O 第 3 増分: Firebase Auth emulator + 教員ログイン到達)。
 *
 * Playwright の **setup project** として globalSetup (migrate+seed) と webServer 起動の後に 1 度走る。
 * ここで「教員のログイン済みセッション」を**アプリ本来の発行経路**で作り、storageState に保存する:
 *
 *   1. Auth emulator に教員ユーザー (localId = TEACHER_UID(UUID) / email / password) を作成し、
 *      custom claims `{role:"teacher", school_id: SCHOOL_ID}` を付与する。`uid` は localId (ID トークン
 *      sub) から来るので custom claim にしない (`uid` 名の claim は firebase 予約で上書きされる)。
 *      → verifySessionCookie の decoded.uid が UUID になり normalizeClaims が受理、withSession→RLS が
 *        教員の所属校 (SEED.SCHOOL_ID) にスコープされる。global-setup.ts は同じ localId
 *        (= users.id = users.identity_uid) で users 行を seed 済み (FK / RLS 整合)。
 *   2. emulator の Identity Toolkit REST (`accounts:signInWithPassword`) で **ID トークン**を得る。
 *      emulator は API キーを検証しないため、key は明白なダミー値で良い (実 credential 不要、ルール5)。
 *   3. その ID トークンを実 webServer の `/api/auth/session` へ POST し、本物の `__session` cookie を得る
 *      (app の発行経路 createSessionCookie をそのまま通す = test 用バックドアを作らない)。
 *   4. レスポンスの Set-Cookie を storageState に書き、`admin-auth.spec.ts` が再利用する。
 *
 * **emulator 接続 (コード変更不要、env のみ)**: firebase-admin は `FIREBASE_AUTH_EMULATOR_HOST` が
 * 立っていれば emulator を信頼する (本番 adminApp.ts は ADC、ここは setup 専用の別 App を起こす)。
 * CI / ローカルとも emulator が無い (placeholder DB) 場合は skip し、storageState を空で書く
 * (admin-auth.spec も同じ判定で skip。偽 green ではなく「DB+emulator がある時だけ実行」)。
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

setup("authenticate teacher", async ({ request }) => {
  setup.skip(
    !isAuthEmulatorAvailable(),
    "FIREBASE_AUTH_EMULATOR_HOST 未設定 / DATABASE_URL placeholder (認証 e2e は emulator + 実 DB 必須)",
  );

  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? "demo-kimiterrace";
  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST as string;

  // 1. emulator 専用の firebase-admin App を起こす (本番 adminApp.ts とは別インスタンス、ADC を汚さない)。
  //    FIREBASE_AUTH_EMULATOR_HOST が立っているので createSessionCookie/verify は emulator を信頼する。
  const adminApp = initializeApp({ projectId }, `e2e-auth-setup-${Date.now()}`);
  const adminAuth = getAuth(adminApp);

  // 既存ユーザーがあれば消してから作る (emulator は使い捨てだが reuseExistingServer ローカルで冪等に)。
  try {
    const existing = await adminAuth.getUserByEmail(SEED.TEACHER_EMAIL);
    await adminAuth.deleteUser(existing.uid);
  } catch {
    // 未作成なら getUserByEmail が throw。無視して作成に進む。
  }

  // emulator は localId を明示指定して作成できる。localId = TEACHER_UID(UUID) にし、ID トークンの
  // sub (= verifySessionCookie の decoded.uid) を users.id と一致させる (本番運用と同じ)。
  await adminAuth.createUser({
    uid: SEED.TEACHER_UID,
    email: SEED.TEACHER_EMAIL,
    password: SEED.TEACHER_PASSWORD,
    emailVerified: true,
  });
  // custom claims は role / school_id のみ。uid は localId (sub) から来るので claim にしない
  // (`uid` 名の claim は firebase 予約で上書きされ効かない)。normalizeClaims が role/school_id を検証する。
  await adminAuth.setCustomUserClaims(SEED.TEACHER_UID, {
    role: "teacher",
    school_id: SEED.SCHOOL_ID,
  });

  // 2. emulator の Identity Toolkit REST で ID トークンを得る。key は emulator では非検証のダミー。
  const signInUrl = `http://${emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const signInRes = await request.post(signInUrl, {
    data: {
      email: SEED.TEACHER_EMAIL,
      password: SEED.TEACHER_PASSWORD,
      returnSecureToken: true,
    },
  });
  if (!signInRes.ok()) {
    throw new Error(
      `emulator signInWithPassword 失敗 (${signInRes.status()}): ${await signInRes.text()}`,
    );
  }
  const { idToken } = (await signInRes.json()) as { idToken?: string };
  if (!idToken) {
    throw new Error("emulator から idToken が得られませんでした");
  }

  // 3. 実 webServer の /api/auth/session に POST して本物の __session cookie を発行させる。
  const sessionRes = await request.post(`${BASE_URL}/api/auth/session`, {
    data: { idToken },
  });
  if (!sessionRes.ok()) {
    throw new Error(`/api/auth/session 失敗 (${sessionRes.status()}): ${await sessionRes.text()}`);
  }

  // 4. request コンテキストの cookie (Set-Cookie で入った __session) を storageState に保存する。
  await request.storageState({ path: TEACHER_STORAGE_STATE });
});
