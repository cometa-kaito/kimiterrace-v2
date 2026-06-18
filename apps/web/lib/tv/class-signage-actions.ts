"use server";

import {
  type IssuedMagicLink,
  type TenantTx,
  createClassMagicLink,
  getVisibleClassSchoolId,
  listClassMagicLinks,
} from "@kimiterrace/db";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { getRequestOrigin } from "../http/request-origin";
import { generateToken, hashToken } from "../magic-link/token";
import {
  type SchoolClassForAdPlacement,
  listSchoolClassesForAdPlacement,
} from "../system-admin/ad-placement-queries";
import { type ActionResult, invalid, isUuid } from "./config-edit-core";
import { ONBOARDING_ROLES } from "./onboarding-core";

/**
 * ADR-042 D6: TV デバイス作成フォームの「クラス選択」化を支える Server Action。
 *
 * モニタ追加は従来「学校作成 → クラス作成 → magic-link をその場限りで発行 → URL を手コピペ」と往復が重かった
 * （ADR-042 文脈）。本 Action は **クラスを 1 つ選ぶだけ**で、そのクラスのサイネージ用 base URL
 * （`{origin}/signage/<token>`）を返す。フォームはこれを signageUrl 欄に充填し、design (`?design=patternN`) の
 * 合成は既存の保存ロジック（`applyDesignPatternToUrl`）に委ねる（D6: design はフォーム側が持つ）。
 *
 * **認可（system_admin 限定・cross-tenant）**: tv-device 新規登録と同じ `ONBOARDING_ROLES`（= system_admin）。
 * system_admin は任意校のクラスを選べるため、`withSession`（`system_admin_full_access` policy）で cross-tenant に
 * 実行し、school は `getVisibleClassSchoolId` で対象クラスから解決する（magic-links API / provisioning と同作法）。
 *
 * **再利用 / 新規発行（ADR-042 D1/D2）**: 当該クラスに**有効（`revoked_at IS NULL`）かつ平文 `token` を持つ**
 * magic_link が既にあれば、その最新の 1 本を**再利用**する（PR2 で平文保存・無期限既定になったため URL を再構築
 * できる）。無ければ発行 API と同じ token 生成・ハッシュで、**無期限（`expiresAt` 未指定 = NULL）** の magic_link
 * を新規発行する。トークンの平文・hash は **audit / ログに出さない**（ルール5 / PR2 と同じ規律。`createClassMagicLink`
 * と queries 層が監査 diff から token を除外する）。
 */

/** クラス選択 → signage URL 取得の結果。フォームが signageUrl 欄へ充填する base URL（design 無し）。 */
export type ClassSignageUrlResult = { signageUrl: string };

/** フォームのクラスセレクトに出す 1 クラスの最小情報（識別子・ラベル）。 */
export type ClassOption = {
  classId: string;
  /** クラスセレクトの表示・ラベル既定補完に使う表示名（学科制「学科 学年」/ クラス制「学年 組」）。 */
  label: string;
};

/**
 * `listSchoolClassesForAdPlacement` の行を、フォーム表示用のラベルへ整形する。`formatClassIdentity` と同じ規約に
 * 倣う（学科制＝departmentName あり: 「学科 学年」で組を落とす / クラス制: 「学年 組」）。サイネージ盤面ヘッダや
 * 既存のクラス picker（ClassPickerPage）と同じ見え方にするための単一規約。
 */
function classOptionLabel(c: SchoolClassForAdPlacement): string {
  const parts = c.departmentName?.trim()
    ? [c.departmentName, c.gradeName]
    : [c.gradeName, c.className];
  const label = parts
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.length > 0)
    .join(" ");
  return label || c.className;
}

/**
 * ADR-042 D6: フォームの学校→クラス連動取得。選択された学校のクラス一覧を**ラベル整形して**返す
 * （クライアントが扱いやすい最小形）。
 *
 * **認可（system_admin 限定・cross-tenant）**: tv-device 登録と同じ `ONBOARDING_ROLES`。`withSession`
 * （`system_admin_full_access`）下で任意校のクラスを可視にする。テナント境界は RLS が担保（手書き WHERE は
 * 対象校の特定であって越境防止ではない・ルール2）。不正 schoolId は invalid で DB に到達させない。
 */
