import { type InferSelectModel, and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { adTargetMonitors } from "../schema/ad-target-monitors.js";
import { ads } from "../schema/ads.js";
import { advertisers } from "../schema/advertisers.js";
import { classes } from "../schema/classes.js";
import { contracts } from "../schema/contracts.js";
import { departments } from "../schema/departments.js";
import { grades } from "../schema/grades.js";
import { tvDevices } from "../schema/tv-devices.js";

/**
 * Partner API K3（`docs/api/partner-api-contract.md` §3）: **配信 push の受け口**（Flow B の v2 側）の
 * 冪等 upsert ドメインサービス。**write**（INSERT ... ON CONFLICT DO UPDATE）。
 *
 * portal（商流 SoR・別リポ・Supabase/Vercel）の承認時に Outbox 経由で送られる advertiser/contract/ads を、
 * portal 由来 ID（`portal_company_id` / `portal_contract_id` / `portal_placement_id`）を**冪等キー**に
 * `advertisers` / `contracts` / `ads` へ upsert する。同じ portal ID で再送しても二重作成しない
 * （Outbox 再送・契約 §3「冪等」と整合）。
 *
 * ## v2 = Read Model（契約 §4 / §42.2）
 * v2 が保持する advertiser/contract は**配信判断に必要な最小フィールドの Read Model**（portal=write 正、
 * v2=read 自律）。`status`(active/paused) を受けて配信可否に反映し、portal がダウンしても v2 は自律配信できる。
 *
 * ## テナント分離 / 可視範囲（CLAUDE.md ルール2 / ADR-019）
 * `school_id` 条件を**手書きしない**。CRM 表（`advertisers` / `contracts`）は `system_admin_full_access`
 * policy のみを持つため、呼び出しは **system_admin context**（`app.current_user_role='system_admin'`）で行う
 * 必要がある。その context では学校テナント表 `ads` も `system_admin_full_access` で全校横断に書ける
 * （運営入稿広告の経路、ads-crud RLS テストと同じ前提）。降格（tenantScoped）はしない（複数校横断が要件）。
 * 接続ロールは非 BYPASSRLS の `kimiterrace_app`。**BYPASSRLS 不使用**（ルール2）。
 *
 * ## 監査（ルール1）
 * upsert はシステム（portal）由来のため `created_by` / `updated_by` は **null**（システム作成）。
 * 更新時は `updated_at` / `updated_by` のみ進め、`created_at` / `created_by` は初回値を保つ
 * （railway-status / weather-forecasts の upsert と同方針）。
 *
 * ## 【要件1】contract は portalContractId が **null 可**（契約 §3）
 * portal 由来 ID を ON CONFLICT の競合キーにするが、Postgres の UNIQUE は **NULL を互いに distinct 扱い**する
 * （`partner-portal-ids` schema テストで pin 済）。したがって `portalContractId` が null の入力をそのまま
 * `onConflictDoUpdate(target=portal_contract_id)` に流すと、再送のたびに「競合しない新規行」を作り**冪等が壊れる**。
 * よって本実装は **`contract == null`（contract 未指定）または `portalContractId == null` の場合、contract を
 * upsert しない**（`applied.contracts = 0`）。これは安全側の決定的扱い:
 *   - `ads` は `contract_id` / `slot_id` を **持たない**（school_id + advertiser_id のみで関連、ads schema 確認済）
 *     ため、contract を書かなくても ads upsert の FK は壊れない。
 *   - 冪等キーを持たない contract を毎回作る方が（孤児契約の累積・冪等違反）よほど有害。
 * portal が contract を v2 に確実に反映したい場合は `portalContractId` を必ず付けて送る契約とする（§3 の
 * 冪等の前提）。`portalContractId` 付きなら通常どおり upsert（再送は同一行を更新）。
 *
 * 型は schema（`advertisers` / `contracts` / `ads`）から `InferSelectModel` 派生（ルール3、as any 禁止）。
 */

type AdvertiserRow = InferSelectModel<typeof advertisers>;
type ContractRow = InferSelectModel<typeof contracts>;
type AdRow = InferSelectModel<typeof ads>;

/** 配信受け口の advertiser 入力（Read Model 最小フィールド、契約 §3 camelCase）。 */
export type DeliveryAdvertiserInput = {
  portalCompanyId: NonNullable<AdvertiserRow["portalCompanyId"]>;
  companyName: AdvertiserRow["companyName"];
  industry: AdvertiserRow["industry"];
  contactEmail: AdvertiserRow["contactEmail"];
  /** 営業ステータス。配信可否（active/paused）に反映（契約 §4 Read Model）。 */
  status: AdvertiserRow["status"];
};

/** 配信受け口の contract 入力（契約 §3）。`portalContractId` は null 可（要件1、上記 doc 参照）。 */
export type DeliveryContractInput = {
  portalContractId: ContractRow["portalContractId"];
  monthlyFeeJpy: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /** 配信対象校（v2 `schools.id`）の配列。`contracts.target_schools` jsonb に格納。 */
  targetV2SchoolIds: string[];
};

/** 配信受け口の ad 入力（契約 §3）。`mediaUrl` は再ホスト後の GCS パス（route が解決して渡す）。 */
export type DeliveryAdInput = {
  portalPlacementId: NonNullable<AdRow["portalPlacementId"]>;
  v2SchoolId: AdRow["schoolId"];
  scope: AdRow["scope"];
  /**
   * 非 school スコープの対象（portal が送る学科名/学年名/クラス名）。school は null。
   * v2 が **学校内で名前一致解決**して grade_id/class_id/department_id を確定する（Phase4 §0b）。
   * 学校ブリッジ(v2_school_id)と違い、学校特定後の sub-scope 名前解決は低リスク（運営整理 §0b 判断）。
   */
  scopeRef: string | null;
  /**
   * scope='monitor' のとき配信対象モニタ（v2 `tv_devices.id`）の集合（portal の多選択）。他 scope では省略/空配列。
   * applyPartnerDelivery が当該校に属するモニタかを検証し（越境拒否）、ad_target_monitors を置換する。
   */
  targetMonitorIds?: string[];
  mediaType: AdRow["mediaType"];
  durationSec: number;
  displayOrder: number;
  /** 再ホスト済みの配信 URL（route が assetFetchUrl を解決して渡す。ここでは URL の出所は問わない）。 */
  mediaUrl: AdRow["mediaUrl"];
  caption: AdRow["caption"];
  linkUrl: AdRow["linkUrl"];
};

/**
 * scopeRef の名前解決が失敗（対象が学校内に無い / 曖昧）したことを表す**恒久エラー**。
 * route はこれを **409**（再送で直らない・portal 側の参照を直す必要）に写す。
 * pg の check/FK 違反(23514/23503)と同じ「恒久的整合不能」カテゴリ。
 */
export class ScopeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeResolutionError";
  }
}

