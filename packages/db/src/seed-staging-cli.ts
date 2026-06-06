import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

/**
 * #289 ④ app 層 E2E 用の **staging テストフィクスチャ seed** 実行エントリ（Cloud Run Job）。
 *
 * staging Cloud SQL は private-IP ゆえローカル機（VPC 外）から届かない。よって VPC connector 経由で
 * 到達できる **on-demand Cloud Run Job** として実行し、実 Vertex（F03/F06）の認証つき end-to-end 検証に
 * 必要な最小フィクスチャ（1 校 + 1 教員 + 1 teacher_input、+ F12 サイネージ実機確認用に
 * クラス + クラス用 magic link + 当日の school scope daily_data）を投入する。
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

// --- F12 公開サイネージ (#48-E) の実機確認フィクスチャ -----------------------------------------
// サイネージ `/signage/{classToken}` を staging 実機で描画するための最小フィクスチャ:
//   クラス 1 つ + クラス用 magic link (= classToken) + 当日 (JST) の school scope daily_data。
// これが無いと E2E 校はクラス 0 で classToken が発行できず、URL を叩いても無効画面になる。
const CLASS_ID = process.env.SEED_CLASS_ID ?? "e2e51111-0000-4000-8000-000000000006";
const MAGIC_LINK_ID = process.env.SEED_MAGIC_LINK_ID ?? "e2e51111-0000-4000-8000-000000000007";
const CLASS_NAME = process.env.SEED_CLASS_NAME ?? "3年1組";
const ACADEMIC_YEAR = Number(process.env.SEED_ACADEMIC_YEAR ?? "2026");
const CLASS_GRADE = Number(process.env.SEED_CLASS_GRADE ?? "3");

// 平文サイネージトークン。**ハードコードしない** (ルール5)。env 指定があればそれ、無ければ 256bit 乱数を
// base64url 化 (token.ts generateToken と同方式)。DB には SHA-256 hex のみ保存し (token.ts hashToken と
// 同方式)、平文は本 Job の stdout に **1 度だけ** 出す ─ 検証者が URL/QR を得る唯一の手段。staging の
// 合成データ・90 日期限・失効可能・PII ゼロゆえ受容 (ADR-029 の Cloud Run リクエストログ露出と同水準)。
const SIGNAGE_TOKEN = process.env.SEED_SIGNAGE_TOKEN ?? randomBytes(32).toString("base64url");
const SIGNAGE_TOKEN_HASH = createHash("sha256").update(SIGNAGE_TOKEN, "utf8").digest("hex");

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

      // 4) クラス（サイネージ表示対象）。grade_id は NULL（学年未割当・学年スコープは引かない）。
      //    created_by/updated_by は省略 = NULL（system 作成）。academic_year/name/grade は notNull。
      await tx`
        INSERT INTO classes (id, school_id, academic_year, name, grade)
        VALUES (${CLASS_ID}, ${SCHOOL_ID}, ${ACADEMIC_YEAR}, ${CLASS_NAME}, ${CLASS_GRADE})
        ON CONFLICT (id) DO NOTHING`;

      // 5) 当日 (JST) の school scope daily_data。各 JSONB 要素は section-format.ts の確定スキーマ:
      //    schedules {period,subject,note?} / notices {text,isHighlight?} /
      //    assignments {deadline,subject,task} / quiet_hours {start,end}。
      //    date は JST 今日（Cloud Run は UTC ゆえ now() AT TIME ZONE 'Asia/Tokyo' で算出）。
      //    JSONB は `${JSON.stringify(...)}::jsonb`（postgres@3.4.9 の sql.json バインド罠回避）。
      //    再実行で当日分を最新化するため ON CONFLICT（ux_daily_data_target_date）で中身を更新。
      const schedules = JSON.stringify([
        { period: 1, subject: "数学", note: "教科書 p.42" },
        { period: 2, subject: "英語" },
        { period: 3, subject: "理科", note: "実験室" },
        { period: 4, subject: "国語" },
      ]);
      const notices = JSON.stringify([
        { text: "本日は1〜4限のみ、午後は45分短縮授業です。", isHighlight: true },
        { text: "図書室の返却期限は今週金曜までです。" },
      ]);
      const assignments = JSON.stringify([
        { deadline: "2026-06-13", subject: "数学", task: "ワーク p.10-12" },
        { deadline: "2026-06-12", subject: "英語", task: "単語テスト範囲 Unit 3" },
      ]);
      const quietHours = JSON.stringify([{ start: "12:30", end: "13:00" }]);
      await tx`
        INSERT INTO daily_data
          (school_id, scope, date, schedules, notices, assignments, quiet_hours)
        VALUES
          (${SCHOOL_ID}, 'school', (now() AT TIME ZONE 'Asia/Tokyo')::date,
           ${schedules}::jsonb, ${notices}::jsonb, ${assignments}::jsonb, ${quietHours}::jsonb)
        ON CONFLICT ON CONSTRAINT ux_daily_data_target_date DO UPDATE SET
          schedules = EXCLUDED.schedules,
          notices = EXCLUDED.notices,
          assignments = EXCLUDED.assignments,
          quiet_hours = EXCLUDED.quiet_hours,
          updated_at = now()`;

      // 6) クラス用 magic link（= サイネージ classToken）。token_hash のみ保存。再実行で確実に
      //    「今使える平文」を得るため ON CONFLICT (id) で hash/期限を更新し失効解除する。
      //    class_id + school_id は composite FK（fk_magic_links_class）で cross-tenant を弾く。
      await tx`
        INSERT INTO magic_links
          (id, school_id, class_id, token_hash, expires_at, revoked_at)
        VALUES
          (${MAGIC_LINK_ID}, ${SCHOOL_ID}, ${CLASS_ID}, ${SIGNAGE_TOKEN_HASH},
           now() + interval '90 days', NULL)
        ON CONFLICT (id) DO UPDATE SET
          token_hash = EXCLUDED.token_hash,
          expires_at = EXCLUDED.expires_at,
          revoked_at = NULL,
          updated_at = now()`;
    });

    // transcript 本文 / PII は出さない。識別子のみ（運用ログ）。signageToken は検証用に意図的に出す
    // （staging 合成・失効可能・PII ゼロ、上記 SIGNAGE_TOKEN の根拠コメント参照）。
    console.log(
      JSON.stringify({
        event: "seed.staging.fixture.done",
        schoolId: SCHOOL_ID,
        teacherUid: TEACHER_UID,
        teacherInputId: INPUT_ID,
        classId: CLASS_ID,
        magicLinkId: MAGIC_LINK_ID,
        signageToken: SIGNAGE_TOKEN,
        signagePath: `/signage/${SIGNAGE_TOKEN}`,
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
