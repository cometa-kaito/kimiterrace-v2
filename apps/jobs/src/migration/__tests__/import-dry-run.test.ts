import { createDbClient } from "@kimiterrace/db";
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v2Id } from "../ids.js";
import { type ImportSummary, importRows } from "../import.js";
import { transformExport } from "../transform.js";
import { getConnectionUrl } from "./_setup/test-db.js";
import { type EntityCounts, countV1, syntheticV1Export } from "./fixtures/synthetic-v1-export.js";

/**
 * トラック⑤ MIG: 合成移行 dry-run の**実 PG 突合** (Part of #243)。
 *
 * `transform.test.ts` は変換ロジックの純粋単体。本テストは「合成 V1 エクスポート →
 * importRows → 実 PG (RLS / 監査トリガ / scope CHECK 込みの実構成) に着地」を回し、
 * 件数突合 (MIG-001) / FK 整合 (MIG-002) / 型変換・文字化け (MIG-003) / 冪等性 (MIG-004) /
 * 移行後 RLS (MIG-006) を機械判定する。スキーマ初期化は [_setup/global-setup.ts](./_setup/global-setup.ts)。
 *
 * ## 範囲 (test-strategy §2.1 / §7)
 * 合成データのローカル実 PG dry-run。**本番 Firestore からの実移行・実データ突合は導入フェーズ
 * (人間)**。本スライスは「移行スクリプトが整合・冪等・テナント分離を満たす」前段検証に限る。
 *
 * ## 接続ロール (ルール2)
 * import は migrator (BYPASSRLS) 想定。CI/dev の DATABASE_URL は superuser = RLS バイパス相当で、
 * 全テナント横断書込ができる。移行後 RLS 検証 (MIG-006) は同接続でも tx 内 `SET LOCAL ROLE
 * kimiterrace_app` でアプリ視点に降格して実際に RLS を効かせる (降格しないと superuser で vacuous)。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/** noUncheckedIndexedAccess 下で配列先頭/Record 値を非 undefined に確定する小ヘルパ。 */
function def<T>(v: T | undefined, msg = "値が undefined"): T {
  if (v === undefined) throw new Error(msg);
  return v;
}

/** 再実行の決定性のため毎回クリーンにする対象 (FK 依存の逆順で CASCADE truncate)。 */
const TRUNCATE_SQL =
  "TRUNCATE audit_log, ads, daily_data, school_configs, classes, grades, departments, schools RESTART IDENTITY CASCADE;";

