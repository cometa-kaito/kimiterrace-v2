import postgres from "postgres";
import {
  GINAN_AD_DURATION_SEC,
  GINAN_ADS,
  GINAN_SCHOOL_NAME,
  ginanAdMediaUrl,
  validateGinanAds,
} from "./seed-ginan-ads.js";

/**
 * 岐阜県立岐南工業高等学校 電子工学科 PoC の **実契約 6 社のサイネージ広告**を登録するシード実行エントリ。
 * データ（6 社・掲載画像・遷移先）は {@link ./seed-ginan-ads.ts} を参照。
 *
 * ## 実行方法
 * - ローカル: `DATABASE_URL=postgres://... node dist/seed-ginan-ads-cli.js`
 * - staging: migrate と同一イメージに本 CLI を同梱し、Cloud Run Job（kimiterrace-seed-ginan-ads）の
 *   command 上書き（`["node","dist/seed-ginan-ads-cli.js"]`）で起動する（seed-ginan-sensors と同パターン）。
 *
 * ## 前提（このシードは作らない）
 * 学校 `岐阜県立岐南工業高等学校` は **既存**であること（電子工学科 1〜3 年の classes も既存前提）。
 * 学校が見つからなければ孤児広告を作らず **fail-loud** で中断する（責務を広告登録のみに絞る・ルール6）。
 * 掲載画像は別途 GCS バケット `signage-v2-staging-ad-media` に upload 済であること（media_url が指す先）。
 *
 * ## RLS（ルール2 / staging は migrator が非 BYPASSRLS + FORCE RLS）
 * 接続は migrate と同じ migrator DSN（`DATABASE_URL`）。advertisers / ads とも RLS 有効
 * （ads=tenant_isolation、advertisers=system_admin_full_access）。tx 内で
 * `set_config('app.current_user_role','system_admin', true)` を張り、system_admin_full_access policy を
 * 通して書き込む（seed の常道、seed-ginan-sensors / seed-staging-cli と同じ）。
 *
 * ## 冪等性 / scope
 * advertiser/ad とも固定 UUID + `ON CONFLICT (id) DO UPDATE`。scope='school'（school_id のみ・他 *_id は NULL、
 * ck_ads_scope を満たす）で岐南の全クラスに伝搬する（effective_ads_per_class VIEW の school 分岐）。
 *
 * ## 監査（ルール1） / 秘密（ルール5）
 * created_by/updated_by は省略 = NULL（システム作成）。created_at/updated_at は DB 既定 now()。
 * advertisers の不変条件（PR #534）: status='active' ⟺ is_active=true を満たす。
 * ★ ログにもエラーにも DATABASE_URL を出さない（広告主名・HP・画像 URL は公開情報ゆえ出力可）。
 *
 * ## 実装方針: 生 SQL（schema barrel を import しない）
 * drizzle schema barrel は pgvector 経由で `@kimiterrace/ai` に推移依存し migrate イメージで
 * ERR_MODULE_NOT_FOUND になるため、`postgres` の生 SQL で書く（seed-ginan-sensors / migrate-cli と同じ）。
 */

const SCHOOL_NAME = process.env.SEED_GINAN_SCHOOL_NAME ?? GINAN_SCHOOL_NAME;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  // DB に触れる前に配列の自己整合性を検証（id 一意・URL は http(s)・社名長）。
  validateGinanAds(GINAN_ADS);

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  let exitCode = 0;
  const perAd: Array<{ company: string; advertiser: string; ad: string }> = [];
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

      for (const a of GINAN_ADS) {
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
        //    media_type='image'、caption は NULL（完成クリエイティブの意匠を保つ）。advertiser_id で CRM 紐付け。
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

        perAd.push({ company: a.companyName, advertiser: a.advertiserId, ad: a.adId });
      }
    });

    // 識別子・件数のみ（DATABASE_URL は出さない。社名/HP/画像 URL は公開情報）。
    console.log(
      JSON.stringify({
        event: "seed.ginan.ads.done",
        schoolName: SCHOOL_NAME,
        schoolId: resolvedSchoolId,
        advertisersUpserted,
        adsUpserted,
        total: GINAN_ADS.length,
        ads: perAd,
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
