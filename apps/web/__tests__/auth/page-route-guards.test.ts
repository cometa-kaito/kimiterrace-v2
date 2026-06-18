import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ページ層ロールガードの静的監査 (RBAC fail-safe)。
 *
 * 認可の本体は RLS (ADR-019) だが、ページガードは「運営画面をそもそも見せない」深層防御の早期ゲート。
 * `/ops` レイアウトは `requireRole(ADMIN_ROLES)` (system_admin/school_admin/teacher を通す) 止まりで、
 * system_admin への絞り込みは**各ページ個別**の `requireRole(SYSTEM_ADMIN_ROLES)` に依存する。つまり
 * 新しい `/ops` ページをガード無し (または広すぎる集合) で追加すると、レイアウトが受け止めず
 * school_admin/teacher に運営画面が開いてしまう。
 *
 * 本監査はその「付け忘れ」を CI で機械的に検出する (人力レビューに依存しない、CLAUDE.md ルール2/7 と同思想):
 * 1. /ops 配下の page.tsx は既定で `requireRole(SYSTEM_ADMIN_ROLES)` を直接呼ぶ。意図的に広い例外
 *    (tv-devices) と、ガード済み共通コンポーネントへの委譲 (ClassPickerPage) のみ allowlist で許す。
 * 2. /app/editor/scope 配下の page.tsx は委譲先 View と同じ集合 (EDITOR/ADS/QUIET_HOURS_ROLES) を
 *    ページ本体でも直接呼ぶ (多層防御・棚卸し耐性)。
 *
 * docstring 内の `requireRole(...)` 言及を実コードと誤認しないよう、コメント除去後に `await requireRole(`
 * (実行形) のみを抽出する。
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** ブロック / 行コメントを除去 (URL の `//` は temporarily 保護)。docstring の guard 言及を実コードと分離する。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // /* ... */ (JSDoc 含む)
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // // ... (http:// は : の直後なので除去しない)
}

/** 実行コードの最初の `await requireRole(SET)` から SET 名を取る。無ければ null。 */
function directGuardRole(code: string): string | null {
  const m = code.match(/await\s+requireRole\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
  return m?.[1] ?? null;
}

/** `root` 配下の page.tsx を再帰収集し、WEB_ROOT 相対 (forward slash) で返す。 */
function collectPages(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry === "page.tsx") {
        out.push(relative(WEB_ROOT, full).replaceAll("\\", "/"));
      }
    }
  }
  walk(root);
  return out;
}

const read = (rel: string) => stripComments(readFileSync(join(WEB_ROOT, rel), "utf8"));

// ───────────────────────── /ops fail-safe ─────────────────────────