describeOrSkip("MIG: 合成移行 dry-run (実 PG)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql, db } = createDbClient(url!);
  const expected = countV1(syntheticV1Export);
  const s1 = v2Id.school("S1");
  const s2 = v2Id.school("S2");
  let summary: ImportSummary;

  beforeAll(async () => {
    // クリーンスレート。audit_log は append-only / no-truncate トリガを一時無効化して truncate
    // (packages/db seedBaseFixture と同規律)。entity テーブルの監査トリガは行イベント用で TRUNCATE
    // では発火しないため無効化不要。
    await sql.unsafe("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate;");
    await sql.unsafe("ALTER TABLE audit_log DISABLE TRIGGER audit_log_hash_chain;");
    try {
      await sql.unsafe(TRUNCATE_SQL);
    } finally {
      await sql.unsafe("ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_truncate;");
      await sql.unsafe("ALTER TABLE audit_log ENABLE TRIGGER audit_log_hash_chain;");
    }
    summary = await importRows(db, transformExport(syntheticV1Export));
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // ---- MIG-001: 件数突合 (欠損ゼロ / 余剰ゼロ) ----
  it("MIG-001: V1 論理件数 == ImportSummary == V2 実行数", async () => {
    const dbCounts = await tableCounts();
    // (a) V1 構造を transform 非依存で数えた期待値 == DB 実件数 (欠損/余剰ゼロ)
    expect(dbCounts).toEqual(expected.total);
    // (b) ImportSummary の試行件数も V1 論理件数と一致
    const summaryCounts: EntityCounts = {
      schools: summary.schools,
      departments: summary.departments,
      grades: summary.grades,
      classes: summary.classes,
      schoolConfigs: summary.schoolConfigs,
      dailyData: summary.dailyData,
      ads: summary.ads,
    };
    expect(summaryCounts).toEqual(expected.total);
    // 学校ごとの移行マーカーが学校数ぶん (MIG-007 の詳細監査は後続スライス)
    expect(summary.auditMarkers).toBe(expected.total.schools);
  });

  // ---- MIG-002: 参照整合 (FK) ----
  it("MIG-002: dangling FK ゼロ + 階層リンクが決定論 id で結線", async () => {
    // 孤児 (子の親 FK が実在しない) ゼロ
    const [orphans] = await sql<{ n: number }[]>`
      SELECT (
          (SELECT count(*) FROM grades g WHERE g.school_id NOT IN (SELECT id FROM schools))
        + (SELECT count(*) FROM grades g
             WHERE g.department_id IS NOT NULL AND g.department_id NOT IN (SELECT id FROM departments))
        + (SELECT count(*) FROM classes c WHERE c.school_id NOT IN (SELECT id FROM schools))
        + (SELECT count(*) FROM classes c WHERE c.grade_id NOT IN (SELECT id FROM grades))
        + (SELECT count(*) FROM ads a WHERE a.school_id NOT IN (SELECT id FROM schools))
        + (SELECT count(*) FROM ads a WHERE a.grade_id IS NOT NULL AND a.grade_id NOT IN (SELECT id FROM grades))
        + (SELECT count(*) FROM ads a WHERE a.department_id IS NOT NULL AND a.department_id NOT IN (SELECT id FROM departments))
        + (SELECT count(*) FROM ads a WHERE a.class_id IS NOT NULL AND a.class_id NOT IN (SELECT id FROM classes))
        + (SELECT count(*) FROM daily_data d WHERE d.school_id NOT IN (SELECT id FROM schools))
        + (SELECT count(*) FROM daily_data d WHERE d.grade_id IS NOT NULL AND d.grade_id NOT IN (SELECT id FROM grades))
        + (SELECT count(*) FROM daily_data d WHERE d.class_id IS NOT NULL AND d.class_id NOT IN (SELECT id FROM classes))
        + (SELECT count(*) FROM school_configs sc WHERE sc.school_id NOT IN (SELECT id FROM schools))
      )::int AS n
    `;
    expect(def(orphans).n).toBe(0);

    // 階層リンクが transform の決定論規約どおりに実 DB へ着地している
    const [g1] = await sql<{ department_id: string | null }[]>`
      SELECT department_id FROM grades WHERE id = ${v2Id.grade("S1", "G1")}
    `;
    expect(def(g1).department_id).toBe(v2Id.department("S1", "D1"));
    const [c1] = await sql<{ grade_id: string; school_id: string }[]>`
      SELECT grade_id, school_id FROM classes WHERE id = ${v2Id.class("S1", "G1", "C1")}
    `;
    expect(def(c1).grade_id).toBe(v2Id.grade("S1", "G1"));
    expect(def(c1).school_id).toBe(s1);
  });

  // ---- MIG-003: 型変換・文字化け ----
  it("MIG-003: マルチバイト/絵文字/数値既定/入れ子 JSONB が保持される", async () => {
    const [s1row] = await sql<{ name: string; prefecture: string; code: string | null }[]>`
      SELECT name, prefecture, code FROM schools WHERE id = ${s1}
    `;
    expect(def(s1row).name).toBe("岐南工業高校🏫"); // 絵文字 mojibake なし
    expect(def(s1row).prefecture).toBe("不明"); // 省略 → 既定
    expect(def(s1row).code).toBe("GIFU-01");
    const [s2row] = await sql<{ prefecture: string; code: string | null }[]>`
      SELECT prefecture, code FROM schools WHERE id = ${s2}
    `;
    expect(def(s2row).prefecture).toBe("岐阜県");
    expect(def(s2row).code).toBeNull(); // 省略 → null

    // 数値既定 vs 明示: school ad は既定 (5 / 1 / 0)、grade ad は明示 (12 / 1.3 / 7)
    const [schoolAd] = await sql<
      { duration_sec: number; caption_font_scale: number; display_order: number }[]
    >`
      SELECT duration_sec, caption_font_scale, display_order FROM ads
      WHERE school_id = ${s1} AND scope = 'school'
    `;
    expect(def(schoolAd).duration_sec).toBe(5);
    expect(def(schoolAd).caption_font_scale).toBeCloseTo(1, 5);
    expect(def(schoolAd).display_order).toBe(0);
    const [gradeAd] = await sql<
      { duration_sec: number; caption_font_scale: number; display_order: number; caption: string }[]
    >`
      SELECT duration_sec, caption_font_scale, display_order, caption FROM ads
      WHERE grade_id = ${v2Id.grade("S1", "G1")} AND scope = 'grade'
    `;
    expect(def(gradeAd).duration_sec).toBe(12);
    expect(def(gradeAd).caption_font_scale).toBeCloseTo(1.3, 5);
    expect(def(gradeAd).display_order).toBe(7);
    expect(def(gradeAd).caption).toBe("🎓 進路ガイダンス〜未来へ");

    // class ads は displayOrder 省略 → index 0,1
    const classAds = await sql<{ display_order: number }[]>`
      SELECT display_order FROM ads WHERE class_id = ${v2Id.class("S1", "G1", "C1")} ORDER BY display_order
    `;
    expect(classAds.map((r) => r.display_order)).toEqual([0, 1]);

    // 入れ子 JSONB の構造保持
    const [schoolDaily] = await sql<{ schedules: unknown; notices: unknown }[]>`
      SELECT schedules, notices FROM daily_data
      WHERE school_id = ${s1} AND scope = 'school' AND date = '2026-05-01'
    `;
    expect(def(schoolDaily).schedules).toEqual([
      { period: 1, subject: "数学" },
      { period: 2, subject: "国語" },
    ]);
    expect(def(schoolDaily).notices).toEqual(["🎌 全校集会 13:00"]);
    const [classDaily] = await sql<{ notices: unknown; schedules: unknown }[]>`
      SELECT notices, schedules FROM daily_data WHERE class_id = ${v2Id.class("S1", "G1", "C1")}
    `;
    expect(def(classDaily).notices).toEqual(["台風接近のため繰り上げ下校⚠️"]);
    expect(def(classDaily).schedules).toEqual([]); // 省略配列 → []
    const [cfg] = await sql<{ value: unknown }[]>`
      SELECT value FROM school_configs
      WHERE school_id = ${s1} AND scope = 'school' AND kind = 'display_settings'
    `;
    expect(def(cfg).value).toEqual({ theme: "dark", palette: { bg: "#000", fg: "#fff" } });
  });

  // ---- MIG-004: 冪等性 (再投入で差分ゼロ) ----
  it("MIG-004: 再投入で行数・id 集合・監査マーカーが不変 (差分ゼロ)", async () => {
    const before = await snapshot();
    const summary2 = await importRows(db, transformExport(syntheticV1Export));
    const after = await snapshot();

    expect(after.counts).toEqual(before.counts); // 全テーブル行数不変
    expect(after.adIds).toEqual(before.adIds); // 決定論 id 集合不変 (重複生成なし)
    expect(after.classIds).toEqual(before.classIds);
    expect(after.auditLogRows).toBe(before.auditLogRows); // 監査マーカー重複なし
    // ImportSummary は「試行件数」なので onConflictDoNothing で実挿入ゼロでも同数
    expect(summary2).toEqual(summary);
  });

  // ---- MIG-006: 移行後 RLS (テナント分離) ----
  it("MIG-006: 移行データに RLS テナント分離が効く (自校のみ / 別校混入ゼロ)", async () => {
    const cS1 = def(expected.bySchool.S1);
    const cS2 = def(expected.bySchool.S2);
    // 非ゼロを前提化 (vacuous 回避): fixture は両校に ads/grades を持つ
    expect(cS1.ads).toBeGreaterThan(0);
    expect(cS2.ads).toBeGreaterThan(0);

    // S1 context: S1 の ads のみ、S2 は混入ゼロ
    const s1Ads = await asApp(
      { schoolId: s1, role: "school_admin" },
      (tx) => tx<{ school_id: string }[]>`SELECT school_id FROM ads`,
    );
    expect(s1Ads.length).toBe(cS1.ads);
    expect(s1Ads.every((r) => r.school_id === s1)).toBe(true);
    expect(s1Ads.some((r) => r.school_id === s2)).toBe(false);

    // S2 context: S2 の ads のみ
    const s2Ads = await asApp(
      { schoolId: s2, role: "school_admin" },
      (tx) => tx<{ school_id: string }[]>`SELECT school_id FROM ads`,
    );
    expect(s2Ads.length).toBe(cS2.ads);
    expect(s2Ads.every((r) => r.school_id === s2)).toBe(true);

    // grades / daily_data も同様にテナント分離
    const s1Grades = await asApp(
      { schoolId: s1, role: "school_admin" },
      (tx) => tx<{ id: string }[]>`SELECT id FROM grades`,
    );
    expect(s1Grades.length).toBe(cS1.grades);
    const s1Daily = await asApp(
      { schoolId: s1, role: "school_admin" },
      (tx) => tx<{ id: string }[]>`SELECT id FROM daily_data`,
    );
    expect(s1Daily.length).toBe(cS1.dailyData);

    // context 未設定 → deny by default (0 件)
    const denied = await asApp({}, (tx) => tx<{ id: string }[]>`SELECT id FROM ads`);
    expect(denied.length).toBe(0);

    // system_admin → cross-tenant 全件 (越境ではなく権限保持者の横断)
    const allAds = await asApp(
      { role: "system_admin" },
      (tx) => tx<{ id: string }[]>`SELECT id FROM ads`,
    );
    expect(allAds.length).toBe(expected.total.ads);
  });

  // ---- MIG-007: 移行マーカー監査 ----
  it("MIG-007: 学校ごとの移行マーカーが system 移行として監査記録される", async () => {
    const markers = await sql<
      {
        record_id: string | null;
        operation: string;
        diff: Record<string, unknown>;
        actor_user_id: string | null;
        created_by: string | null;
        updated_by: string | null;
        row_hash: string;
      }[]
    >`
      SELECT record_id, operation, diff, actor_user_id, created_by, updated_by, row_hash
      FROM audit_log WHERE table_name = 'schools' ORDER BY record_id
    `;
    // 学校数ぶんのマーカー (余剰なし)
    expect(markers.length).toBe(expected.total.schools);
    for (const m of markers) {
      expect(m.operation).toBe("insert");
      expect(m.actor_user_id).toBeNull(); // システム移行 = actor なし
      expect(m.created_by).toBeNull(); // ルール1: システム作成は created_by/updated_by null
      expect(m.updated_by).toBeNull();
      expect(m.diff).toMatchObject({ migration: "firestore-to-pg", source: "v1-firestore" });
      // トリガが client placeholder "" を上書きして 64 hex を計算済 (MIG-007 の核)
      expect(m.row_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // record_id が両校をカバー (学校ごと 1 マーカー)
    expect(markers.map((m) => m.record_id).sort()).toEqual([s1, s2].sort());
    // 2 マーカーの row_hash は別 (payload に record_id を含むため非自明に計算されている)
    expect(new Set(markers.map((m) => m.row_hash)).size).toBe(markers.length);
  });

  // ---- MIG-008: scope 網羅 + 移行スコープ完全性 ----
  it("MIG-008(a): 全 scope の子データが欠損しない (hasClasses=false / 空配列 含む)", async () => {
    // hasClasses=false 学年 (G2) 自体が移行され、その daily_data も落ちない
    const [g2] = await sql<{ has_classes: boolean }[]>`
      SELECT has_classes FROM grades WHERE id = ${v2Id.grade("S1", "G2")}
    `;
    expect(def(g2).has_classes).toBe(false);
    const g2Daily = await sql<{ assignments: unknown }[]>`
      SELECT assignments FROM daily_data
      WHERE grade_id = ${v2Id.grade("S1", "G2")} AND scope = 'grade'
    `;
    expect(g2Daily.length).toBe(1);
    expect(def(g2Daily[0]).assignments).toEqual(["特別研究レポート提出"]);
    // 空配列 ads=[] の学年 → ads 0 件 (silent drop でなく「子が無い」が正しく反映)
    const [g2Ads] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ads WHERE grade_id = ${v2Id.grade("S1", "G2")}
    `;
    expect(def(g2Ads).n).toBe(0);
    // 全 4 scope の ads がそろう (どの階層の広告も脱落していない)
    const adScopes = (
      await sql<{ scope: string }[]>`SELECT DISTINCT scope FROM ads ORDER BY scope`
    ).map((r) => r.scope);
    expect(adScopes).toEqual(["class", "department", "grade", "school"]);
    // daily_data は school/grade/class scope (department は V1 に daily 無し = 設計どおり)
    const dailyScopes = (
      await sql<{ scope: string }[]>`SELECT DISTINCT scope FROM daily_data ORDER BY scope`
    ).map((r) => r.scope);
    expect(dailyScopes).toEqual(["class", "grade", "school"]);
  });

  it("MIG-008(b): 移行対象テーブル集合が v1-v2-mapping.md と整合 (対象外漏れ検出)", () => {
    // transform が書き込む V2 テーブル = 移行対象。docs/architecture/v1-v2-mapping.md の
    // 「Firestore コレクション → PostgreSQL テーブル対応」のうち移行対象 7 テーブルと一致する。
    // feedback は V1 root コレクションだが V2 では guide 画面の新規機能であり移行ジョブ対象外
    // (track05 §8「移行スコープの完全性」の設計判断)。ここを pin することで対象テーブルの増減を
    // mapping/設計の再突合なしに通さない (行レベル突合では拾えない「対象外コレクション漏れ」の二重化)。
    const migratedTables = Object.keys(transformExport(syntheticV1Export)).sort();
    expect(migratedTables).toEqual([
      "ads",
      "classes",
      "dailyData",
      "departments",
      "grades",
      "schoolConfigs",
      "schools",
    ]);
  });

  // ---- helpers ----

  async function tableCounts(): Promise<EntityCounts> {
    const [row] = await sql<EntityCounts[]>`
      SELECT
        (SELECT count(*) FROM schools)::int        AS schools,
        (SELECT count(*) FROM departments)::int    AS departments,
        (SELECT count(*) FROM grades)::int         AS grades,
        (SELECT count(*) FROM classes)::int        AS classes,
        (SELECT count(*) FROM school_configs)::int AS "schoolConfigs",
        (SELECT count(*) FROM daily_data)::int     AS "dailyData",
        (SELECT count(*) FROM ads)::int            AS ads
    `;
    return def(row);
  }

  async function snapshot() {
    const counts = await tableCounts();
    const adIds = (await sql<{ id: string }[]>`SELECT id FROM ads ORDER BY id`).map((r) => r.id);
    const classIds = (await sql<{ id: string }[]>`SELECT id FROM classes ORDER BY id`).map(
      (r) => r.id,
    );
    const [aud] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log`;
    return { counts, adIds, classIds, auditLogRows: def(aud).n };
  }

  /**
   * tx 内で kimiterrace_app に降格 + RLS GUC を張って行を取得する (移行後 RLS 検証用)。
   * 戻り値を行配列に固定することで postgres-js `begin` の `UnwrapPromiseArray` が素直に解決する。
   */
  async function asApp<Row extends Record<string, unknown>>(
    ctx: { schoolId?: string; role?: string },
    query: (tx: TransactionSql) => Promise<Row[]>,
  ): Promise<Row[]> {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      if (ctx.schoolId) await tx`SELECT set_config('app.current_school_id', ${ctx.schoolId}, true)`;
      if (ctx.role) await tx`SELECT set_config('app.current_user_role', ${ctx.role}, true)`;
      return query(tx);
    });
    // Row は Record (= Promise でない) に制約済なので begin の UnwrapPromiseArray は Row[] と等価。
    return rows as Row[];
  }
});