/** scope 解決の結果（ads の check 制約 ck_ads_scope を満たす id セット）。 */
type ResolvedScopeIds = {
  gradeId: string | null;
  classId: string | null;
  departmentId: string | null;
};

/**
 * scope + scopeRef を v2 の階層 id へ**学校内で名前一致解決**する（Phase4 §0b・名前ベース解決）。
 * - school: 全 id null（学校全体）。
 * - department/grade: `ux_(departments|grades)_school_name` で学校内 name 一意 → 厳密一致。
 * - class: classes は name 単独で一意でない（学年/年度違い）ため、学校内 name 一致が **ちょうど1件**の
 *   ときのみ採用。0件/複数件は `ScopeResolutionError`（→409）で**保留**（誤対象配信を防ぐ）。
 * 見つからなければ `ScopeResolutionError`（恒久）。fail-closed（過剰/誤配信より保留）。
 */
async function resolveScopeIds(
  tx: TenantTx,
  schoolId: string,
  scope: AdRow["scope"],
  scopeRef: string | null,
): Promise<ResolvedScopeIds> {
  if (scope === "school") {
    return { gradeId: null, classId: null, departmentId: null };
  }
  // monitor: 階層 id は持たず ad_target_monitors 中間表で結ぶ（モニタ検証は resolveMonitorIds が担う）。
  if (scope === "monitor") {
    return { gradeId: null, classId: null, departmentId: null };
  }
  const ref = (scopeRef ?? "").trim();
  if (ref.length === 0) {
    throw new ScopeResolutionError(`scope '${scope}' requires scopeRef`);
  }

  if (scope === "department") {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.schoolId, schoolId), eq(departments.name, ref)));
    const row = rows[0];
    if (rows.length !== 1 || !row) {
      throw new ScopeResolutionError(`department '${ref}' not found in school`);
    }
    return { gradeId: null, classId: null, departmentId: row.id };
  }

  if (scope === "grade") {
    const rows = await tx
      .select({ id: grades.id })
      .from(grades)
      .where(and(eq(grades.schoolId, schoolId), eq(grades.name, ref)));
    const row = rows[0];
    if (rows.length !== 1 || !row) {
      throw new ScopeResolutionError(`grade '${ref}' not found in school`);
    }
    return { gradeId: row.id, classId: null, departmentId: null };
  }

  // scope === "class": name は学校内で一意でないため、ちょうど1件のときのみ採用。
  const rows = await tx
    .select({ id: classes.id })
    .from(classes)
    .where(and(eq(classes.schoolId, schoolId), eq(classes.name, ref)));
  const row = rows[0];
  if (rows.length !== 1 || !row) {
    throw new ScopeResolutionError(
      rows.length === 0
        ? `class '${ref}' not found in school`
        : `class '${ref}' is ambiguous in school (${rows.length} matches)`,
    );
  }
  return { gradeId: null, classId: row.id, departmentId: null };
}

