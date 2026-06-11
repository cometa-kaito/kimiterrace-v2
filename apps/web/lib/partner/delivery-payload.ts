import type {
  DeliveryAdInput,
  DeliveryAdvertiserInput,
  DeliveryContractInput,
  DeliveryInput,
} from "@kimiterrace/db";
import { adMediaType, advertiserStatus, hierarchyScope } from "@kimiterrace/db/schema";
import { z } from "zod";

/**
 * Partner API K3（`docs/api/partner-api-contract.md` §3）配信受け口の **payload 検証 + 正規化**（pure）。
 *
 * `"use server"`/route から検証ロジックを分離する（ads-core.ts と同構成）。route はこの戻り値（DB 入力型に
 * 正規化済み）を `applyPartnerDelivery` へそのまま渡せる。型は **DB 由来**（`@kimiterrace/db` の Delivery*Input）
 * に合わせ、enum 許容値は `@kimiterrace/db/schema` の enum を単一ソースとする（ルール3、手書き列挙しない）。
 *
 * **client-safe import**: enum/型は `@kimiterrace/db/schema`（postgres を引き込まない）と type-only import で
 * 取得する（barrel `@kimiterrace/db` の値 import は postgres を引き込むため、ここでは型のみ）。
 *
 * ## 【要件2】このモジュールの失敗 = 恒久（4xx）
 * payload 形不正・enum 外・UUID 不正・ads 0 件は「再送で直らない」ので route は **400/422**。
 * DB 一時エラー・asset 取得失敗は route 側の別経路で **5xx**（再送で回復しうる）。
 */

// enum 許容値は DB enum を単一ソースに（ルール3）。
const STATUS_VALUES = advertiserStatus.enumValues as [string, ...string[]];
const MEDIA_TYPE_VALUES = adMediaType.enumValues as [string, ...string[]];
const SCOPE_VALUES = hierarchyScope.enumValues as [string, ...string[]];

const CAPTION_MAX = 60; // ads.caption varchar(60)
const URL_MAX = 2048; // text だが暴走入力防止の実務上限
const COMPANY_NAME_MAX = 200; // advertisers.company_name varchar(200)
const INDUSTRY_MAX = 100; // advertisers.industry varchar(100)
const EMAIL_MAX = 320; // advertisers.contact_email varchar(320)
const DURATION_MIN = 1; // ck_ads_duration_positive (> 0)
const DURATION_MAX = 300;
const ORDER_MIN = 0;
const ORDER_MAX = 32767;
const MAX_ADS = 200; // 1 配信あたりの ads 上限（暴走防止）

/** http(s) 絶対 URL のみ（javascript: 等を弾く）。1..URL_MAX 文字。 */
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(URL_MAX)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

/** 空文字を null に正規化する任意文字列（contactEmail/caption/linkUrl 等）。 */
const nullableTrimmed = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v == null) return null;
      const t = v.trim();
      return t.length === 0 ? null : t;
    })
    .refine((v) => v == null || v.length <= max, `must be at most ${max} chars`);

const advertiserSchema = z.object({
  portalCompanyId: z.string().uuid(),
  companyName: z.string().trim().min(1).max(COMPANY_NAME_MAX),
  industry: nullableTrimmed(INDUSTRY_MAX),
  contactEmail: nullableTrimmed(EMAIL_MAX),
  status: z.enum(STATUS_VALUES),
});

const contractSchema = z
  .object({
    portalContractId: z.union([z.string().uuid(), z.null()]).optional(),
    monthlyFeeJpy: z.union([z.number().int().nonnegative(), z.null()]).optional(),
    startedAt: z.union([z.string(), z.null()]).optional(),
    endedAt: z.union([z.string(), z.null()]).optional(),
    targetV2SchoolIds: z.array(z.string().uuid()).default([]),
  })
  .nullable()
  .optional();

const adSchema = z.object({
  portalPlacementId: z.string().uuid(),
  v2SchoolId: z.string().uuid(),
  scope: z.enum(SCOPE_VALUES),
  mediaType: z.enum(MEDIA_TYPE_VALUES),
  durationSec: z.number().int().min(DURATION_MIN).max(DURATION_MAX),
  displayOrder: z.number().int().min(ORDER_MIN).max(ORDER_MAX),
  assetFetchUrl: httpUrl,
  caption: nullableTrimmed(CAPTION_MAX),
  linkUrl: z
    .union([httpUrl, z.null()])
    .optional()
    .transform((v) => v ?? null),
});

const payloadSchema = z.object({
  advertiser: advertiserSchema,
  contract: contractSchema,
  ads: z.array(adSchema).min(1).max(MAX_ADS),
});

/** 検証済みの 1 ad（`assetFetchUrl` は再ホスト前。route が再ホストして mediaUrl を確定）。 */
export type ValidatedAd = Omit<DeliveryAdInput, "mediaUrl"> & { assetFetchUrl: string };

/** 検証済み payload（DB 入力型に正規化済み。ads のみ assetFetchUrl を保持し route が再ホスト）。 */
export type ValidatedDelivery = {
  advertiser: DeliveryAdvertiserInput;
  contract: DeliveryContractInput | null;
  ads: ValidatedAd[];
};

export type ParseResult = { ok: true; value: ValidatedDelivery } | { ok: false; error: string };

/** 日付文字列を Date に。空/null は null。不正な日付は throw せず呼出側で弾けるよう undefined を区別。 */
function parseDate(value: string | null | undefined): Date | null | undefined {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * 受信 body を検証・正規化する。失敗（恒久・4xx）は `{ ok:false }`。型は DB 由来へ正規化する（ルール3）。
 * enum/UUID/必須/ads≥1 を強制し、不正は全体を拒否する（部分反映しない）。
 */
export function parseDeliveryPayload(raw: unknown): ParseResult {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid payload" };
  }
  const p = parsed.data;

  const advertiser: DeliveryAdvertiserInput = {
    portalCompanyId: p.advertiser.portalCompanyId,
    companyName: p.advertiser.companyName,
    industry: p.advertiser.industry,
    contactEmail: p.advertiser.contactEmail,
    // z.enum で許容値を絞り込み済み。DB enum と同一値域のため安全に narrow（as any 不使用）。
    status: p.advertiser.status as DeliveryAdvertiserInput["status"],
  };

  let contract: DeliveryContractInput | null = null;
  if (p.contract) {
    const startedAt = parseDate(p.contract.startedAt);
    const endedAt = parseDate(p.contract.endedAt);
    if (startedAt === undefined || endedAt === undefined) {
      return { ok: false, error: "invalid contract date" };
    }
    contract = {
      portalContractId: p.contract.portalContractId ?? null,
      monthlyFeeJpy: p.contract.monthlyFeeJpy ?? null,
      startedAt,
      endedAt,
      targetV2SchoolIds: p.contract.targetV2SchoolIds,
    };
  }

  const ads: ValidatedAd[] = p.ads.map((a) => ({
    portalPlacementId: a.portalPlacementId,
    v2SchoolId: a.v2SchoolId,
    scope: a.scope as ValidatedAd["scope"],
    mediaType: a.mediaType as ValidatedAd["mediaType"],
    durationSec: a.durationSec,
    displayOrder: a.displayOrder,
    assetFetchUrl: a.assetFetchUrl,
    caption: a.caption,
    linkUrl: a.linkUrl,
  }));

  return { ok: true, value: { advertiser, contract, ads } };
}

/** `DeliveryInput` 型へ再エクスポート（route が applyPartnerDelivery へ渡す形を組む補助）。 */
export type { DeliveryInput };
