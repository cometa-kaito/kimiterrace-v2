import { type InferSelectModel, asc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schools } from "../schema/schools.js";

/**
 * #48-L (#123): システム管理者向けの学校 (テナント) マスタ読み取りクエリ層。
 *
 * テナント分離は **呼び出し接続の RLS コンテキスト** (`app.current_user_role` / `app.current_school_id`、
 * ADR-019) が DB レベルで強制する。schools には 2 系統の policy があり (0002_rls_policies.sql):
 * - `system_admin_full_access` (role=system_admin) → **全校可視**
 * - `tenant_self_read` (id = current_school_id) → 自校 1 件のみ
 * したがって本モジュールは `WHERE` で role/school を**書かない** — RLS に委ねる (CLAUDE.md ルール2)。
 * 呼び出し側は RLS をバイパスしない接続ロール (kimiterrace_app) を使うこと。
 *
 * 型は schema の `schools` から `InferSelectModel` で派生する (ルール3)。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type SchoolRow = InferSelectModel<typeof schools>;

/** 学校一覧 1 行 (一覧用の軽量射影、notes は含めない)。 */
export type SchoolSummary = Pick<SchoolRow, "id" | "name" | "prefecture" | "code" | "createdAt">;

/**
 * 学校一覧を取得する。可視範囲は RLS が決める (system_admin=全校 / テナント=自校のみ)。
 * 都道府県 → 校名 → id の順で決定的に並べる (同名校でも順序が安定)。
 */
export async function listSchools(db: Selectable): Promise<SchoolSummary[]> {
  return db
    .select({
      id: schools.id,
      name: schools.name,
      prefecture: schools.prefecture,
      code: schools.code,
      createdAt: schools.createdAt,
    })
    .from(schools)
    .orderBy(asc(schools.prefecture), asc(schools.name), asc(schools.id));
}
