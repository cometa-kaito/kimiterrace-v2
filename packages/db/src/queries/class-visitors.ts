import { type InferSelectModel, and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TenantTx } from "../client.js";
import { classVisitors } from "../schema/class-visitors.js";
import { classes } from "../schema/classes.js";

/**
 * パターン2「来校者一覧」の read 層（F: 来校者・2026-06-10）。**SELECT のみ**（書き込みは編集 Action 側）。
 *
 * ## テナント分離（ルール2）
 * `school_id` 条件を**書かない** — 呼び出し接続の RLS コンテキスト（`app.current_school_id`、ADR-019）が
 * `class_visitors` の `tenant_isolation` policy で自校行に絞る。サイネージ経路は `getSignageDisplayData` の
 * `withTenantContext({ schoolId })` 内で呼ぶため、結果も自校スコープになる。`class_id` で当該クラスに、
 * `visit_date` で当日（JST 暦日）に絞る。`db` は非 BYPASSRLS 接続（kimiterrace_app）を使うこと。
 *
 * ## 型の単一ソース（ルール3）
 * 返却型 `ClassVisitor` は schema の `classVisitors` から `InferSelectModel` で派生する（手書きドメイン型を
 * 作らない）。監査列・schoolId/classId/visitDate（識別子・スコープ）は表示に不要なので射影から除く。
 */

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** 来校者 1 件（表示用射影）。氏名は必須、他は任意（null）。 */
export type ClassVisitor = Pick<
  InferSelectModel<typeof classVisitors>,
  "id" | "visitorName" | "affiliation" | "scheduledTime" | "purpose" | "host" | "note"
>;

/**
 * 指定クラスの指定日（JST 暦日 = `date`）の来校者一覧を取得する（RLS で自校スコープ）。
 * 並び順は **表示順（`sort_order` 昇順）** を最優先に、同順位は時刻（`scheduled_time` 昇順、未設定は末尾＝
 * NULLS LAST）→ 氏名で決定的に。教員が編集 UI で並べ替えた順を盤面に反映する（保存時に行位置を sort_order に
 * 採番）。旧データ（採番前）は sort_order=0 で揃うため従来どおり時刻→氏名順になる（後方互換、migration 0034）。
 *
 * @param db      非 BYPASSRLS の Drizzle クライアント / tx（RLS context 下で呼ぶこと）。
 * @param classId 対象クラス。
 * @param date    対象 JST 暦日（YYYY-MM-DD）。サイネージ表示日と同じ値を渡す。
 */
export async function getVisitorsForClass(
  db: Selectable,
  classId: string,
  date: string,
): Promise<ClassVisitor[]> {
  return db
    .select({
      id: classVisitors.id,
      visitorName: classVisitors.visitorName,
      affiliation: classVisitors.affiliation,
      scheduledTime: classVisitors.scheduledTime,
      purpose: classVisitors.purpose,
      host: classVisitors.host,
      note: classVisitors.note,
    })
    .from(classVisitors)
    .where(and(eq(classVisitors.classId, classId), eq(classVisitors.visitDate, date)))
    .orderBy(
      asc(classVisitors.sortOrder),
      asc(classVisitors.scheduledTime),
      asc(classVisitors.visitorName),
    );
}

/** 来校者 1 件の書き込み入力（編集 Action が検証・正規化して渡す。空欄は null）。 */
export type ClassVisitorInput = {
  visitorName: string;
  affiliation: string | null;
  scheduledTime: string | null;
  purpose: string | null;
  host: string | null;
  note: string | null;
};

export type ReplaceClassVisitorsParams = {
  schoolId: string;
  classId: string;
  date: string;
  items: ClassVisitorInput[];
  /** 監査 actor（users.id）。createdBy/updatedBy に入れる。 */
  actorUserId: string;
};

/**
 * 指定クラス・日付の来校者一覧を **全置換** する（その日の行を消して新リストを入れる。編集 UI が日単位で
 * 一覧を保存する想定）。RLS context tx 内で呼ぶこと。
 *
 * **テナント分離（ルール2）**: 手書き WHERE school_id は書かない。`tenant_isolation` が DELETE/INSERT とも
 * 自校に限定し、INSERT は WITH CHECK で `school_id=自校` を強制する。**cross-tenant 防止**: 先に対象 class が
 * 自校で可視か SELECT で確認し、不可視なら `null` を返す（呼出側 Action が not_found へ写像）。可視＝自校
 * なので続く DELETE/INSERT も自校行のみに作用する。`schoolId` は actor の自校（= current_school_id）を渡す。
 *
 * @returns 置換後の件数。対象 class が不可視（他校 / 不在）なら `null`。
 */
export async function replaceClassVisitors(
  tx: TenantTx,
  params: ReplaceClassVisitorsParams,
): Promise<number | null> {
  const { schoolId, classId, date, items, actorUserId } = params;
  const [cls] = await tx
    .select({ id: classes.id })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  if (!cls) {
    return null;
  }
  await tx
    .delete(classVisitors)
    .where(and(eq(classVisitors.classId, classId), eq(classVisitors.visitDate, date)));
  if (items.length > 0) {
    await tx.insert(classVisitors).values(
      // 配列の並び順 = 編集 UI の行順。行位置をそのまま sort_order に採番し、表示順を永続化する
      // （getVisitorsForClass が sort_order 昇順で読む）。
      items.map((it, idx) => ({
        schoolId,
        classId,
        visitDate: date,
        visitorName: it.visitorName,
        affiliation: it.affiliation,
        scheduledTime: it.scheduledTime,
        purpose: it.purpose,
        host: it.host,
        note: it.note,
        sortOrder: idx,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      })),
    );
  }
  return items.length;
}
