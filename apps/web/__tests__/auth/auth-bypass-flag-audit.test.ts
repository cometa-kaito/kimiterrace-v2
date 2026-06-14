import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC-002 / S-01: 認証バイパスフラグ残存の敵対監査 (Part of #243、トラック③ `docs/testing/tracks/03-security-pentest.md`)。
 *
 * 脅威: テスト用の認証バイパスフラグ (`NEXT_PUBLIC_AUTH_BYPASS=true` 等) が本番/staging ビルドに
 * 残存し、フラグ指定で認証を素通りされる (S-01 なりすまし / 全データ越境の入口)。
 *
 * このスイートは **3 層**で「フラグが存在せず、立てても効かない」ことを能動的に固定する:
 *
 * 1. **静的ソース監査 (grep 監査)**: apps/web の**本番ソース** (テスト/e2e を除く) に認証バイパスの
 *    識別子 (`AUTH_BYPASS` / `bypassAuth` 等) が**そもそも存在しない**ことを断言する。
 *    期待表 SEC-002 は「dead-code elimination 済」(= フラグは在るがビルドで除去) を求めるが、
 *    本監査は**より強い性質**を固定する: フラグを読むコードが**ソースに無い** → 除去すべき dead-code
 *    自体が無い → バンドルにも入りようがない。将来の不用意な追加 (回帰) を file:line で検出する。
 * 2. **構造不変条件**: サーバ側の認証判定モジュール (`session.ts` / `guard.ts` / `adminApp.ts`) は
 *    クライアント公開 env (`NEXT_PUBLIC_*` = **クライアントバンドルにインライン展開され攻撃者が観測/改竄可能**)
 *    を**一切参照しない**。認証判定が公開フラグに依存する穴を塞ぐ。正の対比として、Firebase クライアント
 *    SDK 設定 (`clientApp.ts`) は公開 config なので `NEXT_PUBLIC_` を**使ってよい** (境界の明示)。
 * 3. **ランタイム不活性 (「フラグ指定でも 401」)**: 想定しうるバイパス env を**実際に立てた状態**で
 *    実 `getCurrentUser` / `verifySessionCookie` / `requireUser` を駆動し、deny-by-default が**不変**
 *    (cookie 無し→null、改竄 cookie→null、未認証→/login redirect) であることを示す。正の対比として
 *    有効 cookie では成功する (= ハーネスが空虚に deny しているのではないことの担保)。
 *
 * 範囲正直: **staging の実 JS バンドル / 実 env を grep する DAST 相当は staging 必須** (このトラックの
 * §7 / Entry ゲート)。ローカルで証明できるのは「ソース不在 + 構造不変 + ランタイム不活性」であり、
 * ソース不在はバンドル残存に対し strictly stronger (ソースに無ければバンドルにも出ない)。実 IdP/実 cookie
 * の暗号検証委譲は firebase-admin SDK (E2E は #48-O Playwright + emulator)。
 */

// ───────────────────────── Layer 1 & 2: 静的ソース監査 (mock 不要、fs で実ソースを読む) ─────────────────────────

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 監査対象から除外するディレクトリ (テスト・e2e・生成物・依存)。 */
const EXCLUDED_DIRS = new Set(["__tests__", "e2e", "node_modules", ".next", "coverage", "dist"]);

/** 走査対象の本番ソース拡張子。 */
const SOURCE_EXT = /\.(ts|tsx)$/;

/** テスト/型宣言ファイルは本番ビルドに含まれないため監査対象外。 */
function isTestFile(name: string): boolean {
  return /\.(test|spec)\.(ts|tsx)$/.test(name) || name.endsWith(".d.ts");
}

/** `root` 配下の本番ソース (.ts/.tsx、テスト/e2e/生成物を除く) を再帰収集する。 */
function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry)) {
          walk(full);
        }
      } else if (SOURCE_EXT.test(entry) && !isTestFile(entry)) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

/**
 * 認証バイパスを示す**識別子**パターン (env 変数名 = UPPER_SNAKE / 関数・変数名 = camelCase)。
 * 散文中の "skip auth" 等を誤検出しないよう、空白を含まない識別子境界 (`\b`) でのみ一致させる。
 */
