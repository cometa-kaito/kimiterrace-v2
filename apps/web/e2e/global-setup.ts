import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient } from "@kimiterrace/db";

/**
 * 生 SQL 適用に使う postgres-js クライアント型。`@kimiterrace/db` の `createDbClient` が返す
 * `sql` の型を流用する (web は `postgres` を直接 import しない = 余計な依存を増やさない)。
 */
type RawSql = ReturnType<typeof createDbClient>["sql"];

/**
 * Playwright globalSetup (F0 #48-O 第 2 増分: 公開サイネージ golden-path e2e)。
 *
 * Playwright は本 globalSetup を **webServer 起動前** に 1 度だけ実行する。ここで
 *   (a) 空の CI Postgres にマイグレーションを適用し、
 *   (b) 1 校 1 学年 1 クラス + 有効 magic link + 当日の daily_data を seed する。
 * これにより `signage.spec.ts` が実ブラウザで `/signage/{KNOWN_TOKEN}` を開いたとき、
 * #48-E/#48-G/#191 の token→RLS→階層マージ→描画の経路を **真の end-to-end** で検証できる。
 *
 * ⚠️ ─────────────────────────────────────────────────────────────────────────
 * ⚠️ 下記マイグレーション適用順序の **真実のソースは
 * ⚠️   packages/db/__tests__/_setup/global-setup.ts** (vitest RLS テストの DB 初期化)。
 * ⚠️ migration を追加したら **両方を更新する** こと (feedback_migration_loader_pattern と
 * ⚠️ 同じ規律: 片方だけ更新すると e2e だけ古い policy で走り CI が局所的に落ちる)。
 * ⚠️ ここでは e2e DB が毎回新品 (CI の Postgres service は使い捨て) である前提なので
 * ⚠️ `DROP SCHEMA public CASCADE` は省く (あっても害は無い)。superuser (postgres) で適用する。
 * ⚠️ ─────────────────────────────────────────────────────────────────────────
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/web/e2e → リポジトリルートの packages/db
const dbPackageRoot = join(__dirname, "..", "..", "..", "packages", "db");

// --- DDL (drizzle 生成、baseline → 0007 の順。上記の真実ソースと厳密一致させること) ---
const BASELINE_SQL = join(dbPackageRoot, "drizzle", "0000_initial_baseline.sql");
const F0A_SCHEMA_SQL = join(dbPackageRoot, "drizzle", "0001_f0a_hierarchy_tables.sql");
const F0F_COLS_SQL = join(dbPackageRoot, "drizzle", "0002_f0f_hierarchy_links.sql");
const F05_MAGIC_LINK_SQL = join(dbPackageRoot, "drizzle", "0003_f05_magic_link_class.sql");
const F02_SCHEMA_SQL = join(dbPackageRoot, "drizzle", "0004_f02_teacher_inputs.sql");
const F04_PUBLISH_UNIQUE_SQL = join(
  dbPackageRoot,
  "drizzle",
  "0005_content_versions_publishes_unique.sql",
);
const COMPOSITE_FK_SQL = join(dbPackageRoot, "drizzle", "0006_composite_fk_cross_tenant.sql");
const CONTENTS_COMPOSITE_FK_SQL = join(dbPackageRoot, "drizzle", "0007_contents_composite_fk.sql");

// --- RLS / audit / VIEW / SECURITY DEFINER 関数 (手書き migration、0001 → 0009 の順) ---
const RLS_ENABLE_SQL = join(dbPackageRoot, "migrations", "0001_enable_rls.sql");
const RLS_POLICIES_SQL = join(dbPackageRoot, "migrations", "0002_rls_policies.sql");
const AUDIT_TRIGGER_SQL = join(dbPackageRoot, "migrations", "0003_audit_trigger.sql");
const AUDIT_FK_SQL = join(dbPackageRoot, "migrations", "0004_audit_fk.sql");
const AUDIT_LOG_ACTOR_NULL_SQL = join(
  dbPackageRoot,
  "migrations",
  "0005_audit_log_actor_null_school_admin.sql",
);
const F0A_RLS_SQL = join(dbPackageRoot, "migrations", "0006_f0a_schema_rls.sql");
const EFFECTIVE_ADS_VIEW_SQL = join(dbPackageRoot, "migrations", "0007_effective_ads_view.sql");
const F05_RESOLVE_FN_SQL = join(dbPackageRoot, "migrations", "0008_f05_magic_link_resolve_fn.sql");
const F02_RLS_SQL = join(dbPackageRoot, "migrations", "0009_f02_schema_rls.sql");

/**
 * seed が使う既知の値。`signage.spec.ts` から再利用するため fixtures として公開する。
 * - `KNOWN_TOKEN`: テスト専用の明白な平文定数 (実 credential ではない、CLAUDE.md ルール5)。
 *   DB には平文を保存せず `hashToken` で SHA-256 化した `token_hash` のみ入れる。
 * - `*_TEXT`: 描画検証で visible を確認する識別文字列 (他のラベルと衝突しない一意な値)。
 */