describe("RBAC: /ops 配下のページは system_admin に絞られている (fail-safe)", () => {
  const OPS_PREFIX = "app/ops/";
  const opsPages = collectPages(join(WEB_ROOT, "app", "ops"));

  /**
   * 既定 (SYSTEM_ADMIN_ROLES) と異なる、意図的に広いガードを持つ例外。
   * tv-devices は「一覧/履歴は閲覧のみ teacher も可 (RLS が自校に限定)、編集/登録は別途狭くガード」が
   * 文書化された設計 (各ページ docstring + memory)。
   */
  const ROLE_EXCEPTIONS: Record<string, string> = {
    [`${OPS_PREFIX}tv-devices/page.tsx`]: "ADMIN_ROLES",
    [`${OPS_PREFIX}tv-devices/[deviceId]/history/page.tsx`]: "ADMIN_ROLES",
    [`${OPS_PREFIX}tv-devices/[deviceId]/edit/page.tsx`]: "TV_CONFIG_EDIT_ROLES",
    [`${OPS_PREFIX}tv-devices/new/page.tsx`]: "ONBOARDING_ROLES",
    [`${OPS_PREFIX}tv-devices/provision/page.tsx`]: "ONBOARDING_ROLES",
  };

  /**
   * ページ本体で直接 requireRole せず、ガード済み共通コンポーネントに委譲するページ。
   * 委譲先 (ClassPickerPage) が SYSTEM_ADMIN_ROLES でガードすることは別 it で固定する。
   */
  const DELEGATED_TO_GUARDED_WRAPPER: Record<string, string> = {
    [`${OPS_PREFIX}schools/[id]/ads/page.tsx`]: "ClassPickerPage",
    [`${OPS_PREFIX}schools/[id]/editor/page.tsx`]: "ClassPickerPage",
    [`${OPS_PREFIX}schools/[id]/magic-link/page.tsx`]: "ClassPickerPage",
    [`${OPS_PREFIX}schools/[id]/quiet-hours/page.tsx`]: "ClassPickerPage",
  };

  it("監査対象を実際に収集できている (vacuous 防止)", () => {
    expect(opsPages.length).toBeGreaterThan(30);
    expect(opsPages).toContain(`${OPS_PREFIX}users/page.tsx`);
    expect(opsPages).toContain(`${OPS_PREFIX}schools/new/page.tsx`);
  });

  it("各 /ops ページは SYSTEM_ADMIN_ROLES で直接ガード (例外/委譲のみ allowlist、付け忘れは赤)", () => {
    const violations: string[] = [];
    for (const rel of opsPages) {
      const wrapper = DELEGATED_TO_GUARDED_WRAPPER[rel];
      if (wrapper !== undefined) {
        if (!read(rel).includes(wrapper)) {
          violations.push(`${rel}: 委譲先 ${wrapper} の使用が見当たらない`);
        }
        continue;
      }
      const expected = ROLE_EXCEPTIONS[rel] ?? "SYSTEM_ADMIN_ROLES";
      const actual = directGuardRole(read(rel));
      if (actual !== expected) {
        violations.push(`${rel}: requireRole=${actual ?? "なし"} (期待: ${expected})`);
      }
    }
    expect(violations, `ガード不備:\n${violations.join("\n")}`).toEqual([]);
  });

  it("委譲先 ClassPickerPage は SYSTEM_ADMIN_ROLES でガードする (委譲の安全性を固定)", () => {
    const src = read(`${OPS_PREFIX}schools/[id]/_components/ClassPickerPage.tsx`);
    expect(directGuardRole(src)).toBe("SYSTEM_ADMIN_ROLES");
  });

  it("allowlist が陳腐化していない (例外/委譲に挙げたファイルが実在する)", () => {
    for (const rel of [
      ...Object.keys(ROLE_EXCEPTIONS),
      ...Object.keys(DELEGATED_TO_GUARDED_WRAPPER),
    ]) {
      expect(opsPages, `allowlist の ${rel} が /ops に存在しない`).toContain(rel);
    }
  });
});

// ───────────────────────── /app/editor/scope の自己ガード ─────────────────────────

describe("RBAC: editor scope ページは委譲先 View と同じ集合で自己ガードする", () => {
  const SCOPE_PREFIX = "app/app/editor/scope/";
  const scopePages = collectPages(join(WEB_ROOT, "app", "app", "editor", "scope"));

  /** suffix から期待ロール集合を決める (ads/quiet-hours は別集合、それ以外は編集集合)。 */
  function expectedScopeRole(rel: string): string {
    if (rel.endsWith("/ads/page.tsx")) return "ADS_ROLES";
    if (rel.endsWith("/quiet-hours/page.tsx")) return "QUIET_HOURS_ROLES";
    return "EDITOR_ROLES";
  }

  it("監査対象を実際に収集できている (vacuous 防止)", () => {
    // school / grade[id] / department[id] × {base, ads, quiet-hours} = 9 枚。
    expect(scopePages.length).toBe(9);
    expect(scopePages).toContain(`${SCOPE_PREFIX}school/page.tsx`);
  });

  it("各 scope ページがページ本体で適切な集合を requireRole する", () => {
    const violations: string[] = [];
    for (const rel of scopePages) {
      const expected = expectedScopeRole(rel);
      const actual = directGuardRole(read(rel));
      if (actual !== expected) {
        violations.push(`${rel}: requireRole=${actual ?? "なし"} (期待: ${expected})`);
      }
    }
    expect(violations, `ガード不備:\n${violations.join("\n")}`).toEqual([]);
  });
});

// ───────────────────────── 検出器そのものの健全性 ─────────────────────────

describe("検出器の健全性 (正の対比)", () => {
  it("コメント内の requireRole 言及は実コードと誤認しない", () => {
    const src = stripComments(`
      /** 認可: 親 layout の requireRole(ADMIN_ROLES) に加え requireRole(SYSTEM_ADMIN_ROLES)。 */
      export default async function P() {
        await requireRole(SYSTEM_ADMIN_ROLES); // ← 実行されるのはこれ
      }
    `);
    expect(directGuardRole(src)).toBe("SYSTEM_ADMIN_ROLES");
  });

  it("ガードが全く無いページは null を返す (= fail-safe が赤を出せる)", () => {
    const src = stripComments("export default function P() { return null; }");
    expect(directGuardRole(src)).toBeNull();
  });
});
