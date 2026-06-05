import { sql as drizzleSql } from "drizzle-orm";
import { createDbClient } from "./client.js";
import { schools, teacherInputs, users } from "./schema/index.js";

/**
 * #289 ④ app 層 E2E 用の **staging テストフィクスチャ seed** 実行エントリ（Cloud Run Job）。
 *
 * staging Cloud SQL は private-IP ゆえローカル機（VPC 外）から届かない。よって VPC connector 経由で
 * 到達できる **on-demand Cloud Run Job** として実行し、実 Vertex（F03/F06）の認証つき end-to-end 検証に
 * 必要な最小フィクスチャ（1 校 + 1 教員 + 1 teacher_input）を投入する。
 *
 * 接続は migrate Job と同じ **migrator ロール（cloudsqlsuperuser・BYPASSRLS）** の DSN を使う
 * （`DATABASE_URL`）。BYPASSRLS ゆえ RLS context 無しで cross-tenant に INSERT できる（seed の常道）。
 *
 * ## uid モデル（重要 / F11 整合）
 * 教員の `users.id` == `users.identity_uid` == **Identity Platform の localId（ID トークン sub）** を
 * 同一 UUID に揃える（`apps/web/lib/auth/session.ts` の normalizeClaims が decoded.uid==users.id を前提と
 * するため）。IdP アカウント作成（`createUser({uid})` + claims）はローカルから別途実行する（本 Job は DB のみ）。
 *
 * ## 冪等性
 * 固定 UUID + `onConflictDoNothing()`（PK 衝突は無視）で再実行安全。
 *
 * ## PII（ルール4 / E2E の検証対象）
 * transcript は **わざと** ①職員氏名（roster = 教員 display_name → STAFF マスク対象）②敬称連接
 * （`田中さん` → F03 soft-gate 409 の対象）③電話番号（書式 PII マスク対象）を含め、実 Vertex 送信前
 * マスキング + soft-gate が実環境で効くことを検証可能にする。**生 PII はログに出さない**（ルール5/4）。
 *
 * ★ ログにもエラーにも DATABASE_URL / transcript 本文を出さない。
 */

const SCHOOL_ID = process.env.SEED_SCHOOL_ID ?? "e2e51111-0000-4000-8000-000000000001";
const TEACHER_UID = process.env.SEED_TEACHER_UID ?? "e2e51111-0000-4000-8000-000000000002";
const INPUT_ID = process.env.SEED_TEACHER_INPUT_ID ?? "e2e51111-0000-4000-8000-000000000003";
const TEACHER_EMAIL = process.env.SEED_TEACHER_EMAIL ?? "e2e-teacher@kimiterrace-e2e.invalid";
// 職員氏名（roster）。transcript 中に現れると STAFF としてマスクされる検証用。
const TEACHER_NAME = process.env.SEED_TEACHER_NAME ?? "山田太郎";
// ① 職員氏名(山田太郎=roster) ② 敬称連接(田中さん=soft-gate) ③ 電話(書式 PII) を含む検証用 transcript。
const TRANSCRIPT =
  process.env.SEED_TRANSCRIPT ??
  "保護者会のお知らせです。担当は山田太郎、受付は田中さん。連絡は 090-1234-5678 まで。";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  const { sql, db } = createDbClient(url);

  let exitCode = 0;
  try {
    // 1) 学校（テナント）。
    await db
      .insert(schools)
      .values({ id: SCHOOL_ID, name: "E2Eテスト高校", prefecture: "岐阜県", code: "E2E001" })
      .onConflictDoNothing();

    // 2) 教員ユーザー。id == identity_uid == IdP localId（同一 UUID、normalizeClaims 整合）。
    await db
      .insert(users)
      .values({
        id: TEACHER_UID,
        schoolId: SCHOOL_ID,
        identityUid: TEACHER_UID,
        role: "teacher",
        displayName: TEACHER_NAME,
        email: TEACHER_EMAIL,
        isActive: true,
      })
      .onConflictDoNothing();

    // 3) teacher_input（F03 抽出対象）。submittedAt は postgres@3.4.9 の enum 列 + timestamptz への
    //    JS Date バインド罠を避けるため SQL の now() を使う（[[feedback_pg_date_bind_enum_insert]]）。
    await db
      .insert(teacherInputs)
      .values({
        id: INPUT_ID,
        schoolId: SCHOOL_ID,
        teacherId: TEACHER_UID,
        inputType: "chat",
        status: "submitted",
        transcript: TRANSCRIPT,
        transcriptEdited: true,
        submittedAt: drizzleSql`now()`,
        createdBy: TEACHER_UID,
        updatedBy: TEACHER_UID,
      })
      .onConflictDoNothing();

    // transcript 本文 / PII は出さない。識別子のみ（運用ログ）。
    console.log(
      JSON.stringify({
        event: "seed.staging.fixture.done",
        schoolId: SCHOOL_ID,
        teacherUid: TEACHER_UID,
        teacherInputId: INPUT_ID,
      }),
    );
  } catch (err) {
    // err は postgres driver 例外。DSN 全文は含まない。transcript も出さない。
    console.error(err);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
