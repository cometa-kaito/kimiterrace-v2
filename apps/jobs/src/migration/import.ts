import {
  type KimiterraceDb,
  ads,
  auditLog,
  classes,
  createDbClient,
  dailyData,
  departments,
  grades,
  schoolConfigs,
  schools,
} from "@kimiterrace/db";
import { uuidv5 } from "./ids.js";
import { type MigrationRows, transformExport } from "./transform.js";
import type { V1Export } from "./types.js";

/**
 * V1→V2 冪等インポート (#48-D)。transform で得た行束を FK 依存順に挿入する。
 *
 * ## 接続ロール (CLAUDE.md ルール2)
 * **migrator (BYPASSRLS) ロールで接続する**。本ジョブは全テナント横断で書き込むため、
 * 通常の `kimiterrace_app` (非 BYPASSRLS) では RLS により他テナント行の挿入が拒否される。
 * データ移行は「migration 用途」に該当し BYPASSRLS の使用が許される唯一のケース (ルール2 例外)。
 * `DATABASE_URL` には migrator ロールの接続文字列を渡すこと (app ロールでは流さない)。
 *
 * ## 冪等性 (`onConflictDoNothing`)
 * id は決定論的 UUID (ids.ts) なので、再実行は既存行を**スキップ**する (挿入のみ・上書きなし)。
 * これは意図的: 移行後 V2 が真実の単一ソースになった後に再実行しても、V2 側で編集された値を
 * 移行スクリプトが**踏み潰さない**。クラッシュ後の再開 (途中まで挿入済) も安全に resume できる。
 * (V1 の変更を V2 へ再同期したい場合は truncate→再投入 or 明示 upsert を別途用意する。)
 *
 * ## 監査 (ルール1 / NFR04)
 * 移行行の `created_by` / `updated_by` は null (システム移行)。さらに学校ごとに `audit_log` へ
 * 移行マーカーを 1 行追記する (operation=insert / table=schools / diff に移行メタ)。prev_hash /
 * row_hash は audit_log の BEFORE INSERT トリガが計算する (migration 0003、placeholder を渡す)。
 */

export type ImportSummary = {
  schools: number;
  departments: number;
  grades: number;
  classes: number;
  schoolConfigs: number;
  dailyData: number;
  ads: number;
  auditMarkers: number;
};

/** 変換済み行束を 1 トランザクションで冪等挿入する。挿入(試行)件数を返す。 */
export async function importRows(db: KimiterraceDb, rows: MigrationRows): Promise<ImportSummary> {
  return await db.transaction(async (tx) => {
    // FK 依存順 (親→子)。各 onConflictDoNothing で再実行時はスキップ。
    if (rows.schools.length) await tx.insert(schools).values(rows.schools).onConflictDoNothing();
    if (rows.departments.length)
      await tx.insert(departments).values(rows.departments).onConflictDoNothing();
    if (rows.grades.length) await tx.insert(grades).values(rows.grades).onConflictDoNothing();
    if (rows.classes.length) await tx.insert(classes).values(rows.classes).onConflictDoNothing();
    if (rows.schoolConfigs.length)
      await tx.insert(schoolConfigs).values(rows.schoolConfigs).onConflictDoNothing();
    if (rows.dailyData.length)
      await tx.insert(dailyData).values(rows.dailyData).onConflictDoNothing();
    if (rows.ads.length) await tx.insert(ads).values(rows.ads).onConflictDoNothing();

    // 学校ごとの移行マーカー (決定論的 id で再実行時は重複しない)。
    const markers = rows.schools.map((s) => ({
      id: uuidv5(`audit-migration:${s.id}`),
      actorUserId: null,
      schoolId: s.id as string,
      tableName: "schools",
      recordId: s.id as string,
      operation: "insert" as const,
      diff: { migration: "firestore-to-pg", source: "v1-firestore" },
      // BEFORE INSERT トリガ (migration 0003) が prev_hash / row_hash を計算 (placeholder)。
      rowHash: "",
      createdBy: null,
      updatedBy: null,
    }));
    if (markers.length) await tx.insert(auditLog).values(markers).onConflictDoNothing();

    return {
      schools: rows.schools.length,
      departments: rows.departments.length,
      grades: rows.grades.length,
      classes: rows.classes.length,
      schoolConfigs: rows.schoolConfigs.length,
      dailyData: rows.dailyData.length,
      ads: rows.ads.length,
      auditMarkers: markers.length,
    };
  });
}

/**
 * エクスポート JSON → 変換 → インポートのワンショット。CLI / Cloud Run Job から呼ぶ。
 * 接続は呼出側が `DATABASE_URL` (migrator ロール) で用意し、終了後に閉じる。
 */
export async function runMigration(
  databaseUrl: string,
  exportData: V1Export,
): Promise<ImportSummary> {
  const { sql, db } = createDbClient(databaseUrl);
  try {
    return await importRows(db, transformExport(exportData));
  } finally {
    await sql.end({ timeout: 5 });
  }
}
