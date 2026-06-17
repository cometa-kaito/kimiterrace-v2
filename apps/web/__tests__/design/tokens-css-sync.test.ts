import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * デザイントークンの二重管理ドリフトガード（単一ソースの一致を機械的に固定）。
 *
 * ブランド色は **2 箇所**に同じ値で存在する:
 *   - `packages/ui/src/tokens.ts` の `color`（インライン style 経路の TS 定数）
 *   - `apps/web/app/globals.css` の `:root --brand-*`（className 経路の CSS 変数）
 * 両者は「同値であること」がコメントで義務付けられているだけで、これまで **CI 検証が無かった**。
 * 一方だけ変更するとブランドが面で割れる（インライン style と className で別の色が出る）。
 *
 * 本テストは tokens.ts と globals.css を **ソースとしてそのまま読んで突合**する（barrel `@kimiterrace/ui`
 * を import すると client component の .tsx を巻き込むため、値の比較はテキスト解析で行う）。
 * 値がズレた／CSS 側にブランド変数を足して bridge を更新し忘れた／token 名を消した、のいずれでも落ちる。
 */

// このテストファイルからの相対でリポジトリ内の 2 ソースを解決（cwd 非依存）。
const CSS_PATH = fileURLToPath(new URL("../../app/globals.css", import.meta.url));
const TOKENS_PATH = fileURLToPath(new URL("../../../../packages/ui/src/tokens.ts", import.meta.url));

/**
 * tokens.ts `color`（TS 定数）⇄ globals.css `--brand-*`（CSS 変数）の橋渡し表。
 * ここに載るキーは「ブランド基調」= 両ソースに同値で存在しなければならないもの。
 * tokens.ts の status 系（neutralBg 等）は globals.css `:root` に持たないので含めない。
 * **新しいブランド色を増やす時はこの表に 1 行足す**（足し忘れると下の網羅チェックで落ちる）。
 */
const BRAND_BRIDGE: Record<string, string> = {
  orange: "--brand-orange",
  blue: "--brand-blue",
  blueStrong: "--brand-blue-strong",
  ink: "--brand-ink",
  muted: "--brand-muted",
  border: "--brand-border",
  bgSoft: "--brand-bg-soft",
  primary: "--brand-primary",
  primaryHover: "--brand-primary-hover",
};

/** globals.css の `:root { ... }` ブロックから `--name: #hex` 宣言だけを抜き出す（コメント内 hex は無視）。 */
function parseCssRootVars(css: string): Map<string, string> {
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!root) throw new Error("globals.css に :root ブロックが見つからない");
  const vars = new Map<string, string>();
  // 宣言（`--name:` 始まり）のみを拾う。/* ... */ コメント中の裸の #hex は前置の `--name:` が無いので当たらない。
  const re = /--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g;
  for (const m of root[1].matchAll(re)) vars.set(m[1], m[2].toLowerCase());
  return vars;
}

/** tokens.ts の `export const color = { ... } as const;` から `key: "#hex"` を抜き出す（コメント内 hex は無視）。 */
function parseTokenColors(ts: string): Map<string, string> {
  const block = ts.match(/export const color\s*=\s*\{([\s\S]*?)\}\s*as const;/);
  if (!block) throw new Error("tokens.ts に color オブジェクトが見つからない");
  const colors = new Map<string, string>();
  // 値は必ずクォート付き（`key: "#hex"`）。コメント中の hex はクォートが無いので当たらない。
  const re = /(\w+)\s*:\s*"(#[0-9a-fA-F]{3,8})"/g;
  for (const m of block[1].matchAll(re)) colors.set(m[1], m[2].toLowerCase());
  return colors;
}

const cssVars = parseCssRootVars(readFileSync(CSS_PATH, "utf8"));
const tokenColors = parseTokenColors(readFileSync(TOKENS_PATH, "utf8"));

describe("ブランドトークン tokens.ts ⇄ globals.css の一致（ドリフトガード）", () => {
  it("解析自体が成立する（両ソースから値を取れている）", () => {
    expect(cssVars.size, "globals.css :root から --xxx 変数を取れていない").toBeGreaterThan(0);
    expect(tokenColors.size, "tokens.ts color から色を取れていない").toBeGreaterThan(0);
  });

  it.each(Object.entries(BRAND_BRIDGE))(
    "color.%s と %s が同値",
    (tokenKey, cssVar) => {
      const tokenVal = tokenColors.get(tokenKey);
      const cssVal = cssVars.get(cssVar.replace(/^--/, ""));
      expect(tokenVal, `tokens.ts に color.${tokenKey} が無い`).toBeDefined();
      expect(cssVal, `globals.css に ${cssVar} が無い`).toBeDefined();
      expect(
        tokenVal,
        `ドリフト検出: color.${tokenKey}=${tokenVal} ≠ ${cssVar}=${cssVal}（両方を同値に直す）`,
      ).toBe(cssVal);
    },
  );

  it("globals.css の全 --brand-* が bridge に載っている（CSS 追加時の bridge 更新忘れを検出）", () => {
    const bridgedCssVars = new Set(Object.values(BRAND_BRIDGE).map((v) => v.replace(/^--/, "")));
    const unbridged = [...cssVars.keys()].filter(
      (name) => name.startsWith("brand-") && !bridgedCssVars.has(name),
    );
    expect(
      unbridged,
      `bridge 未登録の --${unbridged.join(", --")} がある。tokens.ts に対応色を足し BRAND_BRIDGE に追記する`,
    ).toEqual([]);
  });

  it("bridge の各 token キーが tokens.ts に実在する（token 改名／削除を検出）", () => {
    const missing = Object.keys(BRAND_BRIDGE).filter((k) => !tokenColors.has(k));
    expect(missing, `BRAND_BRIDGE のキー ${missing.join(", ")} が tokens.ts color に無い`).toEqual([]);
  });
});