const BYPASS_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /\bAUTH_BYPASS\b/i, label: "AUTH_BYPASS" },
  { re: /\bBYPASS_AUTH\b/i, label: "BYPASS_AUTH" },
  { re: /\bSKIP_AUTH\b/i, label: "SKIP_AUTH" },
  { re: /\bAUTH_SKIP\b/i, label: "AUTH_SKIP" },
  { re: /\bDISABLE_AUTH\b/i, label: "DISABLE_AUTH" },
  { re: /\bAUTH_DISABLED?\b/i, label: "AUTH_DISABLE(D)" },
  { re: /\bNO_?AUTH\b/i, label: "NO_AUTH / NOAUTH" },
  { re: /\bINSECURE_AUTH\b/i, label: "INSECURE_AUTH" },
  { re: /\bALLOW_INSECURE\b/i, label: "ALLOW_INSECURE" },
  { re: /\bDEV_?BYPASS\b/i, label: "DEV_BYPASS / DEVBYPASS" },
  { re: /\bbypassAuth\b/, label: "bypassAuth" },
  { re: /\bskipAuth\b/, label: "skipAuth" },
  { re: /\bdisableAuth\b/, label: "disableAuth" },
  { re: /\bfakeLogin\b/i, label: "fakeLogin" },
  { re: /\bforceLogin\b/i, label: "forceLogin" },
  // クライアント公開 env が bypass/skip/disable 動詞を伴う形 (NEXT_PUBLIC_*BYPASS* 等)。
  {
    re: /\bNEXT_PUBLIC_[A-Z0-9_]*(?:BYPASS|SKIP|DISABLE|INSECURE|NOAUTH)[A-Z0-9_]*\b/,
    label: "NEXT_PUBLIC_*<BYPASS|SKIP|DISABLE|INSECURE|NOAUTH>*",
  },
];

describe("SEC-002 静的監査: 認証バイパス識別子が本番ソースに存在しない", () => {
  const sourceFiles = collectSourceFiles(WEB_ROOT);

  it("監査対象の本番ソースを実際に収集できている (vacuous 防止: 0 件なら監査は無意味)", () => {
    // lib/ や app/ を含む十分な本番ソースが集まっていること。0 件 = グロブ崩れで監査が空虚化する。
    expect(sourceFiles.length).toBeGreaterThan(50);
    // 認証コア (session.ts / guard.ts / middleware.ts) が確かに走査対象に入っている。
    const rels = sourceFiles.map((f) => relative(WEB_ROOT, f).replaceAll("\\", "/"));
    expect(rels).toContain("lib/auth/session.ts");
    expect(rels).toContain("lib/auth/guard.ts");
    expect(rels).toContain("middleware.ts");
  });

  it("いずれの本番ソースにも認証バイパス識別子が無い (回帰時は file:line で報告)", () => {
    const hits: string[] = [];
    for (const file of sourceFiles) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const { re, label } of BYPASS_PATTERNS) {
          if (re.test(line)) {
            const rel = relative(WEB_ROOT, file).replaceAll("\\", "/");
            hits.push(`${rel}:${i + 1} [${label}] ${line.trim()}`);
          }
        }
      });
    }
    // 失敗時は検出箇所を全部見せる (どのフラグがどこに入ったか即特定できるように)。
    expect(hits, `認証バイパス識別子を検出:\n${hits.join("\n")}`).toEqual([]);
  });

  it("検出器そのものが機能する (正の対比: バイパス識別子を含む文字列は捕捉される)", () => {
    const labelsFor = (s: string) =>
      BYPASS_PATTERNS.filter((p) => p.re.test(s)).map((p) => p.label);

    // SEC-002 の名指し例 `NEXT_PUBLIC_AUTH_BYPASS`。`_` は単語文字ゆえ標準の `\bAUTH_BYPASS\b` は
    // 接頭辞付きには一致しない (= クライアント公開 env 専用パターンが捕捉する分担)。両者で穴を残さない。
    const clientFlag = 'if (process.env.NEXT_PUBLIC_AUTH_BYPASS === "true") return fakeLogin();';
    const clientMatched = labelsFor(clientFlag);
    expect(clientMatched).toContain("NEXT_PUBLIC_*<BYPASS|SKIP|DISABLE|INSECURE|NOAUTH>*");
    expect(clientMatched).toContain("fakeLogin");

    // 接頭辞無しのサーバ env は標準パターンが捕捉する。
    expect(labelsFor('const skip = process.env.AUTH_BYPASS === "1";')).toContain("AUTH_BYPASS");
    expect(labelsFor("return skipAuth ? user : null;")).toContain("skipAuth");

    // 逆に、正当な行は捕捉しない (誤検出しないことの対比)。
    const legit = 'secure: process.env.NODE_ENV === "production",';
    expect(labelsFor(legit)).toEqual([]);
    const firebaseConfig = "authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,";
    expect(labelsFor(firebaseConfig)).toEqual([]);
    const emulator = "!!process.env.FIREBASE_AUTH_EMULATOR_HOST;";
    expect(labelsFor(emulator)).toEqual([]);
  });
});