export const SEED = {
  KNOWN_TOKEN: "e2e-known-token",
  SCHEDULE_TEXT: "E2E-SCHEDULE-1限-数学",
  NOTICE_TEXT: "E2E-NOTICE-XYZ",
  ASSIGNMENT_TEXT: "E2E-ASSIGNMENT-数学ワーク",
} as const;

/**
 * 2 校目の seed (#213: RLS テナント分離を e2e で実証する negative 用)。別 school / class / token。
 * webServer を kimiterrace_app (非 BYPASSRLS) 接続にした上で、SCHOOL2 の token では SCHOOL2 の
 * 連絡だけが描画され SCHOOL1 の連絡 (`SEED.NOTICE_TEXT`) は出ない (= RLS で越境不可) ことを確認する。
 */
export const SEED2 = {
  KNOWN_TOKEN: "e2e-known-token-school2",
  NOTICE_TEXT: "E2E-NOTICE-SCHOOL2-ONLY",
} as const;

/**
 * アプリ (webServer) が e2e で接続する **非 BYPASSRLS** ロール (#213 / PR #210 Reviewer Medium-1)。
 * migrate / seed は superuser で行うが、描画経路は kimiterrace_app で動かして **RLS を実際に効かせる**。
 * superuser 接続のままだと RLS がバイパスされ「RLS を貫く end-to-end」が名ばかりになる。
 * kimiterrace_app は migration で NOLOGIN なので、CI の使い捨て DB に限り globalSetup で LOGIN を付与する。
 */
export const APP_DB_ROLE = "kimiterrace_app";

/**
 * superuser の DATABASE_URL から、接続ユーザーだけを kimiterrace_app に差し替えた URL を作る。
 * パスワードは同じ CI 値を流用する (新たな secret 文字列を増やさない、CLAUDE.md ルール5)。
 * placeholder (実 DB 無しのローカル) はそのまま返す (signage spec は skip される)。
 */
export function toAppDatabaseUrl(url: string | undefined): string | undefined {
  if (!isSignageDbAvailable(url)) {
    return url;
  }
  const parsed = new URL(url);
  parsed.username = APP_DB_ROLE;
  return parsed.toString();
}

/**
 * 平文トークンの SHA-256 hex。`apps/web/lib/magic-link/token.ts` の `hashToken` と
 * **同一方式** (sha256 / utf8 / hex)。ここでは globalSetup が Playwright の TS ローダ
 * (tsconfig paths 非解決) で走るため `@/` alias を避け、ハッシュ方式のみ最小に複製する。
 * 方式がズレると signage の `resolveMagicLink(hashToken(token))` と照合できず 410 になる。
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** JST (Asia/Tokyo) の YYYY-MM-DD。daily_data.date を端末/CI の TZ に依存せず今日に揃える。 */
function jstToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

/**
 * 実 DB として扱える URL かどうか。未設定 / 明らかな placeholder (signage spec を skip させる
 * `/login` のみのローカル実行) では migrate + seed をスキップする。CI は実 URL を渡すので走る。
 * `signage.spec.ts` 側も同じ判定で `test.skip` するため、ここでスキップしても golden-path は
 * 落ちず /login スモークだけが実行される (`isSignageDbAvailable` を単一ソースとして共有)。
 */
export function isSignageDbAvailable(url: string | undefined): url is string {
  return !!url && !url.includes("placeholder");
}

