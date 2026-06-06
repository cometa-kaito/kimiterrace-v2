import { GINAN_SCHOOL_NAME } from "./seed-ginan-sensors.js";

/**
 * 岐阜県立岐南工業高等学校（電子工学科 1〜3 年 PoC）の **実契約 6 社のサイネージ広告**を
 * `advertisers`（広告主 CRM, #46/F10）+ `ads`（学校スコープ広告, #48-F）へ登録するシードのデータ定義。
 * 実行エントリは {@link ./seed-ginan-ads-cli.ts}。
 *
 * ## 出典 / 掲載クリエイティブ
 * 掲載画像は `学校DX事業/10_広告コンテンツ/<社名>/...` の各社「掲載」素材（4 社は PNG/JPG 完成版、
 * 日本クロージャー・アピは納品 PDF を 1 ページ目 PNG 化）。これらを staging の公開 GCS バケット
 * `signage-v2-staging-ad-media`（Terraform 管理）へアップロードし、その公開 URL を `media_url` に持つ。
 * **media_url はサイネージ端末が直接 GET する公開 URL**（広告は公開掲示物・PII を含まない）。
 *
 * ## リンク（link_url = タップ遷移先）
 * 各社の公式 HP トップ（2026-06-07 に HTTP 200 を実機確認）。高卒求人ルール（〜6/30 は誘致表現不可）に
 * 配慮し、遷移先は**会社案内トップ**（求人ページではない）に限定する。トーカイテックは旧 `index.html` が
 * 404 化していたため https ルートを採用。掲載クリエイティブ自体も「認知/紹介」基調で応募/説明会 CTA を含まない。
 *
 * ## スコープ = 'school'（堅牢性優先）
 * 岐南は単一学科（電子工学科）PoC ゆえ school スコープ = 電子工学科 1〜3 年の全クラスに表示され、
 * effective_ads_per_class VIEW の `scope='school'`（`a.school_id = c.school_id`）分岐で全クラスに伝搬する
 * （学科/学年の join 解決に依存しない最も確実な経路）。将来他学科が増えたら学科スコープへ絞り込み可能。
 *
 * ## 冪等性
 * advertiser/ad とも固定 UUID + `ON CONFLICT (id) DO UPDATE`。再実行で media_url/link_url/caption 等を
 * 最新化でき、手動編集との衝突は id 単位に限定される（UI で別途作られたクラス広告は touch しない）。
 */

/** staging 公開 GCS バケット（Terraform: modules/ad_media、envs/staging）。末尾スラッシュなし。 */
export const GINAN_AD_MEDIA_BASE =
  process.env.SEED_GINAN_AD_MEDIA_BASE ??
  "https://storage.googleapis.com/signage-v2-staging-ad-media/ginan";

export { GINAN_SCHOOL_NAME };

export interface GinanAdvertiserAd {
  /** advertisers.id（固定・冪等）。 */
  readonly advertiserId: string;
  /** ads.id（固定・冪等）。 */
  readonly adId: string;
  /** 会社正式名（advertisers.company_name、最大 200）。 */
  readonly companyName: string;
  /** 業種（advertisers.industry、最大 100）。 */
  readonly industry: string;
  /** CRM 備考（advertisers.notes）。連絡先は未確認のため空、用途のみ残す。 */
  readonly notes: string;
  /** 掲載クリエイティブのファイル名（GINAN_AD_MEDIA_BASE 配下のキー）。 */
  readonly mediaFile: string;
  /** タップ遷移先 = 公式 HP トップ（http(s)）。 */
  readonly linkUrl: string;
  /** 表示順（広告ローテーション）。 */
  readonly displayOrder: number;
}

/** 画像表示秒数（情報量が多い縦型クリエイティブのためやや長め）。 */
export const GINAN_AD_DURATION_SEC = 7;

/**
 * 岐南 電子工学科 PoC の実契約 6 社（2026-06 時点）。display_order 昇順でローテーション。
 * media_type は全て 'image'（PDF 納品分も PNG 化済）。caption は null（完成クリエイティブの意匠を
 * オーバーレイで損なわないため。広告主特定は advertiser_id 経由）。
 */