/**
 * scope='monitor' の配信対象モニタ（tv_devices.id）を**当該校内で検証**する（Phase5）。
 * - 全 ID が当該 school の tv_devices（ソフトデリート除く）に属することを確認。1件でも欠ければ
 *   `ScopeResolutionError`（→409・保留）で fail-closed（他校モニタへの越境配信や存在しないモニタ指定を防ぐ）。
 * - 重複は除去。空集合（monitor なのに対象なし）も恒久エラー。
 * 返値は検証済みの一意な ID 配列。
 */
async function resolveMonitorIds(
  tx: TenantTx,
  schoolId: string,
  monitorIds: string[],
): Promise<string[]> {
  const ids = [...new Set((monitorIds ?? []).filter((m) => typeof m === "string" && m.length > 0))];
  if (ids.length === 0) {
    throw new ScopeResolutionError("scope 'monitor' requires at least one targetMonitorId");
  }
  const rows = await tx
    .select({ id: tvDevices.id })
    .from(tvDevices)
    .where(
      and(
        eq(tvDevices.schoolId, schoolId),
        inArray(tvDevices.id, ids),
        isNull(tvDevices.deletedAt),
      ),
    );
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ScopeResolutionError(`monitor(s) not found in school: ${missing.join(", ")}`);
  }
  return ids;
}

export type DeliveryInput = {
  advertiser: DeliveryAdvertiserInput;
  /** null = contract を反映しない（portal が contract を送らない契約もありうる、契約 §3）。 */
  contract: DeliveryContractInput | null;
  ads: DeliveryAdInput[];
};

/** 反映件数 + 紐付いた v2 advertiser id（契約 §3 の 200 レスポンスへ写す）。 */
export type DeliveryResult = {
  applied: { advertisers: number; contracts: number; ads: number };
  advertiserId: string;
};

