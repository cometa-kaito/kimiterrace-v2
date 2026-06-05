import postgres from "postgres";

/**
 * #289 ④ app 層 E2E 用の **staging テストフィクスチャ seed** 実行エントリ（Cloud Run Job）。
 *
 * staging Cloud SQL は private-IP ゆえローカル機（VPC 外）から届かない。よって VPC connector 経由で
 * 到達できる **on-demand Cloud Run Job** として実行し、実 Vertex（F03/F06）の認証つき end-to-end 検証に
 * 必要な最小フィクスチャ（1 校 + 1 教員 + 1 teacher_input）を投入する。
 *
 * ## RLS（重要 / staging では migrator は非 BYPASSRLS + FORCE RLS）
 * 接続は migrate Job と同じ migrator DSN（`DATABASE_URL`）。staging の migrator は cloudsqlsuperuser だが
 * **BYPASSRLS ではなく**、テーブルは **FORCE ROW LEVEL SECURITY**（owner も RLS 対象）。よって生 INSERT は
 * `tenant_isolation` の WITH CHECK で弾かれる。seed はトランザクション内で
 * `set_config('app.current_user_role','system_admin', true)` を張り、全 RLS テーブルに付く
 * `system_admin_full_access` policy（`WITH CHECK current_user_role = 'system_admin'`）を通して書き込む
 * （cross-tenant 可・seed の常道。0002_rls_policies.sql）。
 *
 * ## 実装方針: **生 SQL**（migrate-cli と同じ `postgres` 直叩き）
 * drizzle schema の barrel（`schema/index.js`）は pgvector 列経由で `@kimiterrace/ai` に推移依存し
 * migrate イメージで ERR_MODULE_NOT_FOUND になるため、schema を import せず `postgres` の生 SQL で書く。
 *
 * ## uid モデル（F11 整合）/ 冪等性 / PII（ルール4）
 * 教員の `users.id` == `users.identity_uid` == IdP localId を同一 UUID に揃える（normalizeClaims 整合）。
 * 固定 UUID + `ON CONFLICT (id) DO NOTHING` で再実行安全。transcript は検証用 PII（職員氏名 / 田中さん /
 * 電話）を含む。enum は SQL リテラル、時刻は `now()`（JS Date バインド罠回避）。
 * ★ ログにもエラーにも DATABASE_URL / transcript 本文を出さない（ルール5/4）。
 */

const SCHOOL_ID = process.env.SEED_SCHOOL_ID ?? "e2e51111-0000-4000-8000-000000000001";
const TEACHER_UID = process.env.SEED_TEACHER_UID ?? "e2e51111-0000-4000-8000-000000000002";
const INPUT_ID = process.env.SEED_TEACHER_INPUT_ID ?? "e2e51111-0000-4000-8000-000000000003";
const TEACHER_EMAIL = process.env.SEED_TEACHER_EMAIL ?? "e2e-teacher@kimiterrace-e2e.invalid";
const TEACHER_NAME = process.env.SEED_TEACHER_NAME ?? "山田太郎";
const SCHOOL_NAME = process.env.SEED_SCHOOL_NAME ?? "E2Eテスト高校";
const TRANSCRIPT =
  process.env.SEED_TRANSCRIPT ??
  "保護者会のお知らせです。担当は山田太郎、受付は田中さん。連絡は 090-1234-5678 まで。";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  let exitCode = 0;
  try {
    await sql.begin(async (tx) => {
      // FORCE RLS 下で system_admin_full_access policy を通すため system_admin context を張る（tx スコープ）。
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      // 1) 学校（テナント）。
      await tx`
        INSERT INTO schools (id, name, prefecture, code)
        VALUES (${SCHOOL_ID}, ${SCHOOL_NAME}, '岐阜県', 'E2E001')
        ON CONFLICT (id) DO NOTHING`;

      // 2) 教員ユーザー。id == identity_uid == IdP localId（同一 UUID、normalizeClaims 整合）。
      await tx`
        INSERT INTO users (id, school_id, identity_uid, role, display_name, email, is_active)
        VALUES (${TEACHER_UID}, ${SCHOOL_ID}, ${TEACHER_UID}, 'teacher', ${TEACHER_NAME}, ${TEACHER_EMAIL}, true)
        ON CONFLICT (id) DO NOTHING`;

      // 3) teacher_input（F03 抽出対象）。input_type/status は enum リテラル、submitted_at は now()。
      await tx`
        INSERT INTO teacher_inputs
          (id, school_id, teacher_id, input_type, status, transcript, transcript_edited, submitted_at, created_by, updated_by)
        VALUES
          (${INPUT_ID}, ${SCHOOL_ID}, ${TEACHER_UID}, 'chat', 'submitted', ${TRANSCRIPT}, true, now(), ${TEACHER_UID}, ${TEACHER_UID})
        ON CONFLICT (id) DO NOTHING`;
    });

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
    // err は postgres driver 例外。DSN 全文 / transcript は含まない。
    console.error(err);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
