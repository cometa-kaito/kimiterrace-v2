import postgres from "postgres";
import {
  GINAN_ACADEMIC_YEAR,
  GINAN_DEPARTMENT,
  GINAN_GRADES,
  GINAN_SCHOOL,
  validateGinanSchoolSeed,
} from "./seed-ginan-school.js";

/**
 * 岐南工業テナント（学校 + 電子工学科 + 1〜3 年 + 各 1 クラス）を staging に用意する **シード実行エントリ**。
 * データは {@link ./seed-ginan-school.ts}。後続の TV/センサー/広告シードはこのテナントを前提に動く。
 *
 * ## 実行方法
 * - staging: migrate と同一イメージに同梱し Cloud Run Job の command 上書きで起動
 *   （`command=["node","dist/seed-ginan-school-cli.js"]`、seed-ginan-sensors-cli と同パターン）。
 *
 * ## RLS（ルール2） / 冪等性
 * migrator DSN（FORCE RLS・非 BYPASSRLS）で接続し、tx 内で `app.current_user_role='system_admin'` を張って
 * `system_admin_full_access` policy 経由で書く（BYPASSRLS 不使用）。各 upsert は ON CONFLICT / 事前 SELECT で
 * **再実行安全**（既存は温存し UI 手編集を壊さない）。クラスは **学年ごとに既存クラスが 0 件のときだけ** 作成し、
 * 事前に存在するテナント（手入力済み等）に重複「A組」を足さない（重複は TV のクラス一意解決を曖昧化するため）。
 *
 * ## 監査（ルール1） / 秘密（ルール5） / PII（ルール4）
 * created_by/updated_by は省略 = NULL（システム作成）。DATABASE_URL はログ・エラーに出さない。
 * 学校名・学科名・学年名・クラス名のみ（PII 非格納）。
 *
 * ## 実装方針: 生 SQL（schema barrel を import しない）
 * barrel は pgvector 経由で @kimiterrace/ai に推移依存し migrate イメージで ERR_MODULE_NOT_FOUND になるため、
 * `postgres` の生 SQL で書く（migrate-cli / 他 seed-cli と同じ）。
 */

const SCHOOL_NAME = process.env.SEED_GINAN_SCHOOL_NAME ?? GINAN_SCHOOL.name;
const DEPARTMENT_NAME = process.env.SEED_GINAN_DEPARTMENT_NAME ?? GINAN_DEPARTMENT;
const ACADEMIC_YEAR = Number(process.env.SEED_GINAN_ACADEMIC_YEAR ?? GINAN_ACADEMIC_YEAR);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  validateGinanSchoolSeed(GINAN_GRADES);

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let exitCode = 0;
  const summary: Record<string, unknown> = { event: "seed.ginan.school.done", school: SCHOOL_NAME };

  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      // 学校（テナント）: 名前で解決、無ければ作成（schools.name は UNIQUE でないため SELECT→INSERT）。
      const existing = await tx<{ id: string }[]>`
        SELECT id FROM schools WHERE name = ${SCHOOL_NAME} ORDER BY created_at ASC LIMIT 1`;
      let schoolId = existing[0]?.id;
      if (!schoolId) {
        const ins = await tx<{ id: string }[]>`
          INSERT INTO schools (name, prefecture, hierarchy_mode)
          VALUES (${SCHOOL_NAME}, ${GINAN_SCHOOL.prefecture}, ${GINAN_SCHOOL.hierarchyMode})
          RETURNING id`;
        schoolId = ins[0]?.id;
        summary.schoolAction = "created";
      } else {
        summary.schoolAction = "exists";
      }
      if (!schoolId) {
        throw new Error("failed to resolve/create school id");
      }
      summary.schoolId = schoolId;

      // 学科（電子工学科）: (school_id, name) UNIQUE で冪等 upsert。
      await tx`
        INSERT INTO departments (school_id, name, display_order)
        VALUES (${schoolId}, ${DEPARTMENT_NAME}, 0)
        ON CONFLICT (school_id, name) DO NOTHING`;
      const deptRows = await tx<{ id: string }[]>`
        SELECT id FROM departments WHERE school_id = ${schoolId} AND name = ${DEPARTMENT_NAME} LIMIT 1`;
      const departmentId = deptRows[0]?.id;
      if (!departmentId) {
        throw new Error("failed to resolve department id");
      }

      const perGrade: Array<{ grade: number; gradeAction: string; classAction: string }> = [];
      for (const g of GINAN_GRADES) {
        // 学年: (school_id, name) UNIQUE で冪等。学科を親に、has_classes=true、表示順=学年番号。
        await tx`
          INSERT INTO grades (school_id, department_id, name, display_order, has_classes)
          VALUES (${schoolId}, ${departmentId}, ${g.gradeName}, ${g.grade}, true)
          ON CONFLICT (school_id, name) DO NOTHING`;
        const gradeRows = await tx<{ id: string }[]>`
          SELECT id FROM grades WHERE school_id = ${schoolId} AND name = ${g.gradeName} LIMIT 1`;
        const gradeId = gradeRows[0]?.id;
        if (!gradeId) {
          throw new Error(`failed to resolve grade id for ${g.gradeName}`);
        }
        const gradeAction = gradeRows.length ? "ensured" : "created";

        // クラス: 既存テナント（staging で岐南が事前に存在し各学年にクラスを持つ場合）と衝突して
        // 重複「A組」を作らないため、(school_id, grade_id) に **クラスが 1 件でもあれば INSERT しない**。
        // 重複クラスは TV/センサーの「電子工学科 × 学年」一意解決を曖昧化し class_id を NULL にしてしまう
        // （staging 実踏: 重複 A組 → class_id NULL）。className 完全一致でなく学年に既存クラスが在るかで判定する。
        const existingClasses = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM classes
          WHERE school_id = ${schoolId} AND grade_id = ${gradeId}`;
        const existingCount = Number(existingClasses[0]?.count ?? "0");
        let classAction: string;
        if (existingCount === 0) {
          await tx`
            INSERT INTO classes (school_id, grade_id, academic_year, name, grade)
            VALUES (${schoolId}, ${gradeId}, ${ACADEMIC_YEAR}, ${g.className}, ${g.grade})`;
          classAction = "created";
        } else {
          classAction = "exists";
        }
        perGrade.push({ grade: g.grade, gradeAction, classAction });
      }
      summary.grades = perGrade;
      summary.department = DEPARTMENT_NAME;
      summary.academicYear = ACADEMIC_YEAR;
    });

    console.log(JSON.stringify(summary));
  } catch (err) {
    console.error(err);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
