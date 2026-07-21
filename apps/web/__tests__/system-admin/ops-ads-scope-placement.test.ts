import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #46 一括掲載: 運営 (system_admin) の広告掲載導線が、クラス単位だけでなく **学校 / 学科 / 学年** の
 * スコープ掲載（配下クラスへ継承）へ開放されたことを固定する静的監査。
 *
 * データ層 (`ads.scope` + `effective_ads_per_class` VIEW + 汎用 Server Actions) と `AdsManager` は既に
 * 全スコープ対応済で、本改修は **運営導線 (`/ops/schools/[id]/ads`) の入口とスコープ別ページ** を足すもの。
 * ルート/認可の網羅は `auth/page-route-guards.test.ts` が担うので、ここでは「旧制約文言の撤去」と
 * 「4 スコープの入口が揃っていること」を回帰の錨として押さえる。
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(WEB_ROOT, rel), "utf8");

const OPS_ADS = "app/ops/schools/[id]/ads";

describe("運営の広告掲載ピッカー (掲載先スコープ選択)", () => {
  const picker = read(`${OPS_ADS}/page.tsx`);

  it("旧「一括掲載は今後対応 / 現状はクラス単位」の制約文言を撤去している", () => {
    // 旧ピッカーがサブ説明に出していた制約文の実体（docstring の言及と衝突しない完全一致で見る）。
    expect(picker).not.toContain("一括掲載は今後対応します");
    expect(picker).not.toContain("現状はクラス単位");
  });

  it("学校 / 学科 / 学年 / クラスの 4 スコープすべてに入口がある", () => {
    // 学校全体・学科・学年（scope 掲載）の遷移先。
    expect(picker).toContain("/scope/school");
    expect(picker).toContain("/scope/department/");
    expect(picker).toContain("/scope/grade/");
    // クラス単位（従来導線）は base 直下の classId 遷移で維持する。
    expect(picker).toContain("${base}/${c.classId}");
  });

  it("階層取得は対象校 tenantScoped tx で行う (getSchoolHierarchy の全校漏れ防止)", () => {
    expect(picker).toContain("getSchoolHierarchy");
    expect(picker).toContain("tenantScoped: true");
    expect(picker).toContain("schoolId: school.id");
  });

  it("ページ本体で SYSTEM_ADMIN_ROLES を直接ガードする (ClassPickerPage 委譲をやめた)", () => {
    expect(picker).toContain("await requireRole(SYSTEM_ADMIN_ROLES)");
    // 委譲廃止は「import しないこと」で見る（docstring/コメントの言及とは衝突しない）。
    expect(picker).not.toMatch(/import[^\n]*ClassPickerPage/);
  });
});

describe("スコープ別広告ページ (school / department / grade) が揃っている", () => {
  const scopePages = [
    `${OPS_ADS}/scope/school/page.tsx`,
    `${OPS_ADS}/scope/department/[departmentId]/page.tsx`,
    `${OPS_ADS}/scope/grade/[gradeId]/page.tsx`,
  ];

  it("3 枚とも存在し OpsScopeAdsView に委譲する", () => {
    for (const rel of scopePages) {
      const src = read(rel);
      expect(src, `${rel} が OpsScopeAdsView に委譲していない`).toContain("OpsScopeAdsView");
    }
  });

  it("3 枚とも system_admin を直接ガードする (深層防御)", () => {
    for (const rel of scopePages) {
      const src = read(rel);
      expect(src, `${rel} が SYSTEM_ADMIN_ROLES を直接ガードしていない`).toContain(
        "await requireRole(SYSTEM_ADMIN_ROLES)",
      );
    }
  });
});

describe("OpsScopeAdsView (スコープ広告編集の共通ビュー)", () => {
  const view = read(`app/ops/schools/[id]/_components/OpsScopeAdsView.tsx`);

  it("対象校スコープ (tenantScoped + schoolId) で読み、AdsManager に schoolId を渡す (越境防止)", () => {
    expect(view).toContain("tenantScoped: true");
    expect(view).toContain("schoolId");
    // AdsManager に schoolId を渡すことで Server Action が対象校に結線される (system_admin /ops 経路)。
    expect(view).toContain("schoolId={schoolId}");
  });

  it("継承広告セクションは出さない (自スコープ広告のみ管理; per-class 実効ビューはクラス画面が担う)", () => {
    expect(view).toContain("showInherited={false}");
  });
});
