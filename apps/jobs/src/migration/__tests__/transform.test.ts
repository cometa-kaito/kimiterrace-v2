import { describe, expect, it } from "vitest";
import { MIGRATION_NAMESPACE, uuidv5, v2Id } from "../ids.js";
import { transformExport } from "../transform.js";
import type { V1Export } from "../types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** noUncheckedIndexedAccess 下で配列先頭/検索結果を非 undefined に確定する小ヘルパ。 */
function def<T>(v: T | undefined, msg = "値が undefined"): T {
  if (v === undefined) {
    throw new Error(msg);
  }
  return v;
}

function byScope<T extends { scope: string }>(arr: T[], sc: string): T[] {
  return arr.filter((r) => r.scope === sc);
}

describe("uuidv5 / v2Id (決定論的 id)", () => {
  it("同じ入力は同じ UUID、形式は RFC4122、version=5 / variant=10xx", () => {
    const a = uuidv5("school:abc");
    const b = uuidv5("school:abc");
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
    expect(a[14]).toBe("5"); // version nibble
    expect(["8", "9", "a", "b"]).toContain(a[19]); // variant
  });

  it("入力が違えば別 UUID / namespace に依存", () => {
    expect(uuidv5("school:abc")).not.toBe(uuidv5("school:def"));
    expect(uuidv5("x", MIGRATION_NAMESPACE)).not.toBe(
      uuidv5("x", "00000000-0000-0000-0000-000000000000"),
    );
  });

  it("種別プレフィックスで衝突しない (school と grade で同じ生キーでも別 id)", () => {
    expect(v2Id.school("1")).not.toBe(v2Id.grade("1", "1"));
    expect(v2Id.class("s", "g", "c")).toMatch(UUID_RE);
  });
});

const fixture: V1Export = {
  schools: [
    {
      id: "S1",
      name: "岐南工業高校",
      // prefecture 省略 → "不明" に倒れる
      configs: [{ kind: "display_settings", value: { theme: "dark" } }],
      ads: [{ mediaUrl: "https://x/sch.png", mediaType: "image" }],
      masterDailyData: [{ date: "2026-05-01", schedules: [{ p: 1 }] }],
      departments: [
        {
          id: "D1",
          name: "機械科",
          displayOrder: 2,
          ads: [{ mediaUrl: "https://x/d.mp4", mediaType: "video" }],
        },
      ],
      grades: [
        {
          id: "G1",
          name: "1年",
          departmentId: "D1",
          ads: [
            {
              mediaUrl: "https://x/g.png",
              mediaType: "image",
              displayOrder: 7,
              durationSec: 12,
              captionFontScale: 1.3,
              caption: "学年広告",
              linkUrl: "https://x",
            },
          ],
          dailyData: [{ date: "2026-05-02" }],
          classes: [
            {
              id: "C1",
              name: "1年A組",
              academicYear: 2026,
              grade: 1,
              ads: [
                { mediaUrl: "https://x/a0.png", mediaType: "image" },
                { mediaUrl: "https://x/a1.png", mediaType: "image" },
              ],
              dailyData: [{ date: "2026-05-03", notices: ["台風休校"] }],
            },
          ],
        },
      ],
    },
  ],
};

describe("transformExport", () => {
  const rows = transformExport(fixture);

  it("school: prefecture 既定 / code null / 監査者 null / id 決定論", () => {
    expect(rows.schools).toHaveLength(1);
    const s = def(rows.schools[0]);
    expect(s.id).toBe(v2Id.school("S1"));
    expect(s.prefecture).toBe("不明");
    expect(s.code).toBeNull();
    expect(s.createdBy).toBeNull();
    expect(s.updatedBy).toBeNull();
  });

  it("階層リンク: grade.department_id / class.grade_id が決定論 id で結線される", () => {
    const g = def(rows.grades[0]);
    expect(g.departmentId).toBe(v2Id.department("S1", "D1"));
    const c = def(rows.classes[0]);
    expect(c.gradeId).toBe(v2Id.grade("S1", "G1"));
    expect(c.schoolId).toBe(v2Id.school("S1"));
    expect(c.academicYear).toBe(2026);
  });

  it("scope 列: 各 scope で正しい *_id のみ非 null (schema CHECK 整合)", () => {
    const schoolAd = def(byScope(rows.ads, "school")[0]);
    expect([schoolAd.gradeId, schoolAd.departmentId, schoolAd.classId]).toEqual([null, null, null]);
    const gradeAd = def(byScope(rows.ads, "grade")[0]);
    expect(gradeAd.gradeId).toBe(v2Id.grade("S1", "G1"));
    expect([gradeAd.departmentId, gradeAd.classId]).toEqual([null, null]);
    const deptAd = def(byScope(rows.ads, "department")[0]);
    expect(deptAd.departmentId).toBe(v2Id.department("S1", "D1"));
    expect([deptAd.gradeId, deptAd.classId]).toEqual([null, null]);
    const classAd = def(byScope(rows.ads, "class")[0]);
    expect(classAd.classId).toBe(v2Id.class("S1", "G1", "C1"));
    expect([classAd.gradeId, classAd.departmentId]).toEqual([null, null]);
  });

  it("ads: 既定値 (durationSec=5 / fontScale=1 / displayOrder=index) と明示値", () => {
    const classAds = byScope(rows.ads, "class");
    expect(classAds).toHaveLength(2);
    expect(def(classAds[0]).durationSec).toBe(5);
    expect(def(classAds[0]).captionFontScale).toBe(1);
    expect(def(classAds[0]).displayOrder).toBe(0);
    expect(def(classAds[1]).displayOrder).toBe(1);
    const gradeAd = def(byScope(rows.ads, "grade")[0]);
    expect(gradeAd.durationSec).toBe(12);
    expect(gradeAd.displayOrder).toBe(7);
    expect(gradeAd.captionFontScale).toBe(1.3);
  });

  it("daily_data: school / grade / class スコープ + 配列既定 []", () => {
    const dates = rows.dailyData.map((d) => `${d.scope}:${d.date}`).sort();
    expect(dates).toEqual(["class:2026-05-03", "grade:2026-05-02", "school:2026-05-01"]);
    const gradeDaily = def(byScope(rows.dailyData, "grade")[0]);
    expect(gradeDaily.schedules).toEqual([]);
    expect(gradeDaily.notices).toEqual([]);
  });

  it("school_configs: kind ごとに決定論 id", () => {
    expect(rows.schoolConfigs).toHaveLength(1);
    const cfg = def(rows.schoolConfigs[0]);
    expect(cfg.kind).toBe("display_settings");
    expect(cfg.value).toEqual({ theme: "dark" });
  });

  it("冪等: 同じエクスポートを 2 回変換しても全 id が一致", () => {
    const again = transformExport(fixture);
    expect(again.ads.map((a) => a.id)).toEqual(rows.ads.map((a) => a.id));
    expect(again.classes.map((c) => c.id)).toEqual(rows.classes.map((c) => c.id));
  });

  it("全行で created_by / updated_by が null (システム移行、ルール1)", () => {
    const all = [
      ...rows.schools,
      ...rows.departments,
      ...rows.grades,
      ...rows.classes,
      ...rows.schoolConfigs,
      ...rows.dailyData,
      ...rows.ads,
    ];
    for (const r of all) {
      expect(r.createdBy).toBeNull();
      expect(r.updatedBy).toBeNull();
    }
  });
});