export async function listClassesForSchoolAction(
  schoolId: unknown,
): Promise<ActionResult<{ classes: ClassOption[] }>> {
  if (!isUuid(schoolId)) {
    return invalid("学校を選択してください。");
  }
  await requireRole(ONBOARDING_ROLES);
  const classes = await withSession(
    async (tx: TenantTx) => {
      const rows = await listSchoolClassesForAdPlacement(tx, schoolId);
      return rows.map((c) => ({ classId: c.classId, label: classOptionLabel(c) }));
    },
    { allowedRoles: ONBOARDING_ROLES },
  );
  return { ok: true, data: { classes } };
}

/**
 * クラスの有効リンクから**再利用可能な最新の 1 本**（平文 token あり・未失効）を選ぶ。`listClassMagicLinks` は
 * 既定で失効済を除外し、新しい順（`createdAt` desc）で返すため、先頭の token 付きリンクが最新の再利用候補。
 * PR2 以前発行の旧リンク（`token` が NULL）は URL を再構築できないので再利用しない（スキップして発行へ）。
 */
function pickReusableLink(links: IssuedMagicLink[]): IssuedMagicLink | undefined {
  return links.find((l) => l.token !== null);
}

/**
 * 指定クラスのサイネージ base URL（`{origin}/signage/<token>`、design 無し）を **get-or-create** で返す。
 *
 * @param classId 設置先クラス（フォームの学校→クラス選択で得た UUID）。
 * @returns 再利用 or 新規発行したトークンの signage base URL。design はフォーム側が合成する。
 */
export async function getOrCreateClassSignageUrl(
  classId: unknown,
): Promise<ActionResult<ClassSignageUrlResult>> {
  if (!isUuid(classId)) {
    return invalid("クラスを選択してください。");
  }

  // 公開オリジン（正準 NEXT_PUBLIC_APP_URL 優先・ヘッダ詐称に依存しない、request-origin.ts）。生成 URL は端末/
  // 運用者へ渡すため、origin が攻撃者に影響されない正準ソースを使う。解決不能（リクエスト外等）は invalid。
  const origin = await getRequestOrigin();
  if (!origin) {
    return invalid("サイネージ URL のオリジンを解決できませんでした。");
  }

  // system_admin 限定。role 不足は requireRole が /forbidden へ。
  const user = await requireRole(ONBOARDING_ROLES);

  const token = await withSession(
    async (tx: TenantTx) => {
      // 対象クラスの学校を cross-tenant 解決（system_admin_full_access 下で全校可視）。不可視/不存在は null。
      const schoolId = await getVisibleClassSchoolId(tx, classId);
      if (!schoolId) {
        return null;
      }

      // 既存の有効リンク（未失効・平文 token あり）があれば最新 1 本を再利用（ADR-042 D1/D2）。
      const existing = await listClassMagicLinks(tx, classId);
      const reusable = pickReusableLink(existing);
      if (reusable?.token) {
        return reusable.token;
      }

      // 無ければ新規発行。発行 API と同じ token 生成・ハッシュで、無期限（expiresAt 未指定 = NULL）に発行する。
      // 平文 token を列に保存（再表示用・PR2 D2）。token/hash は監査 diff に載らない（queries 層が除外・ルール5）。
      const fresh = generateToken();
      const issued = await createClassMagicLink(tx, {
        schoolId,
        classId,
        tokenHash: hashToken(fresh),
        token: fresh,
        // expiresAt は未指定 = NULL（無期限）を明示（ADR-042 D1）。
        // system_admin は users 行でないため actor は userId=null + IdP uid を identityUid に載せる（ルール1）。
        actor: { userId: null, identityUid: user.uid },
      });
      return issued.token;
    },
    { allowedRoles: ONBOARDING_ROLES },
  );

  if (!token) {
    return invalid("クラスが見つかりません。一覧から選び直してください。");
  }

  // base signage URL（design 無し）。design `?design=patternN` の合成はフォーム既存の保存ロジックに任せる（D6）。
  return { ok: true, data: { signageUrl: `${origin}/signage/${token}` } };
}