export const GINAN_ADS: readonly GinanAdvertiserAd[] = [
  {
    advertiserId: "91a00001-0000-4000-8000-000000000001",
    adId: "91d00001-0000-4000-8000-000000000001",
    companyName: "京三エレコス株式会社",
    industry: "鉄道信号システムの工事・保守（京三製作所グループ）",
    notes: "岐南工業 電子工学科 PoC 掲載。HP: https://www.kyosan-elcs.co.jp/",
    mediaFile: "kyosan-elcs.png",
    linkUrl: "https://www.kyosan-elcs.co.jp/",
    displayOrder: 10,
  },
  {
    advertiserId: "91a00002-0000-4000-8000-000000000002",
    adId: "91d00002-0000-4000-8000-000000000002",
    companyName: "株式会社シーテック",
    industry: "電気・通信・土木・再生可能エネルギー（中部電力グループ）",
    notes: "岐南工業 電子工学科 PoC 掲載。HP: https://www.ctechcorp.co.jp/",
    mediaFile: "ctech.png",
    linkUrl: "https://www.ctechcorp.co.jp/",
    displayOrder: 20,
  },
  {
    advertiserId: "91a00003-0000-4000-8000-000000000003",
    adId: "91d00003-0000-4000-8000-000000000003",
    companyName: "日本クロージャー株式会社",
    industry: "金属・樹脂キャップの製造（東洋製罐グループ）",
    notes: "岐南工業 電子工学科 PoC 掲載。HP: https://www.ncc-caps.co.jp/",
    mediaFile: "nihon-closures.png",
    linkUrl: "https://www.ncc-caps.co.jp/",
    displayOrder: 30,
  },
  {
    advertiserId: "91a00004-0000-4000-8000-000000000004",
    adId: "91d00004-0000-4000-8000-000000000004",
    companyName: "株式会社ギフ加藤製作所",
    industry: "精密加工・自動車制御機器部品の製造",
    notes: "岐南工業 電子工学科 PoC 掲載。HP: https://www.kgk.jp/",
    mediaFile: "gifu-kato.jpg",
    linkUrl: "https://www.kgk.jp/",
    displayOrder: 40,
  },
  {
    advertiserId: "91a00005-0000-4000-8000-000000000005",
    adId: "91d00005-0000-4000-8000-000000000005",
    companyName: "トーカイテック株式会社",
    industry: "東海道新幹線の電気設備保守",
    notes:
      "岐南工業 電子工学科 PoC 掲載。HP: https://www.tokai-tech.net/（〜6/30 求人誘致不可ゆえHPトップ）",
    mediaFile: "tokai-tech.png",
    linkUrl: "https://www.tokai-tech.net/",
    displayOrder: 50,
  },
  {
    advertiserId: "91a00006-0000-4000-8000-000000000006",
    adId: "91d00006-0000-4000-8000-000000000006",
    companyName: "アピ株式会社",
    industry: "蜂産品・健康食品・医薬品の受託製造",
    notes: "岐南工業 電子工学科 PoC 掲載。HP: https://www.api3838.co.jp/",
    mediaFile: "api.png",
    linkUrl: "https://www.api3838.co.jp/",
    displayOrder: 60,
  },
] as const;

/** media_url を組み立てる（base + '/' + file）。 */
export function ginanAdMediaUrl(mediaFile: string): string {
  return `${GINAN_AD_MEDIA_BASE}/${mediaFile}`;
}

/** 自己整合性チェック（id 一意・URL は http(s)・caption スコープ）。CLI が DB 接続前に呼ぶ。 */
export function validateGinanAds(ads: readonly GinanAdvertiserAd[]): void {
  const advIds = new Set<string>();
  const adIds = new Set<string>();
  const orders = new Set<number>();
  for (const a of ads) {
    if (advIds.has(a.advertiserId)) throw new Error(`duplicate advertiserId: ${a.advertiserId}`);
    if (adIds.has(a.adId)) throw new Error(`duplicate adId: ${a.adId}`);
    if (orders.has(a.displayOrder)) throw new Error(`duplicate displayOrder: ${a.displayOrder}`);
    advIds.add(a.advertiserId);
    adIds.add(a.adId);
    orders.add(a.displayOrder);
    if (a.companyName.length === 0 || a.companyName.length > 200) {
      throw new Error(`companyName length out of range: ${a.companyName}`);
    }
    for (const u of [a.linkUrl, ginanAdMediaUrl(a.mediaFile)]) {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        throw new Error(`invalid URL: ${u}`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`URL must be http(s): ${u}`);
      }
    }
  }
}
