import { type InferSelectModel, and, asc, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { ads } from "../schema/ads.js";
import { classes } from "../schema/classes.js";
import { departments } from "../schema/departments.js";
import { grades } from "../schema/grades.js";

/**
 * クラススコープ広告の CRUD 読み取りクエリ層 (#48-J)。
 *
 * **RLS (ルール2)**: すべて `withSession` の自校コンテキスト tx 内で呼ぶ。`ads` / `classes` の
 * SELECT は `app.current_school_id` で自校に限定される (手書き WHERE school_id は書かない、
 * DB レベルで強制)。別テナントの class_id / ad_id は不可視 → not found 扱い。
 *
 * **型 (ルール3)**: 行型は schema の `ads` テーブルから `InferSelectModel` で派生する
 * (手書き interface を作らない)。親階層から継承される広告の読み取りは別 VIEW
 * (`effective_ads_per_class` / `getEffectiveAdsForClass`) を使う — 本ファイルは
 * **自クラススコープの広告 (scope='class' AND class_id=該当)** のみを対象とし、編集可能な行だけを返す。
 */

/** `ads` テーブルの 1 行 (= 1 広告)。schema 由来 (単一ソース)。 */
export type Ad = InferSelectModel<typeof ads>;

/** UI 表示用に絞った自クラス広告の 1 行 (監査カラム等は UI に渡さない)。 */
export type ClassAdView = {
  id: string;
  mediaUrl: string;
  mediaType: Ad["mediaType"];
  durationSec: number;
  linkUrl: string | null;
  caption: string | null;
  captionFontScale: number;
  displayOrder: number;
};

function toView(row: Ad): ClassAdView {
  return {
    id: row.id,
    mediaUrl: row.mediaUrl,
    mediaType: row.mediaType,
    durationSec: row.durationSec,
    linkUrl: row.linkUrl,
    caption: row.caption,
    captionFontScale: row.captionFontScale,
    displayOrder: row.displayOrder,
  };
}

/**
 * 指定クラスの**自クラススコープ**広告 (scope='class' AND class_id=該当) を表示順で返す。
 * 親階層 (学校 / 学科 / 学年) から継承される広告は含まない (継承分は別 VIEW で読む)。
 * 別テナントの class_id は RLS で不可視 → 空配列。
 */
export async function listClassOwnAds(tx: TenantTx, classId: string): Promise<ClassAdView[]> {
  const rows = await tx
    .select()
    .from(ads)
    .where(and(eq(ads.scope, "class"), eq(ads.classId, classId)))
    .orderBy(asc(ads.displayOrder), asc(ads.id));
  return rows.map(toView);
}

/**
 * クラスが自校で可視か確認し、表示名を返す (cross-tenant 防御の第一段)。
 * 別テナント / 不存在は null。
 */
export async function findVisibleClass(
  tx: TenantTx,
  classId: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await tx
    .select({ id: classes.id, name: classes.name })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  return row ?? null;
}

/**
 * 自クラススコープ広告 1 件を id で取得する (update / delete の before スナップショット用)。
 * 別テナント / 他スコープ / 不存在は null。
 */
export async function findClassOwnAd(tx: TenantTx, adId: string): Promise<Ad | null> {
  const [row] = await tx
    .select()
    .from(ads)
    .where(and(eq(ads.id, adId), eq(ads.scope, "class")))
    .limit(1);
  return row ?? null;
}

/**
 * スコープターゲットの解決済み列 (= `targetIdColumns(EditorTarget)` の出力)。`scope` と `*_id` の組は
 * `ck_ads_scope` / `ck_school_configs_scope` を充足する前提 (app 層が targetIdColumns で導出する)。
 * school→全 NULL / department→departmentId / grade→gradeId / class→classId。
 */
export type ScopeColumns = {
  scope: Ad["scope"];
  gradeId: string | null;
  departmentId: string | null;
  classId: string | null;
};

/** scope + 3 つの id 列を null 安全に突き合わせる WHERE (継承元の 1 階層分を一意に選ぶ)。 */
function scopeWhere(t: ScopeColumns) {
  return and(
    eq(ads.scope, t.scope),
    t.gradeId === null ? isNull(ads.gradeId) : eq(ads.gradeId, t.gradeId),
    t.departmentId === null ? isNull(ads.departmentId) : eq(ads.departmentId, t.departmentId),
    t.classId === null ? isNull(ads.classId) : eq(ads.classId, t.classId),
  );
}

/**
 * 指定スコープ (school/department/grade/class) の**自スコープ**広告を表示順で返す。
 * 親階層から継承される広告は含まない (継承分は effective_ads_per_class VIEW で読む)。
 * 別テナントの id は RLS で不可視 → 空配列。{@link listClassOwnAds} の scope 汎用版。
 */
export async function listOwnAds(tx: TenantTx, target: ScopeColumns): Promise<ClassAdView[]> {
  const rows = await tx
    .select()
    .from(ads)
    .where(scopeWhere(target))
    .orderBy(asc(ads.displayOrder), asc(ads.id));
  return rows.map(toView);
}

/**
 * 自スコープ広告 1 件を id + スコープ一致で取得する (update / delete の before スナップショット用)。
 * id が当該スコープ・ターゲットに属さない / 別テナント / 不存在は null。{@link findClassOwnAd} の汎用版で、
 * scope だけでなく対象 id まで一致を要求する (他クラス・他学年の広告を誤って触らない)。
 */
export async function findOwnAd(
  tx: TenantTx,
  adId: string,
  target: ScopeColumns,
): Promise<Ad | null> {
  const [row] = await tx
    .select()
    .from(ads)
    .where(and(eq(ads.id, adId), scopeWhere(target)))
    .limit(1);
  return row ?? null;
}

/**
 * スコープターゲット (学科 / 学年 / クラス) が**自校で可視**か確認し表示名を返す (cross-tenant 防御の第一段)。
 * RLS (tenant_isolation) 下の SELECT ゆえ別テナントの行は不可視 → null。school スコープは自校コンテキスト
 * 自体が対象なので常に可視 (id 不要)。別テナント / 不存在は null。
 */
export async function findVisibleTarget(
  tx: TenantTx,
  target: ScopeColumns,
): Promise<{ name: string } | null> {
  if (target.scope === "school") {
    return { name: "学校全体" };
  }
  if (target.scope === "grade" && target.gradeId !== null) {
    const [row] = await tx
      .select({ name: grades.name })
      .from(grades)
      .where(eq(grades.id, target.gradeId))
      .limit(1);
    return row ?? null;
  }
  if (target.scope === "department" && target.departmentId !== null) {
    const [row] = await tx
      .select({ name: departments.name })
      .from(departments)
      .where(eq(departments.id, target.departmentId))
      .limit(1);
    return row ?? null;
  }
  if (target.scope === "class" && target.classId !== null) {
    const [row] = await tx
      .select({ name: classes.name })
      .from(classes)
      .where(eq(classes.id, target.classId))
      .limit(1);
    return row ?? null;
  }
  return null;
}
