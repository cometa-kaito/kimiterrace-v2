import {
  GINAN_AD_DURATION_SEC,
  GINAN_SCHOOL_NAME,
  type GinanAdvertiserAd,
  ginanAdMediaUrl,
  validateGinanAds,
} from "./seed-ginan-ads.js";

/**
 * 岐阜県立岐南工業高等学校 電子工学科 PoC に **USJC 1 社だけ**を追加登録するための surgical seed データ。
 *
 * ## なぜ全社 seed（{@link ./seed-ginan-ads.ts} / seed-ginan-ads-cli）と分けるか
 * 全社 seed は `advertisers` を `ON CONFLICT (id) DO UPDATE SET status='active', is_active=true` で
 * **毎回 active に強制上書き**する。運用中に `/ops` の稼働トグル（AdvertiserActiveToggle）で **停止した広告主
 * （例: 日本クロージャー）を全社 seed 再実行で誤って復活**させてしまう。よって追加は
 * 「USJC だけを触る」本データ + {@link ./seed-ginan-add-usjc-cli.ts} で行い、既存の稼働/停止状態には一切
 * 触れない（2026-07-21 ユーザー確定: 現在ライブ 5 社と停止中の日本クロージャーは据え置き、USJC を足して 6 社）。
 *
 * ## 契約・スコープ（既存 6 社 = GINAN_ADS と同じ流儀）
 * - 固定 UUID + `ON CONFLICT (id) DO UPDATE`（再実行安全・冪等）。
 * - `scope='school'`（電子工学科 1〜3 年の全クラスに伝搬。effective_ads_per_class VIEW の school 分岐）。
 * - `media_type='image'`、`caption=NULL`（完成クリエイティブの意匠を保つ）、`duration_sec=7`（GINAN_AD_DURATION_SEC）。
 * - `display_order=70`（既存 10〜60 の末尾に追加）。
 *
 * ## メディア / リンク
 * 掲載画像は既存 6 社と同じ公開 GCS バケット `signage-v2-staging-ad-media/ginan/`（端末が直接 GET する公開 URL、
 * media_url は ginanAdMediaUrl で構築）に `usjc.png` として upload 済（2026-07-21）。
 * link_url = 公式 HP トップ（https://www.usjpc.com/、HTTP 200 確認済）。
 */

export { GINAN_AD_DURATION_SEC, GINAN_SCHOOL_NAME, ginanAdMediaUrl };

/** 岐南 電子工学科 PoC に追加する USJC 1 社。固定 UUID は既存 91a0/91d0…0001〜0006 の続き 0007。 */
export const USJC_AD: GinanAdvertiserAd = {
  advertiserId: "91a00007-0000-4000-8000-000000000007",
  adId: "91d00007-0000-4000-8000-000000000007",
  companyName: "USJC",
  industry: "半導体ファウンドリ（UMC グループ）",
  notes: "岐南工業 電子工学科 PoC 掲載（2026-07 追加）。HP: https://www.usjpc.com/",
  mediaFile: "usjc.png",
  linkUrl: "https://www.usjpc.com/",
  displayOrder: 70,
} as const;

/** 自己整合性チェック（既存 seed の validateGinanAds を単一要素で流用）。CLI が DB 接続前に呼ぶ。 */
export function validateUsjcAd(): void {
  validateGinanAds([USJC_AD]);
}
