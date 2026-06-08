import { GINAN_ECE_DEPARTMENT_NAME, GINAN_SCHOOL_NAME } from "./seed-ginan-sensors.js";

/**
 * 岐阜県立岐南工業高等学校「電子工学科 1〜3 年」の **テナント（学校 + 学科 + 学年 + クラス）** を
 * staging に用意するための **シードデータ（純データ・副作用なし）**。実投入は
 * {@link ./seed-ginan-school-cli.ts}。
 *
 * ## なぜ必要か
 * 既存の岐南シード（{@link ./seed-ginan-sensors.ts} センサー / seed-ginan-ads 広告 /
 * {@link ./seed-ginan-tv-devices.ts} TV）は **岐南テナントが既存である前提**で fail-loud する。staging には
 * 合成の「E2Eテスト高校」しか無いため、本シードで岐南テナントの最小構成（電子工学科 × 1〜3 年 × 各 1 クラス）を
 * 先に用意し、TV/センサー/広告シードを実行可能にする。
 *
 * ## 階層（ADR / schema に準拠）
 * `hierarchy_mode='department'`（学科制）。schools → departments(電子工学科) → grades(1年/2年/3年) →
 * classes(各学年 1 クラス=「A組」)。TV/センサーシードは「電子工学科 × 学年」でクラスを一意解決して紐づける。
 *
 * ## PII 非格納（ルール4）
 * 学校名・学科名・学年名・クラス名（"A組"）のみ。生徒名・保護者名等の PII は一切入れない。
 */

/** 学年 + 単一クラスの定義（電子工学科は各学年 1 クラス運用）。 */
export interface GinanGradeSeed {
  /** 学年番号（1〜3）。classes.grade に入る。 */
  grade: 1 | 2 | 3;
  /** 学年名（grades.name）。signage の学年表示に使う。 */
  gradeName: string;
  /** クラス名（classes.name）。signage は「学科 学年 クラス」を連結表示する。 */
  className: string;
}

/** 学校（テナント）の確定値。 */
export const GINAN_SCHOOL = {
  name: GINAN_SCHOOL_NAME,
  prefecture: "岐阜県",
  /** 学科制（電子工学科を持つ）。 */
  hierarchyMode: "department" as const,
} as const;

/** 学科名（電子工学科）。sensor/TV シードと共有。 */
export const GINAN_DEPARTMENT = GINAN_ECE_DEPARTMENT_NAME;

/** クラスの年度（PoC 年度）。env `SEED_GINAN_ACADEMIC_YEAR` で上書き可（CLI 側）。 */
export const GINAN_ACADEMIC_YEAR = 2026;

/** 電子工学科 1〜3 年（各学年 1 クラス）。 */
export const GINAN_GRADES: readonly GinanGradeSeed[] = [
  { grade: 1, gradeName: "1年", className: "A組" },
  { grade: 2, gradeName: "2年", className: "A組" },
  { grade: 3, gradeName: "3年", className: "A組" },
];

/**
 * シードデータの自己整合性を検証する（CLI が DB 接触前に fail-fast。テストでも実行）。
 *  - 学年が 1〜3 で重複しない / gradeName・className が 1..64 文字（schema varchar(64)）
 *  - 配列が空でない
 */
export function validateGinanSchoolSeed(grades: readonly GinanGradeSeed[] = GINAN_GRADES): void {
  if (grades.length === 0) {
    throw new Error("[seed-ginan-school] grade list is empty");
  }
  const seen = new Set<number>();
  for (const g of grades) {
    if (g.grade < 1 || g.grade > 3) {
      throw new Error(`[seed-ginan-school] grade out of range: ${g.grade}`);
    }
    if (seen.has(g.grade)) {
      throw new Error(`[seed-ginan-school] duplicate grade: ${g.grade}`);
    }
    if (g.gradeName.length === 0 || g.gradeName.length > 64) {
      throw new Error(`[seed-ginan-school] gradeName length out of range: ${g.gradeName}`);
    }
    if (g.className.length === 0 || g.className.length > 64) {
      throw new Error(`[seed-ginan-school] className length out of range: ${g.className}`);
    }
    seen.add(g.grade);
  }
}
