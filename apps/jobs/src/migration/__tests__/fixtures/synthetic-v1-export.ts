import type { V1Export } from "../../types.js";

/**
 * トラック⑤ MIG 用 合成 V1 エクスポート fixture
 * (docs/testing/tracks/05-migration-audit-compliance.md §5)。
 *
 * `transform.test.ts` の単一校 fixture を母体に、**意図的なエッジ**を盛り込む:
 * - **2 校以上** (S1 / S2) — 移行後 RLS テナント分離 (MIG-006) の越境検出に必須。
 * - **マルチバイト + 絵文字 + 全角記号 + 入れ子 JSONB** (MIG-003) — 文字化け・型崩れの検出。
 * - **全 scope** (school / department / grade / class) の ads / configs / daily_data (MIG-008 前哨)。
 * - **`hasClasses=false` の学年** (S1/G2) と **空配列フィールド** (G2.ads=[]) — silent drop 検出。
 * - **省略フィールド** (S1.prefecture / S2.code / 既定 durationSec・captionFontScale・displayOrder)
 *   — 既定値変換の検証。
 *
 * 決定論 UUID の衝突を避けるため、同一 scope 内で ad は index・config は kind・daily は date が
 * 一意になるよう構成する (衝突すると `onConflictDoNothing` で 2 件目が落ち V1 件数 > DB 件数 = MIG-001
 * が検出する想定の不具合。正しい実装ではこの fixture は衝突しない)。
 */
export const syntheticV1Export: V1Export = {
  schools: [
    {
      id: "S1",
      name: "岐南工業高校🏫", // 絵文字込みマルチバイト
      // prefecture 省略 → "不明" に倒れる (MIG-003 既定)
      code: "GIFU-01",
      configs: [
        // 入れ子 JSONB の構造保持を検証
        { kind: "display_settings", value: { theme: "dark", palette: { bg: "#000", fg: "#fff" } } },
      ],
      ads: [
        // school scope ad: 既定値 (durationSec=5 / captionFontScale=1 / displayOrder=0)
        { mediaUrl: "https://example.com/s1-school.png", mediaType: "image" },
      ],
      masterDailyData: [
        {
          date: "2026-05-01",
          schedules: [
            { period: 1, subject: "数学" },
            { period: 2, subject: "国語" },
          ],
          notices: ["🎌 全校集会 13:00"],
          // assignments / quietHours 省略 → [] 既定
        },
      ],
      departments: [
        {
          id: "D1",
          name: "機械科",
          displayOrder: 2,
          ads: [{ mediaUrl: "https://example.com/s1-dept.mp4", mediaType: "video" }],
          configs: [{ kind: "quiet_hours", value: { start: "22:00", end: "06:00" } }],
        },
      ],
      grades: [
        {
          id: "G1",
          name: "1年",
          departmentId: "D1", // 学科リンク (FK 整合 MIG-002)
          displayOrder: 1,
          ads: [
            {
              mediaUrl: "https://example.com/s1-g1.png",
              mediaType: "image",
              durationSec: 12, // 明示値 (既定 5 と区別)
              captionFontScale: 1.3, // 明示値 (real)
              displayOrder: 7, // 明示 displayOrder
              caption: "🎓 進路ガイダンス〜未来へ", // 絵文字 + 全角チルダ
              linkUrl: "https://example.com/guide",
            },
          ],
          dailyData: [{ date: "2026-05-02" }], // 全配列省略 → [] 既定
          configs: [{ kind: "schedule_templates", value: { rows: 6 } }],
          classes: [
            {
              id: "C1",
              name: "1年A組",
              academicYear: 2026,
              grade: 1,
              ads: [
                // displayOrder 省略 → index 0, 1
                { mediaUrl: "https://example.com/s1-c1-0.png", mediaType: "image" },
                { mediaUrl: "https://example.com/s1-c1-1.png", mediaType: "image" },
              ],
              dailyData: [{ date: "2026-05-03", notices: ["台風接近のため繰り上げ下校⚠️"] }],
              configs: [], // 空配列
            },
          ],
        },
        {
          id: "G2",
          name: "専攻科",
          hasClasses: false, // 学年自体が 1 表示単位 (MIG-008)
          displayOrder: 9,
          ads: [], // 空配列 → silent drop でないことの確認
          dailyData: [{ date: "2026-05-04", assignments: ["特別研究レポート提出"] }],
        },
      ],
    },
    {
      id: "S2",
      name: "桜丘高等学校", // 別校 (テナント分離検証用)
      prefecture: "岐阜県",
      // code 省略 → null
      ads: [
        {
          mediaUrl: "https://example.com/s2-school.png",
          mediaType: "image",
          caption: "桜丘の魅力🌸",
        },
      ],
      grades: [
        {
          id: "G1",
          name: "1年",
          classes: [{ id: "C1", name: "桜組", academicYear: 2026, grade: 1 }],
        },
      ],
    },
  ],
};

/** テーブルごとの行数。`transform.ts` に**依存せず** V1 構造を直接走査して導く期待値。 */
export type EntityCounts = {
  schools: number;
  departments: number;
  grades: number;
  classes: number;
  schoolConfigs: number;
  dailyData: number;
  ads: number;
};

/**
 * V1 エクスポートの**論理件数**を transform 非依存で数える (MIG-001 の vacuous 回避)。
 *
 * transform/import が 1 件でも落とす・重複させると `total` と DB 実件数がズレて検出される。
 * scope 別の所属は V1 の構造そのまま (school=s.*, department=d.*, grade=g.*, class=c.*)。
 * daily_data は school(masterDailyData) / grade / class のみ (department は V1 に dailyData を持たない、
 * transform と一致)。`bySchool` は MIG-006 のテナント別期待件数に使う (V1 school id キー)。
 */
export function countV1(exp: V1Export): {
  total: EntityCounts;
  bySchool: Record<string, EntityCounts>;
} {
  const total: EntityCounts = empty();
  const bySchool: Record<string, EntityCounts> = {};
  for (const s of exp.schools) {
    const c = empty();
    c.schools = 1;
    c.schoolConfigs += s.configs?.length ?? 0;
    c.ads += s.ads?.length ?? 0;
    c.dailyData += s.masterDailyData?.length ?? 0;
    for (const d of s.departments ?? []) {
      c.departments += 1;
      c.schoolConfigs += d.configs?.length ?? 0;
      c.ads += d.ads?.length ?? 0;
    }
    for (const g of s.grades ?? []) {
      c.grades += 1;
      c.schoolConfigs += g.configs?.length ?? 0;
      c.ads += g.ads?.length ?? 0;
      c.dailyData += g.dailyData?.length ?? 0;
      for (const cls of g.classes ?? []) {
        c.classes += 1;
        c.schoolConfigs += cls.configs?.length ?? 0;
        c.ads += cls.ads?.length ?? 0;
        c.dailyData += cls.dailyData?.length ?? 0;
      }
    }
    bySchool[s.id] = c;
    for (const k of Object.keys(total) as (keyof EntityCounts)[]) total[k] += c[k];
  }
  return { total, bySchool };
}

function empty(): EntityCounts {
  return {
    schools: 0,
    departments: 0,
    grades: 0,
    classes: 0,
    schoolConfigs: 0,
    dailyData: 0,
    ads: 0,
  };
}
