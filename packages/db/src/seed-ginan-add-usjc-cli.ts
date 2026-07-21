import postgres from "postgres";
import {
  GINAN_AD_DURATION_SEC,
  GINAN_SCHOOL_NAME,
  USJC_AD,
  ginanAdMediaUrl,
  validateUsjcAd,
} from "./seed-ginan-add-usjc.js";

/**
 * 岐阜県立岐南工業高等学校 電子工学科 PoC に **USJC 1 社だけ**を追加する surgical seed 実行エントリ。
 * データ（USJC の固定 UUID・掲載画像・遷移先）は {@link ./seed-ginan-add-usjc.ts} を参照。
 *
 * ## seed-ginan-ads-cli との違い（あえて別 CLI）
 * 全社 seed（seed-ginan-ads-cli）は 6 社を毎回 active に強制上書きし、`/ops` で **停止した広告主を復活**させる。
 * 本 CLI は **USJC の 2 行（advertisers / ads）しか触らない**。既存 5 社の稼働・media_url・display_order にも、
 * 停止中の日本クロージャーにも一切触れない（2026-07-21 ユーザー確定の surgical add）。
 *
 * ## 実行方法（既存 seed-ginan-* と同パターン）
 * - ローカル: `DATABASE_URL=postgres://... node dist/seed-ginan-add-usjc-cli.js`
 * - prod: migrate イメージに同梱し、Cloud Run Job（kimiterrace-seed-ginan-usjc）の command 上書き
 *   （`["node","dist/seed-ginan-add-usjc-cli.js"]`）で起動する。
 *
 * ## 前提（このシードは作らない）
 * 学校 `岐阜県立岐南工業高等学校` は **既存**であること。見つからなければ孤児広告を作らず **fail-loud** で中断。
 * 掲載画像 `usjc.png` は GCS バケット `signage-v2-staging-ad-media/ginan/` に upload 済であること（media_url の指す先）。
 *
 * ## RLS / 冪等 / 監査 / 秘密（seed-ginan-ads-cli と同一規律）
 * migrator DSN（`DATABASE_URL`）で接続し tx 内 `set_config('app.current_user_role','system_admin', true)` を張る。
 * 固定 UUID + `ON CONFLICT (id) DO UPDATE` で再実行安全。created_by/updated_by は NULL（システム作成）。
 * advertisers の不変条件（PR #534）: status='active' ⟺ is_active=true。★ ログ・エラーに DATABASE_URL を出さない。
 */

const SCHOOL_NAME = process.env.SEED_GINAN_SCHOOL_NAME ?? GINAN_SCHOOL_NAME;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  // DB に触れる前に自己整合性を検証（id・URL・社名長）。
  validateUsjcAd();

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  let exitCode = 0;
  let advertisersUpserted = 0;
  let adsUpserted = 0;
  let resolvedSchoolId: string | undefined;

  try {
    await sql.begin(async (tx) => {
      // FORCE RLS 下で system_admin_full_access / tenant_isolation を通すため system_admin context（tx スコープ）。
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      // 学校（テナント）を名前で解決。見つからなければ fail-loud（孤児広告を作らない）。
      const schoolRows = await tx<{ id: string }[]>`
        SELECT id FROM schools WHERE name = ${SCHOOL_NAME} ORDER BY created_at ASC LIMIT 1`;
      const schoolId = schoolRows[0]?.id;
      if (!schoolId) {
        throw new Error(
          `school not found by name: ${SCHOOL_NAME}（先に学校レコードを作成してください）`,
        );
      }
      resolvedSchoolId = schoolId;

      const a = USJC_AD;

      // 1) 広告主マスタ（CRM）。固定 id で冪等。status='active' ⟺ is_active=true（不変条件・PR #534）。
      const advRes = await tx<{ id: string }[]>`
        INSERT INTO advertisers (id, company_name, industry, notes, status, is_active)
        VALUES (${a.advertiserId}, ${a.companyName}, ${a.industry}, ${a.notes}, 'active', true)
        ON CONFLICT (id) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          industry = EXCLUDED.industry,
          notes = EXCLUDED.notes,
          status = 'active',
          is_active = true,
          updated_at = now()
        RETURNING id`;
      if (advRes.length === 1) advertisersUpserted++;

      // 2) 学校スコープ広告。scope='school' ゆえ grade/department/class_id は NULL（ck_ads_scope）。
      const mediaUrl = ginanAdMediaUrl(a.mediaFile);
      const adRes = await tx<{ id: string }[]>`
        INSERT INTO ads
          (id, school_id, scope, advertiser_id, media_url, media_type, duration_sec, link_url, caption, display_order)
        VALUES
          (${a.adId}, ${schoolId}, 'school', ${a.advertiserId}, ${mediaUrl}, 'image',
           ${GINAN_AD_DURATION_SEC}, ${a.linkUrl}, NULL, ${a.displayOrder})
        ON CONFLICT (id) DO UPDATE SET
          school_id = EXCLUDED.school_id,
          scope = 'school',
          advertiser_id = EXCLUDED.advertiser_id,
          media_url = EXCLUDED.media_url,
          media_type = 'image',
          duration_sec = EXCLUDED.duration_sec,
          link_url = EXCLUDED.link_url,
          display_order = EXCLUDED.display_order,
          updated_at = now()
        RETURNING id`;
      if (adRes.length === 1) adsUpserted++;
    });

    // 識別子・件数のみ（DATABASE_URL は出さない。社名/HP/画像 URL は公開情報）。
    console.log(
      JSON.stringify({
        event: "seed.ginan.add-usjc.done",
        schoolName: SCHOOL_NAME,
        schoolId: resolvedSchoolId,
        advertisersUpserted,
        adsUpserted,
        advertiserId: USJC_AD.advertiserId,
        adId: USJC_AD.adId,
        company: USJC_AD.companyName,
        displayOrder: USJC_AD.displayOrder,
      }),
    );
  } catch (err) {
    // err は postgres driver 例外。DSN 全文は含まない。
    console.error(err);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