/**
 * advertiser / contract / ads を portal 由来 ID を冪等キーに upsert する（**system_admin context の tx で呼ぶ**）。
 *
 * - advertisers: ON CONFLICT (portal_company_id) DO UPDATE で companyName/industry/contactEmail/status を最新化。
 * - contracts: `contract` 且つ `portalContractId` が非 null のときのみ ON CONFLICT (portal_contract_id) で upsert
 *   （要件1: null は冪等が壊れるため反映しない）。
 * - ads: ON CONFLICT (portal_placement_id) DO UPDATE で schoolId/scope/mediaUrl/mediaType/durationSec/
 *   displayOrder/caption/linkUrl を最新化（status は ads に列が無く、配信可否は advertiser.status で表現）。
 *
 * すべて同一 tx（原子的）。`fn` 内の例外は呼び出し側へ伝播し、route が §3 のステータスへ写す。
 *
 * @param tx system_admin context を張った非 BYPASSRLS の TenantTx。
 */
export async function applyPartnerDelivery(
  tx: TenantTx,
  input: DeliveryInput,
): Promise<DeliveryResult> {
  // 1. advertiser を upsert（冪等キー = portal_company_id）。created_by/updated_by は null（システム作成）。
  const advRows = await tx
    .insert(advertisers)
    .values({
      portalCompanyId: input.advertiser.portalCompanyId,
      companyName: input.advertiser.companyName,
      industry: input.advertiser.industry,
      contactEmail: input.advertiser.contactEmail,
      status: input.advertiser.status,
      // status ↔ is_active 不変条件（advertisers schema doc）: paused ⟺ is_active=false。
      isActive: input.advertiser.status !== "paused",
      createdBy: null,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: advertisers.portalCompanyId,
      set: {
        companyName: input.advertiser.companyName,
        industry: input.advertiser.industry,
        contactEmail: input.advertiser.contactEmail,
        status: input.advertiser.status,
        isActive: input.advertiser.status !== "paused",
        updatedAt: new Date(),
        updatedBy: null,
      },
    })
    .returning({ id: advertisers.id });
  const advertiserId = advRows[0]?.id;
  if (!advertiserId) {
    throw new Error("applyPartnerDelivery: advertiser upsert が行を返しませんでした");
  }

  // 2. contract を upsert（要件1: portalContractId 非 null のときのみ。null は冪等が壊れるため反映しない）。
  let contractsApplied = 0;
  if (input.contract && input.contract.portalContractId != null) {
    const c = input.contract;
    // monthly_fee_jpy / started_at は NOT NULL。portal が欠落値を送った場合は安全な既定で埋める
    // （費用 0 / 開始 now）。これらは v2 の Read Model（配信可否は status 主導）であり請求は portal 専有のため、
    // 欠落で配信判断は壊れない。status は advertiser.status を引き継ぐ（contract 独自 status は portal 専有）。
    const contractStatusValue = input.advertiser.status === "paused" ? "paused" : "active";
    await tx
      .insert(contracts)
      .values({
        portalContractId: c.portalContractId,
        advertiserId,
        status: contractStatusValue,
        startedAt: c.startedAt ?? new Date(),
        endedAt: c.endedAt,
        monthlyFeeJpy: c.monthlyFeeJpy ?? 0,
        targetSchools: c.targetV2SchoolIds,
        createdBy: null,
        updatedBy: null,
      })
      .onConflictDoUpdate({
        target: contracts.portalContractId,
        set: {
          advertiserId,
          status: contractStatusValue,
          startedAt: c.startedAt ?? new Date(),
          endedAt: c.endedAt,
          monthlyFeeJpy: c.monthlyFeeJpy ?? 0,
          targetSchools: c.targetV2SchoolIds,
          updatedAt: new Date(),
          updatedBy: null,
        },
      });
    contractsApplied = 1;
  }

  // 3. ads を upsert（冪等キー = portal_placement_id）。1 件ずつ（件数は最低 1・通常少数）。
  //    scope が非 school なら scopeRef を学校内で名前解決し、grade_id/class_id/department_id を確定する
  //    （ck_ads_scope を満たす）。解決失敗は ScopeResolutionError（→409・保留）で tx ごと中断＝部分反映しない。
  //    scope を切替えた更新でも未使用 id を毎回 null で上書きするため check 違反は起きない。
  let adsApplied = 0;
  for (const a of input.ads) {
    const { gradeId, classId, departmentId } = await resolveScopeIds(
      tx,
      a.v2SchoolId,
      a.scope,
      a.scopeRef,
    );
    // scope='monitor' は対象モニタを当該校内で事前検証（fail-closed: 不正なら ad を書く前に 409 で中断）。
    const monitorIds =
      a.scope === "monitor"
        ? await resolveMonitorIds(tx, a.v2SchoolId, a.targetMonitorIds ?? [])
        : [];
    const upserted = await tx
      .insert(ads)
      .values({
        portalPlacementId: a.portalPlacementId,
        schoolId: a.v2SchoolId,
        scope: a.scope,
        gradeId,
        classId,
        departmentId,
        advertiserId,
        mediaUrl: a.mediaUrl,
        mediaType: a.mediaType,
        durationSec: a.durationSec,
        displayOrder: a.displayOrder,
        caption: a.caption,
        linkUrl: a.linkUrl,
        createdBy: null,
        updatedBy: null,
      })
      .onConflictDoUpdate({
        // 冪等キーは **(portal_placement_id, school_id) の複合**（20260724075009_multi_school_ads）。
        // portal の複数校ループは 1 placement から校ごとに1広告行を生むため、単独キーだと
        // 2 校目以降が 1 行目を上書きし、エラーも出さずに最後の1校だけが残る。
        target: [ads.portalPlacementId, ads.schoolId],
        set: {
          schoolId: a.v2SchoolId,
          scope: a.scope,
          gradeId,
          classId,
          departmentId,
          advertiserId,
          mediaUrl: a.mediaUrl,
          mediaType: a.mediaType,
          durationSec: a.durationSec,
          displayOrder: a.displayOrder,
          caption: a.caption,
          linkUrl: a.linkUrl,
          updatedAt: new Date(),
          updatedBy: null,
        },
      })
      .returning({ id: ads.id });
    const adId = upserted[0]?.id;
    if (!adId) {
      throw new Error("applyPartnerDelivery: ad upsert が行を返しませんでした");
    }
    // モニタ紐付けを置換（冪等）。scope を monitor から他へ切り替えた再送でも古い紐付けを掃除する。
    await tx.delete(adTargetMonitors).where(eq(adTargetMonitors.adId, adId));
    if (a.scope === "monitor") {
      await tx.insert(adTargetMonitors).values(
        monitorIds.map((monitorId) => ({
          adId,
          monitorId,
          schoolId: a.v2SchoolId,
          createdBy: null,
          updatedBy: null,
        })),
      );
    }
    adsApplied += 1;
  }

  // 4. 今回送られてこなかった校の広告行を掃除する（複数校ループの対象校が減ったときの取り残し防止）。
  //    upsert だけでは「3校 → 2校」に変えた再送で 3 校目が残り続け、契約が終わった学校に映り続ける。
  //    冪等キーが placement 単独だった頃は 1 行しか存在し得ず不要だった掃除で、複合キー化の対と対。
  //    ad_target_monitors は ad_id の ON DELETE CASCADE で一緒に消える。
  const schoolsByPlacement = new Map<string, string[]>();
  for (const a of input.ads) {
    schoolsByPlacement.set(a.portalPlacementId, [
      ...(schoolsByPlacement.get(a.portalPlacementId) ?? []),
      a.v2SchoolId,
    ]);
  }
  for (const [placementId, schoolIds] of schoolsByPlacement) {
    await tx
      .delete(ads)
      .where(and(eq(ads.portalPlacementId, placementId), notInArray(ads.schoolId, schoolIds)));
  }

  return {
    applied: { advertisers: 1, contracts: contractsApplied, ads: adsApplied },
    advertiserId,
  };
}

/** 指定 portal_company_id の advertiser を引く（テスト/冪等検証の補助、system_admin context で読む）。 */
export async function findAdvertiserByPortalCompanyId(
  tx: TenantTx,
  portalCompanyId: string,
): Promise<AdvertiserRow | null> {
  const rows = await tx
    .select()
    .from(advertisers)
    .where(eq(advertisers.portalCompanyId, portalCompanyId))
    .limit(1);
  return rows[0] ?? null;
}
