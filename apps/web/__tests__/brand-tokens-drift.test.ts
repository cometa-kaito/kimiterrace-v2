import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tokens } from "@kimiterrace/ui";
import { describe, expect, it } from "vitest";

/**
 * `@kimiterrace/ui` の TS デザイントークンと `apps/web/app/globals.css` の `--brand-*` CSS 変数が
 * **同じ値を指す**ことを強制する（ドリフト検知）。
 *
 * トークンは「インライン style 経路（TS 定数）」と「className 経路（CSS 変数）」の二経路で参照される。
 * 二重管理ゆえ放置すると静かにズレる（Reviewer #627 nit）。本テストが CI で両者の一致を pin し、
 * 「ブランド変更時に片方だけ直す」回帰を fail-closed で止める。
 *
 * Semgrep（SAST）の non-literal-regexp ルールを踏まないよう、抽出は**単一のリテラル正規表現**で行い
 * 動的 `new RegExp` を使わない（[[feedback_adversarial_safetynet_test_patterns]]）。
 */

const cssPath = fileURLToPath(new URL("../app/globals.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

// `--brand-xxx: #rrggbb;` を全件抽出（リテラル正規表現・global）。
const BRAND_VAR_RE = /--(brand-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\b/g;

const cssVars = new Map<string, string>();
for (const m of css.matchAll(BRAND_VAR_RE)) {
  const name = m[1];
  const value = m[2];
  if (name && value) {
    cssVars.set(name, value.toLowerCase());
  }
}

// CSS 変数名 → 対応する TS トークン値（globals.css と tokens.ts の対応表）。
const SHARED: Record<string, string> = {
  "brand-orange": tokens.color.orange,
  "brand-blue": tokens.color.blue,
  "brand-ink": tokens.color.ink,
  "brand-muted": tokens.color.muted,
  "brand-border": tokens.color.border,
  "brand-bg-soft": tokens.color.bgSoft,
  "brand-primary": tokens.color.primary,
  "brand-primary-hover": tokens.color.primaryHover,
};

describe("brand token ↔ globals.css ドリフト検知", () => {
  it("globals.css が想定の --brand-* を実際に定義している（抽出ロジックの vacuous 化防止）", () => {
    // 8 変数すべてが見つからなければ抽出が壊れている＝以降の一致検証が無意味になるため先に固める。
    for (const name of Object.keys(SHARED)) {
      expect(cssVars.has(name), `globals.css に --${name} が無い`).toBe(true);
    }
    expect(cssVars.size).toBeGreaterThanOrEqual(Object.keys(SHARED).length);
  });

  it.each(Object.entries(SHARED))("--%s が TS トークンと一致する", (name, tokenValue) => {
    expect(cssVars.get(name)).toBe(tokenValue.toLowerCase());
  });
});
