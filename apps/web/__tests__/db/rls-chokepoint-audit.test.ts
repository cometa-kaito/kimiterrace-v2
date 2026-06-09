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
 * - `claimNextProvisioningJob` / `reportProvisioningStatus`: C方式 TV プロビジョニングのエージェント API
 *   （セッション無し、PR4）。内部で **system_admin role 文脈**（withTenantContext）を張り BYPASSRLS 不使用
 *   （pollTvConfig と同型）。claim は最古 pending を FOR UPDATE SKIP LOCKED、status 報告は `claimed_by`
 *   一致必須で状態詐称防止。専用シークレット検証は route 側（provision-agent-secret.ts、TV_POLL とは別鍵）。
 * - `isTeacherLoginEnabled` / `listTeacherLoginSchools`: 教員「学校共通パスワード」ログイン（ADR-032）の
 *   公開（セッション無し）学校解決。内部で **system_admin role 文脈**（withTenantContext）を張り
 *   BYPASSRLS 不使用（pollTvConfig と同型）。読み取りは学校 id/名のみで秘密は返さない。総当たり抑止は
 *   route 側（失敗のみ計上の IP レート制限 + CSRF）。
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
  "claimNextProvisioningJob",
  "reportProvisioningStatus",
  "isTeacherLoginEnabled",
  "listTeacherLoginSchools",
] as const;

/** `getDb()` を第 1 引数に直接渡してよい呼び出し元（正規ラッパ + RLS の扉）。 */
const ALLOWED_CALLERS: ReadonlySet<string> = new Set<string>([
  "withTenantContext",
  ...RLS_DOOR_FUNCTIONS,
]);

/**
 * `<関数名>( getDb()` の形から呼び出し元の関数名を捕捉する**リテラル**正規表現（複数行・空白許容）。
 * 文字列補間で `new RegExp` を組まない（Semgrep non-literal-regexp 回避 + 呼び出し元を精密に同定）。
 */
const CALLER_OF_GETDB = /([A-Za-z_$][\w$]*)\s*\(\s*getDb\(\)/g;

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
 * 行コメント `//` とブロックコメント `/* *​/`（JSDoc 含む）をコード面から除去した行配列を返す（位置保存）。
 * docstring 中の `getDb()` / `withTenantContext(getDb())` 等の言及をコードと誤認しないため。文字列リテラル内
 * `//` は対象外（getDb 呼び出し行に URL 文字列が同居しない前提、万一の取りこぼしは false-negative 方向で稀・許容）。
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

/** ある getDb() を内包する文（現在行 + 直前 1 行）から呼び出し元関数名を返す（生使用は null）。 */
function callerOfGetDb(windowText: string): string | null {
  let caller: string | null = null;
  // 末尾側（= 現在行）の getDb() に最も近い呼び出し元を採る。
  for (const m of windowText.matchAll(CALLER_OF_GETDB)) {
    caller = m[1] ?? null;
  }
  return caller;
}

/** コード面（コメント除去後）の `getDb()` 使用箇所を {行番号, 呼び出し元} で返す。 */
function collectGetDbSites(content: string): { line: number; caller: string | null }[] {
  const codeLines = stripCommentsToLines(content);
  const sites: { line: number; caller: string | null }[] = [];
  for (let i = 0; i < codeLines.length; i++) {
    if (!codeLines[i]?.includes("getDb()")) continue;
    // 複数行呼び出し（`withTenantContext(` が getDb() の 1 行上）も拾うため直前 1 行まで含める。
    const windowText = codeLines.slice(Math.max(0, i - 1), i + 1).join("\n");
    sites.push({ line: i + 1, caller: callerOfGetDb(windowText) });
  }
  return sites;
}

function isContextualized(caller: string | null): boolean {
  return caller !== null && ALLOWED_CALLERS.has(caller);
}

describe("SEC-009/SEC-014 構造監査: 生 getDb() はテナント文脈の扉からのみ使う", () => {
  const sitesByFile = collectSourceFiles(WEB_ROOT)
    .map((file) => ({ rel: relative(WEB_ROOT, file).replaceAll("\\", "/"), file }))
    .filter((f) => f.rel !== CHOKEPOINT_MODULE)
    .map((f) => ({ rel: f.rel, sites: collectGetDbSites(readFileSync(f.file, "utf8")) }));
  const allSites = sitesByFile.flatMap((f) => f.sites);

  it("監査が空虚でない: 文脈付与済みの生 getDb() サイトを十分に検出している", () => {
    // グロブ崩れ / 正規表現破綻で 0 件監査になる空虚さを排除。現状 apps/web は ~16 サイト（lib/db.ts 除く）。
    const contextualized = allSites.filter((s) => isContextualized(s.caller));
    expect(contextualized.length).toBeGreaterThanOrEqual(12);
  });

  it("両カテゴリ（withTenantContext と RLS 扉）の実使用を確認 (allowlist が dead でない正の対比)", () => {
    // 「誰も getDb() を使っていないから通る」/「扉 allowlist が机上の空論」を排除する。
    const callers = new Set(allSites.map((s) => s.caller));
    expect(callers.has("withTenantContext")).toBe(true);
    // 少なくとも 1 つの扉関数が実際に getDb() を直接受けて使われている。
    expect(RLS_DOOR_FUNCTIONS.some((door) => callers.has(door))).toBe(true);
  });

  it("生 getDb() の使用は全て正規の扉（withTenantContext / allowlist 扉）経由である", () => {
    const violations: string[] = [];
    for (const { rel, sites } of sitesByFile) {
      for (const s of sites) {
        if (!isContextualized(s.caller)) {
          violations.push(`${rel}:${s.line}${s.caller ? ` (caller: ${s.caller})` : " (生使用)"}`);
        }
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
    const callerAt = (src: string, lineNo: number) =>
      collectGetDbSites(src).find((s) => s.line === lineNo)?.caller ?? null;

    // 生使用 → 呼び出し元なし（null）→ 違反。
    expect(callerAt("const rows = await getDb().select().from(schedules);", 1)).toBeNull();
    expect(isContextualized(null)).toBe(false);

    // withTenantContext（同一行）→ 許可。
    expect(callerAt("await withTenantContext(getDb(), ctx, (tx) => q(tx));", 1)).toBe(
      "withTenantContext",
    );
    // withTenantContext（複数行: 呼び出しが getDb() の 1 行上）→ 許可。
    expect(callerAt("await withTenantContext(\n  getDb(),\n  ctx,\n);", 2)).toBe(
      "withTenantContext",
    );
    // allowlist の扉 → 許可。
    expect(callerAt("const r = await resolveMagicLink(getDb(), hash);", 1)).toBe(
      "resolveMagicLink",
    );
    expect(callerAt("await recordPresenceEvent(getDb(), normalized);", 1)).toBe(
      "recordPresenceEvent",
    );
    for (const door of RLS_DOOR_FUNCTIONS) {
      expect(ALLOWED_CALLERS.has(door)).toBe(true);
    }

    // 非 allowlist 関数に渡す生使用 → 違反（新しい扉は allowlist 追記を強制）。
    expect(callerAt("await someNewHelper(getDb(), x);", 1)).toBe("someNewHelper");
    expect(isContextualized("someNewHelper")).toBe(false);

    // コメント/ docstring 中の getDb() 言及はコードと誤認しない（false positive 防止）。
    expect(collectGetDbSites("// withTenantContext(getDb()) を使うこと")).toHaveLength(0);
    expect(collectGetDbSites("/**\n * `getDb()` は非 BYPASSRLS 接続。\n */")).toHaveLength(0);
  });
});
