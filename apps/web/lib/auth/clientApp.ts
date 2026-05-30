"use client";
import { type FirebaseApp, getApp, getApps, initializeApp } from "firebase/app";
import { type Auth, getAuth } from "firebase/auth";

/**
 * Identity Platform クライアント SDK (firebase) の初期化 (ADR-003)。
 *
 * **ここで使う config (apiKey / authDomain / projectId) は公開値**であり秘密ではない
 * (CLAUDE.md ルール5 の対象外)。ブラウザに配布される性質上、`NEXT_PUBLIC_` env で渡す。
 * 真の認可は session cookie 検証 (server, lib/auth/session.ts) + RLS (ADR-019) で担保するため、
 * これらの公開 config が露出してもテナント越境にはつながらない。
 *
 * 注: この config は「どの Identity Platform プロジェクトに対してサインインするか」を指すだけで、
 * DB 認証情報や Admin の秘密鍵は一切含まない。
 */
function clientConfig() {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  };
}

let cachedApp: FirebaseApp | null = null;

function getClientApp(): FirebaseApp {
  if (cachedApp) {
    return cachedApp;
  }
  cachedApp = getApps().length > 0 ? getApp() : initializeApp(clientConfig());
  return cachedApp;
}

/** クライアント側の Auth インスタンスを返す (サインインに使う)。 */
export function getClientAuth(): Auth {
  return getAuth(getClientApp());
}