describe("SEC-002 構造不変: サーバ認証モジュールはクライアント公開 env を参照しない", () => {
  /** 認証判定を担うサーバ専用モジュール (クライアントへ配布されない)。 */
  const SERVER_AUTH_MODULES = ["lib/auth/session.ts", "lib/auth/guard.ts", "lib/auth/adminApp.ts"];

  it.each(
    SERVER_AUTH_MODULES,
  )("%s は NEXT_PUBLIC_ env を参照しない (公開フラグで認証判定を曲げられない)", (rel) => {
    const src = readFileSync(join(WEB_ROOT, rel), "utf8");
    // NEXT_PUBLIC_ はクライアントバンドルにインライン展開され攻撃者が観測/改竄できる。
    // サーバ認証判定がこれに依存すると、公開フラグ 1 つで認証を曲げる穴になる。
    expect(src).not.toMatch(/NEXT_PUBLIC_/);
  });

  it("正の対比: Firebase クライアント SDK 設定 (clientApp.ts) は公開 config なので NEXT_PUBLIC_ を使う", () => {
    // 「NEXT_PUBLIC_ をどこも使っていないから通る」空虚さを排除する。境界は
    // 「クライアント config は公開 env を使う / サーバ認証判定は使わない」であり、前者の実在を固定する。
    const clientApp = readFileSync(join(WEB_ROOT, "lib/auth/clientApp.ts"), "utf8");
    expect(clientApp).toMatch(/process\.env\.NEXT_PUBLIC_FIREBASE_/);
  });
});

// ───────────────────────── Layer 3: ランタイム不活性 (実 auth コードを駆動、SDK/headers のみ mock) ─────────────────────────

const VALID_UID = "11111111-1111-4111-8111-111111111111";
const VALID_SCHOOL = "22222222-2222-4222-8222-222222222222";

// firebase-admin の検証 (実 cookie 暗号検証は SDK 委譲、ここでは spy で挙動を差し替える、session.test.ts と同型)。
const verifySessionCookieSpy = vi.fn();
vi.mock("../../lib/auth/adminApp", () => ({
  getAdminAuth: () => ({
    verifySessionCookie: verifySessionCookieSpy,
    createSessionCookie: vi.fn(),
  }),
}));

// next/headers の cookies() をテストから制御。
const cookieValue = { current: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "__session" && cookieValue.current !== undefined
        ? { value: cookieValue.current }
        : undefined,
  }),
}));

// requireUser の未認証 deny は redirect("/login") で表現される。throw 化して観測する。
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

import { redirect } from "next/navigation";
import { requireUser } from "../../lib/auth/guard";
import { getCurrentUser, verifySessionCookie } from "../../lib/auth/session";

const redirectMock = vi.mocked(redirect);

/** 攻撃者が「効くかも」と立てる典型的なバイパス env 一式 (公開/非公開・各種命名)。 */
const BYPASS_ENVS: readonly [string, string][] = [
  ["NEXT_PUBLIC_AUTH_BYPASS", "true"],
  ["AUTH_BYPASS", "1"],
  ["SKIP_AUTH", "true"],
  ["DISABLE_AUTH", "1"],
  ["NEXT_PUBLIC_DISABLE_AUTH", "true"],
  ["E2E_BYPASS_AUTH", "true"],
  ["NODE_ENV", "development"],
];

describe("SEC-002 能動: バイパス env を立てても認証は deny を維持する (フラグ指定でも 401)", () => {
  beforeEach(() => {
    verifySessionCookieSpy.mockReset();
    redirectMock.mockClear();
    cookieValue.current = undefined;
    for (const [k, v] of BYPASS_ENVS) {
      vi.stubEnv(k, v);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("cookie 無し → getCurrentUser は null (バイパス env はユーザーを生成しない)", async () => {
    cookieValue.current = undefined;
    await expect(getCurrentUser()).resolves.toBeNull();
    // SDK にすら問い合わせない (cookie が無い)。フラグで近道は開かない。
    expect(verifySessionCookieSpy).not.toHaveBeenCalled();
  });

  it("改竄/無効 cookie (SDK が throw) → verifySessionCookie は null (フラグで検証を飛ばさない)", async () => {
    verifySessionCookieSpy.mockRejectedValue(new Error("auth/argument-error"));
    await expect(verifySessionCookie("forged.jwt.token")).resolves.toBeNull();
    // バイパス env が立っていても、実 SDK 検証は必ず走る (= 飛ばす近道が無い)。
    expect(verifySessionCookieSpy).toHaveBeenCalledWith("forged.jwt.token", true);
  });

  it("未認証で requireUser → /login へ redirect (deny-by-default、フラグ無関係)", async () => {
    cookieValue.current = undefined;
    await expect(requireUser("/app/contents")).rejects.toThrow("REDIRECT:/login");
    expect(redirectMock).toHaveBeenCalledWith("/login?next=%2Fapp%2Fcontents");
  });

  it("正の対比: 有効 cookie なら成功する (deny が空虚でないことの担保)", async () => {
    cookieValue.current = "valid-session-cookie";
    verifySessionCookieSpy.mockResolvedValue({
      uid: VALID_UID,
      role: "teacher",
      school_id: VALID_SCHOOL,
    });
    // バイパス env が立った同条件下で、正規 cookie はちゃんと通る。
    await expect(getCurrentUser()).resolves.toEqual({
      uid: VALID_UID,
      role: "teacher",
      schoolId: VALID_SCHOOL,
    });
    await expect(requireUser()).resolves.toMatchObject({ uid: VALID_UID, role: "teacher" });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
