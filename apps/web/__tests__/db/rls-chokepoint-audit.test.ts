import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SEC-009 (T-03) / SEC-014 (I-01): テナント文脈チョークポイントの構造監査
 * (Part of #243、トラック③ `docs/testing/tracks/03-security-pentest.md`)。
 *
 * 脅威: `withTenantContext`（`SET LOCAL app.current_school_id` を張る seam）を**経由しない経路**で
 * 生 DB 接続 `getDb()` を使って read/write すると、RLS のテナント文脈が未設定のまま走り、ポリシー記法
 * 次第で**全テナント露出**や**前接続コンテキストでの交差汚染**を生む（SEC-009「withTenantContext を経由
 * しない経路探索」/ SEC-014「context 未設定経路」）。`kimiterrace_app` は非 BYPASSRLS だが、文脈未設定の
 * クエリは「0 件 or 漏洩」がポリシー記法に委ねられ、防御が一枚剥がれる。
 *
 * この監査は **apps/web の全本番ソース**を走査し、生 `getDb()` の使用が以下の**いずれか**に限られることを
 * 構造的に固定する（= テナント文脈をくぐる「正規の扉」以外から生接続を触らせない）:
 *
 *  (A) `withTenantContext(getDb(), ...)` — セッション/解決済みテナント文脈を張ってから tx を渡す正規経路。
 *  (B) **明示的に allowlist した「RLS の扉」関数**に `getDb()` を直接渡す経路。各扉は内部で安全に文脈を
 *      確立する（下記 {@link RLS_DOOR_FUNCTIONS} の justification 参照）。新たな扉を増やすには allowlist
 *      への追記（= レビュー時の明示判断）が必須になる。これが本監査の主眼: 生接続の使用面を**固定**する。
 *
 * lib/db.ts（チョークポイント定義モジュール自身: `getDb` 定義 + `withSession`/`withUserSession` ラッパ）は
 * 監査対象外（ラッパの内部実装が `withTenantContext(getDb())` を成すため）。
 *
 * 範囲正直: RLS の**実効**（文脈未設定で実際に 0 件/拒否になること）の実証は **packages/db の実 PG RLS
 * テスト**（別レーン）と staging が担う。本監査は apps/web 側で「生接続を触る経路が正規の扉に限られる」
 * という**構造不変条件**（多層防御の一枚）を固定するもので、RLS ポリシー自体の検証ではない。SECURITY
 * DEFINER 扉（resolve_magic_link / submit_feedback）の越境不能は #559（実 PG）が担保。
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const EXCLUDED_DIRS = new Set(["__tests__", "e2e", "node_modules", ".next", "coverage", "dist"]);
const SOURCE_EXT = /\.(ts|tsx)$/;

/** チョークポイント定義モジュール（getDb 定義 + withSession/withUserSession ラッパ本体）。監査対象外。 */
const CHOKEPOINT_MODULE = "lib/db.ts";

/**
 * 生 `getDb()` を直接受け取ってよい「RLS の扉」関数の allowlist。各扉は内部で安全に文脈を確立する:
 * - `resolveMagicLink` / `submitFeedback`: **SECURITY DEFINER** 関数（migrations 0007/0010、#559 が実 PG で
 *   越境不能 + search_path 固定を監査済）。匿名トークン解決 / 匿名フィードバック INSERT の「RLS をくぐる唯一の扉」。
 * - `recordPresenceEvent`: SwitchBot webhook の越境解決（#408/#410）。内部で **system_admin role 文脈**を張り、
 *   越境防止は解決キー `device_mac` の**グローバル UNIQUE**で担保（system_admin_full_access policy）。
 * - `pollTvConfig` / `pollPendingTvCommands` / `ackTvCommand`: TV デバイス poll（ADR-022）。device_id→school を
 *   **system_admin 文脈**で解決し BYPASSRLS 不使用。共有シークレット検証は route 側（poll-secret.ts）。
 *
 * 新たにこの集合へ追加するには allowlist 編集 = レビュー時の明示判断を要求する（生接続の使用面を固定）。
 */
const RLS_DOOR_FUNCTIONS = [
  "resolveMagicLink",
  "submitFeedback",
  "recordPresenceEvent",
  "pollTvConfig",
  "pollPendingTvCommands",
  "ackTvCommand",
] as const;

/** `withTenantContext(getDb())` または allowlist の扉に `getDb()` を渡す形（複数行・空白許容）。 */
const CONTEXTUALIZED_RE = new RegExp(
  `(?:withTenantContext|${RLS_DOOR_FUNCTIONS.join("|")})\\s*\\(\\s*getDb\\(\\)`,
);

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.(ts|tsx)$/.test(name) || name.endsWith(".d.ts");
}

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry)) walk(full);
      } else if (SOURCE_EXT.test(entry) && !isTestFile(entry)) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

/**
 * 行コメント `//` とブロックコメント `/* *​/`（JSDoc 含む）をコード面から除去する（位置保存のため空白化はせず、
 * コメント部分を落とした行配列を返す）。docstring 中の `getDb()` / `withTenantContext(getDb())` 等の言及を
 * コードと誤認しないため。文字列リテラル内 `//` は対象外（getDb 呼び出し行に URL 文字列が同居しない前提、
 * 万一の取りこぼしは false-negative 方向で稀・許容、コメントで明示）。
 */
function stripCommentsToLines(content: string): string[] {
  const rawLines = content.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  for (const raw of rawLines) {
    let result = "";
    let i = 0;
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf("*/", i);
        if (end === -1) {
          i = raw.length;
        } else {
          i = end + 2;
          inBlock = false;
        }
        continue;
      }
      if (raw.startsWith("//", i)) break; // 行末までコメント
      if (raw.startsWith("/*", i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      result += raw[i];
      i++;
    }
    out.push(result);
  }
  return out;
}