export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!isSignageDbAvailable(url)) {
    console.warn(
      "[e2e] DATABASE_URL が未設定/placeholder のため signage golden-path の migrate+seed を" +
        " スキップします (/login スモークのみ実行)。CI / ローカル PG では実 URL を渡してください。",
    );
    return;
  }

  // superuser (postgres) 接続。DDL / RLS / SECURITY DEFINER 関数の適用と seed の直接 INSERT を行う。
  // seed は BYPASSRLS で入れるが、audit_log への cross-table トリガは無い (audit_log 自身の
  // append-only/hash chain のみ) ので他テーブルへの直接 INSERT は RLS/audit を踏まない。
  const { sql } = createDbClient(url);
  try {
    await applyMigrations(sql);
    await seed(sql);
    await seedSchool2(sql);
    // 描画経路を RLS 下で走らせるため、webServer 用の kimiterrace_app に LOGIN を付与する (#213)。
    await enableAppRoleLogin(sql, url);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * kimiterrace_app (migration で NOLOGIN) に LOGIN + パスワードを付与する。**CI の使い捨て DB 限定**。
 * パスワードは superuser URL のものを流用 (新規 secret を増やさない)。これにより webServer は
 * `toAppDatabaseUrl(...)` で非 BYPASSRLS 接続でき、signage の描画経路が実際に RLS を通る。
 */
async function enableAppRoleLogin(sql: RawSql, url: string): Promise<void> {
  const password = new URL(url).password || "postgres";
  const escaped = password.replace(/'/g, "''");
  await sql.unsafe(`ALTER ROLE ${APP_DB_ROLE} WITH LOGIN PASSWORD '${escaped}';`);
}

/**
 * 2 校目 (SEED2) を最小 seed する。RLS テナント分離の negative 用に、SCHOOL1 とは別 school_id の
 * クラス + 有効 magic link + 当日 daily_data (連絡のみ) を入れる。superuser 接続で直接 INSERT。
 */
async function seedSchool2(sql: RawSql): Promise<void> {
  const schoolId = "00000000-0000-4000-8000-000000000011";
  const gradeId = "00000000-0000-4000-8000-000000000012";
  const classId = "00000000-0000-4000-8000-000000000013";
  const magicLinkId = "00000000-0000-4000-8000-000000000014";
  const dailyId = "00000000-0000-4000-8000-000000000015";

  const tokenHash = hashToken(SEED2.KNOWN_TOKEN);
  const today = jstToday();
  const notices = JSON.stringify([{ text: SEED2.NOTICE_TEXT }]);

  await sql.unsafe(
    `INSERT INTO schools (id, name, prefecture)
     VALUES ('${schoolId}', 'E2E高校2', '岐阜県')
     ON CONFLICT (id) DO NOTHING;`,
  );
  await sql.unsafe(
    `INSERT INTO grades (id, school_id, name, display_order, has_classes)
     VALUES ('${gradeId}', '${schoolId}', '1年', 0, true)
     ON CONFLICT (id) DO NOTHING;`,
  );
  await sql.unsafe(
    `INSERT INTO classes (id, school_id, grade_id, academic_year, name, grade)
     VALUES ('${classId}', '${schoolId}', '${gradeId}', 2026, '1組', 1)
     ON CONFLICT (id) DO NOTHING;`,
  );
  await sql.unsafe(
    `INSERT INTO magic_links (id, school_id, class_id, token_hash)
     VALUES ('${magicLinkId}', '${schoolId}', '${classId}', '${tokenHash}')
     ON CONFLICT (id) DO NOTHING;`,
  );
  await sql.unsafe(
    `INSERT INTO daily_data (id, school_id, scope, class_id, date, notices)
     VALUES ('${dailyId}', '${schoolId}', 'class', '${classId}', '${today}', '${notices}'::jsonb)
     ON CONFLICT (id) DO NOTHING;`,
  );
}

/** 真実ソース (packages/db/__tests__/_setup/global-setup.ts) と厳密一致させた適用順序。 */
async function applyMigrations(sql: RawSql): Promise<void> {
  // 拡張 (pgvector + pgcrypto)。CI Postgres は新品なので DROP SCHEMA は不要。
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

  // DDL
  await runSqlFile(sql, BASELINE_SQL);
  await runSqlFile(sql, F0A_SCHEMA_SQL);
  await runSqlFile(sql, F0F_COLS_SQL);
  await runSqlFile(sql, F05_MAGIC_LINK_SQL);
  await runSqlFile(sql, F02_SCHEMA_SQL);
  await runSqlFile(sql, F04_PUBLISH_UNIQUE_SQL);
  await runSqlFile(sql, COMPOSITE_FK_SQL);
  await runSqlFile(sql, CONTENTS_COMPOSITE_FK_SQL);

  // RLS + audit + 階層 policy
  await runSqlFile(sql, RLS_ENABLE_SQL);
  await runSqlFile(sql, RLS_POLICIES_SQL);
  await runSqlFile(sql, AUDIT_TRIGGER_SQL);
  await runSqlFile(sql, AUDIT_FK_SQL);
  await runSqlFile(sql, AUDIT_LOG_ACTOR_NULL_SQL);
  await runSqlFile(sql, F0A_RLS_SQL);
  await runSqlFile(sql, F02_RLS_SQL);

  // 広告階層マージ VIEW
  await runSqlFile(sql, EFFECTIVE_ADS_VIEW_SQL);

  // magic link 匿名解決の SECURITY DEFINER 関数
  await runSqlFile(sql, F05_RESOLVE_FN_SQL);
}

/**
 * golden-path 用の最小データを seed する。superuser 接続なので RLS をバイパスして直接 INSERT。
 * すべて固定 UUID で冪等にし、再実行 (CI のリトライや reuseExistingServer) でも衝突しないよう
 * ON CONFLICT DO NOTHING にする。監査カラム created_by/updated_by はシステム作成として NULL。
 */
async function seed(sql: RawSql): Promise<void> {
  const schoolId = "00000000-0000-4000-8000-000000000001";
  const gradeId = "00000000-0000-4000-8000-000000000002";
  const classId = "00000000-0000-4000-8000-000000000003";
  const magicLinkId = "00000000-0000-4000-8000-000000000004";
  const dailyId = "00000000-0000-4000-8000-000000000005";

  const tokenHash = hashToken(SEED.KNOWN_TOKEN);
  const today = jstToday();

  // 描画で itemLabel (title/label/text/subject/name/content の順) が拾える形にする。
  // notices: {text}, assignments: {subject,...}, schedules: {subject,period}。
  const schedules = JSON.stringify([{ period: 1, subject: SEED.SCHEDULE_TEXT }]);
  const notices = JSON.stringify([{ text: SEED.NOTICE_TEXT }]);
  const assignments = JSON.stringify([
    { deadline: today, subject: SEED.ASSIGNMENT_TEXT, task: "p.10-12" },
  ]);

  await sql.unsafe(
    `INSERT INTO schools (id, name, prefecture)
     VALUES ('${schoolId}', 'E2E高校', '岐阜県')
     ON CONFLICT (id) DO NOTHING;`,
  );

  await sql.unsafe(
    `INSERT INTO grades (id, school_id, name, display_order, has_classes)
     VALUES ('${gradeId}', '${schoolId}', '1年', 0, true)
     ON CONFLICT (id) DO NOTHING;`,
  );

  await sql.unsafe(
    `INSERT INTO classes (id, school_id, grade_id, academic_year, name, grade)
     VALUES ('${classId}', '${schoolId}', '${gradeId}', 2026, '1組', 1)
     ON CONFLICT (id) DO NOTHING;`,
  );

  // magic link: 有効 (revoked_at NULL、expires_at は DB デフォルト now()+90日)。
  // resolve_magic_link は class_id IS NOT NULL かつ未失効・未期限の 1 行を返す。
  await sql.unsafe(
    `INSERT INTO magic_links (id, school_id, class_id, token_hash)
     VALUES ('${magicLinkId}', '${schoolId}', '${classId}', '${tokenHash}')
     ON CONFLICT (id) DO NOTHING;`,
  );

  // 当日のクラススコープ日次データ。scope='class' は ck_daily_data_scope を満たす (class_id NOT NULL)。
  await sql.unsafe(
    `INSERT INTO daily_data
       (id, school_id, scope, class_id, date, schedules, notices, assignments)
     VALUES
       ('${dailyId}', '${schoolId}', 'class', '${classId}', '${today}',
        '${schedules}'::jsonb, '${notices}'::jsonb, '${assignments}'::jsonb)
     ON CONFLICT (id) DO NOTHING;`,
  );
}

/**
 * SQL ファイルを適用する。真実ソース (packages/db/__tests__/_setup/global-setup.ts) の
 * `runSqlFile` / `splitSqlStatements` ロジックを踏襲する (drizzle の statement-breakpoint
 * 分割、関数本体 `$$...$$` と文字列の保護)。両者を一致させ適用挙動を揃える。
 */
async function runSqlFile(sql: RawSql, path: string): Promise<void> {
  const raw = readFileSync(path, "utf-8");
  if (raw.includes("--> statement-breakpoint")) {
    for (const stmt of raw.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) {
        await sql.unsafe(trimmed);
      }
    }
  } else {
    for (const stmt of splitSqlStatements(raw)) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) {
        await sql.unsafe(trimmed);
      }
    }
  }
}

/**
 * `;` で SQL を分割するが、`$$ ... $$` (PL/pgSQL 関数本体) や `'...'` リテラル中の `;` は無視する。
 * `--` 行コメントは (文字列/関数本体の外なら) 行末まで読み飛ばす。真実ソースと同一実装。
 */
function splitSqlStatements(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let inDollar = false;
  let inSingle = false;
  while (i < input.length) {
    const ch = input[i];
    const next2 = input.slice(i, i + 2);

    if (!inDollar && !inSingle && next2 === "--") {
      const nl = input.indexOf("\n", i);
      if (nl === -1) {
        i = input.length;
      } else {
        buf += "\n";
        i = nl + 1;
      }
      continue;
    }

    if (!inSingle && next2 === "$$") {
      inDollar = !inDollar;
      buf += next2;
      i += 2;
      continue;
    }

    if (!inDollar && ch === "'") {
      if (inSingle && input[i + 1] === "'") {
        buf += "''";
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      buf += ch;
      i += 1;
      continue;
    }

    if (!inDollar && !inSingle && ch === ";") {
      out.push(buf);
      buf = "";
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  if (buf.trim().length > 0) {
    out.push(buf);
  }
  return out;
}
