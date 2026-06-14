import { type InferSelectModel, and, asc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { classes } from "../schema/classes.js";
import { departments } from "../schema/departments.js";
import { grades } from "../schema/grades.js";
import { schools } from "../schema/schools.js";
import { tvDevices } from "../schema/tv-devices.js";

/**
 * 運営整理 Phase6 / Partner API K4（`docs/api/partner-api-contract.md` §3.5）:
 * portal「学校営業台帳」向けの **学校階層 pull**（read-only）。
 *
 * portal（商流 SoR）は名寄せ済（`schools.v2_school_id`）の学校について、配信 SoR である v2 から
 * 「学校 → 設置場所 → モニタ」の階層を server-to-server で取得し、台帳に**自動表示・編集ロック**する
 * （SoR は v2・portal は参照のみ）。本クエリは v2 側の供給ロジック。
 *
 * ## 階層モデル（統合マスター §0b: 学校 > 設置場所 > モニタ）
 * v2 に独立した「設置場所」テーブルは無い。物理最小単位は **モニタ = `tv_devices` 1 行**で、その
 * `label`（例: "電子工学科 1年"・自由文字列）が設置場所を表す。各モニタは教室コンテキスト
 * （grade / department / class）への nullable な参照を持つ。本クエリは school 配下の全モニタを
 * コンテキスト名つきで列挙し、グルーピング（設置場所単位の中間層）は portal の表示側に委ねる。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `WHERE school_id = id` は**対象特定**であってテナント境界ではない。可視範囲は呼び出し接続の RLS
 * コンテキストが決める（partner ルートは `system_admin` context = cross-tenant 可）。手書きの role/school
 * 条件は書かない（`getSchoolDetail` と同方針）。接続ロールは BYPASSRLS 不使用の kimiterrace_app。
 *
 * ## PII 非格納（ルール4）
 * 返すのは学校マスタ（公開情報）とモニタの設置場所ラベル・稼働メタのみ。`tv_devices.label` は PII を
 * 含めない規約（schema/tv-devices.ts）。`device_id`（ポーリング解決キー・推測不能）や MAC・FCM トークン等の
 * 秘匿値は**返さない**（partner 契約 §0: PII/秘匿無し）。
 */

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type SchoolRow = InferSelectModel<typeof schools>;

/** 学校階層 1 モニタ（設置場所コンテキスト + 稼働メタ。秘匿値・PII は含めない）。 */
export type SchoolHierarchyMonitor = {
  /** tv_devices.id（内部 UUID）。ポーリング解決キー device_id とは別物で、これは露出してよい識別子。 */
  id: string;
  /** 設置場所ラベル（例: "電子工学科 1年"）。PII を含まない自由文字列（null 可）。 */
  label: string | null;
  /** 教室コンテキスト名（解決済。学科モード校でのみ department が非 null）。 */
  gradeName: string | null;
  departmentName: string | null;
  className: string | null;
  /** 最終ポーリング時刻（死活信号・F16）。null = 未だ一度も接続していない。 */
  lastSeenAt: Date | null;
  /** アラート状態（重複通知抑止フラグ。ok / down 等）。 */
  alertState: InferSelectModel<typeof tvDevices>["alertState"];
  /** 死活監視の有効/無効（メンテ中の誤報抑制）。 */
  monitoringEnabled: boolean;
};

/** 学校階層 pull の結果（school マスタ射影 + 配下モニタ）。 */
export type SchoolHierarchy = {
  school: Pick<SchoolRow, "id" | "name" | "prefecture" | "code" | "hierarchyMode">;
  monitors: SchoolHierarchyMonitor[];
};

/**
 * 学校 1 件の「学校 → 設置場所 → モニタ」階層を取得する。RLS で不可視（他校 / 不存在）なら `null`。
 *
 * 並びは設置場所ラベル → モニタ id で決定的（同ラベル複数台でも順序が安定）。ソフトデリート済
 * （`deleted_at` 非 null）のモニタは台帳に出さない。
 */
export async function getSchoolHierarchy(
  db: Selectable,
  id: string,
): Promise<SchoolHierarchy | null> {
  const [school] = await db
    .select({
      id: schools.id,
      name: schools.name,
      prefecture: schools.prefecture,
      code: schools.code,
      hierarchyMode: schools.hierarchyMode,
    })
    .from(schools)
    .where(eq(schools.id, id))
    .limit(1);
  if (!school) {
    return null;
  }

  const monitors = await db
    .select({
      id: tvDevices.id,
      label: tvDevices.label,
      gradeName: grades.name,
      departmentName: departments.name,
      className: classes.name,
      lastSeenAt: tvDevices.lastSeenAt,
      alertState: tvDevices.alertState,
      monitoringEnabled: tvDevices.monitoringEnabled,
    })
    .from(tvDevices)
    .leftJoin(grades, eq(grades.id, tvDevices.gradeId))
    .leftJoin(departments, eq(departments.id, tvDevices.departmentId))
    .leftJoin(classes, eq(classes.id, tvDevices.classId))
    // 設置場所ラベル → モニタ id の決定的順序。soft-delete 済は台帳外。
    .where(and(eq(tvDevices.schoolId, id), isNull(tvDevices.deletedAt)))
    .orderBy(asc(tvDevices.label), asc(tvDevices.id));

  return { school, monitors };
}