/** コード面（コメント除去後）の `getDb()` 使用箇所を行番号付きで返し、文脈付与済みかを判定する。 */
function collectGetDbSites(content: string): { line: number; contextualized: boolean }[] {
  const codeLines = stripCommentsToLines(content);
  const sites: { line: number; contextualized: boolean }[] = [];
  for (let i = 0; i < codeLines.length; i++) {
    if (!codeLines[i]?.includes("getDb()")) continue;
    // 文脈付与は同一文（複数行: `withTenantContext(` が getDb() の最大 2 行上）まで見る。判定もコメント除去後の行で。
    const start = Math.max(0, i - 2);
    const ctx = codeLines.slice(start, i + 1).join("\n");
    sites.push({ line: i + 1, contextualized: CONTEXTUALIZED_RE.test(ctx) });
  }
  return sites;
}

describe("SEC-009/SEC-014 構造監査: 生 getDb() はテナント文脈の扉からのみ使う", () => {
  const sourceFiles = collectSourceFiles(WEB_ROOT).filter(
    (f) => relative(WEB_ROOT, f).replaceAll("\\", "/") !== CHOKEPOINT_MODULE,
  );

  // 全ファイルの getDb() コードサイトを 1 度だけ収集する。
  const sitesByFile = sourceFiles.map((file) => ({
    rel: relative(WEB_ROOT, file).replaceAll("\\", "/"),
    sites: collectGetDbSites(readFileSync(file, "utf8")),
  }));
  const allSites = sitesByFile.flatMap((f) => f.sites);

  it("監査が空虚でない: 文脈付与済みの生 getDb() サイトを十分に検出している", () => {
    // グロブ崩れ / 正規表現破綻で 0 件監査になる空虚さを排除。現状 apps/web は ~14 サイト（lib/db.ts 除く）。
    const contextualized = allSites.filter((s) => s.contextualized);
    expect(contextualized.length).toBeGreaterThanOrEqual(12);
  });

  it("両カテゴリ（withTenantContext と RLS 扉）の実使用を確認 (allowlist が dead でない正の対比)", () => {
    // 「誰も getDb() を使っていないから通る」/「扉 allowlist が机上の空論」を排除する。
    const wrapped = sitesByFile.some((f) =>
      /withTenantContext\s*\(\s*getDb\(\)/.test(
        stripCommentsToLines(readFileSync(join(WEB_ROOT, f.rel), "utf8")).join("\n"),
      ),
    );
    expect(wrapped).toBe(true);
    // 少なくとも 1 つの扉関数が実際に getDb() を直接受けて使われている。
    const doorUsed = RLS_DOOR_FUNCTIONS.some((door) =>
      sitesByFile.some((f) =>
        new RegExp(`${door}\\s*\\(\\s*getDb\\(\\)`).test(
          stripCommentsToLines(readFileSync(join(WEB_ROOT, f.rel), "utf8")).join("\n"),
        ),
      ),
    );
    expect(doorUsed).toBe(true);
  });

  it("生 getDb() の使用は全て正規の扉（withTenantContext / allowlist 扉）経由である", () => {
    const violations: string[] = [];
    for (const { rel, sites } of sitesByFile) {
      for (const s of sites) {
        if (!s.contextualized) violations.push(`${rel}:${s.line}`);
      }
    }
    // 失敗時は「文脈をくぐらない生 getDb()」の場所を全部見せる（新規の漏れ経路を即特定）。
    expect(
      violations,
      `テナント文脈を経由しない生 getDb() 使用を検出（withTenantContext で包むか、` +
        `内部で文脈を確立する扉関数を RLS_DOOR_FUNCTIONS allowlist に明示追加すること）:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("検出器が機能する (自己テスト): 生 getDb() は違反、扉/ラッパ経由は許可", () => {
    // 生使用 → 違反（文脈未付与）。
    const raw = collectGetDbSites("const rows = await getDb().select().from(schedules);\n");
    expect(raw).toHaveLength(1);
    expect(raw[0]?.contextualized).toBe(false);

    // withTenantContext（同一行）→ 許可。
    expect(
      collectGetDbSites("await withTenantContext(getDb(), ctx, (tx) => q(tx));")[0]?.contextualized,
    ).toBe(true);
    // withTenantContext（複数行: 呼び出しが getDb() の上）→ 許可。
    const multi = collectGetDbSites("await withTenantContext(\n  getDb(),\n  ctx,\n);");
    expect(multi.find((s) => s.line === 2)?.contextualized).toBe(true);
    // allowlist の扉 → 許可。
    expect(
      collectGetDbSites("const r = await resolveMagicLink(getDb(), hash);")[0]?.contextualized,
    ).toBe(true);
    expect(
      collectGetDbSites("await recordPresenceEvent(getDb(), normalized);")[0]?.contextualized,
    ).toBe(true);

    // 非 allowlist 関数に渡す生使用 → 違反（新しい扉は allowlist 追記を強制）。
    const sneaky = collectGetDbSites("await someNewHelper(getDb(), x);");
    expect(sneaky[0]?.contextualized).toBe(false);

    // コメント/ docstring 中の getDb() 言及はコードと誤認しない（false positive 防止）。
    expect(collectGetDbSites("// withTenantContext(getDb()) を使うこと")).toHaveLength(0);
    expect(collectGetDbSites("/**\n * `getDb()` は非 BYPASSRLS 接続。\n */")).toHaveLength(0);
  });
});
