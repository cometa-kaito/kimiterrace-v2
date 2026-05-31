import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient } from "@kimiterrace/db";
import { collectMigrationFiles, runMigrationFile } from "@kimiterrace/db/migrate-files";

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

// マイグレーションの列挙・適用は @kimiterrace/db/migrate-files の collectMigrationFiles /
// runMigrationFile に委譲する (vitest RLS テストと共有の単一ソース)。ここでハードコードしない
// = migration 追加時に e2e 側を編集する必要がなくなる (docs/parallel-lanes.md §4)。applyMigrations 参照。

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
  /**
   * SCHOOL1 の **school スコープ**日次データに入れる識別文字列 (#213 真の RLS ガード)。
   * `getEffectiveDailyData` の school スコープ分岐 (`eq(scope,'school')`) は **app 側に school_id
   * フィルタが無く RLS だけがテナント分離する**唯一の経路。よって別校 (SCHOOL2) の描画にこの文字列が
   * 出ないことは「RLS が効いている」ことの厳密な回帰ガードになる (superuser=RLS バイパス時のみ漏れる)。
   * class スコープ (SEED.NOTICE_TEXT 等) は app 側 `eq(classId,...)` でも分離されるため RLS 単独検証にならない。
   */
  SCHOOL_SCOPE_TEXT: "E2E-SCHOOL1-SCHOOLSCOPE-ONLY",
  /** SCHOOL1 の school_id。教員 session の custom claim `school_id` に載せ、RLS スコープを一致させる。 */
  SCHOOL_ID: "00000000-0000-4000-8000-000000000001",
  /**
   * SCHOOL1 の class_id (`seed()` が daily_data を入れるクラス)。完全 golden-path e2e
   * (#48-O 第 4 増分) で教員が `/admin/editor/{classId}` を開いて連絡を更新するため、固定 UUID を
   * spec から import できるよう公開する。教員の school_id = SCHOOL_ID と同一校なので RLS で編集可能。
   */
  CLASS_ID: "00000000-0000-4000-8000-000000000003",
  /**
   * 完全 golden-path 専用のクラス / トークン / 初期連絡 (#48-O 第 4 増分の test 分離)。
   * golden-path は連絡を**破壊的に UPDATE** するため、`signage.spec.ts` が読む共有クラス
   * (`CLASS_ID` / `KNOWN_TOKEN`) を使うと `fullyParallel` 実行順次第で signage 正常系が落ちうる
   * (PR #233 Reviewer Medium-1)。golden-path は **専用クラス**を編集・表示して相互干渉を断つ。
   * SCHOOL1 配下 (school_id=SCHOOL_ID) なので教員 (同一校) が RLS 下で編集可能。
   */
  GOLDEN_CLASS_ID: "00000000-0000-4000-8000-000000000031",
  GOLDEN_TOKEN: "e2e-golden-path-token",
  GOLDEN_INITIAL_NOTICE: "E2E-GOLDEN-INITIAL",
  /**
   * 認証 e2e (#48-O 第 3 増分) の教員ユーザー。`auth.setup.ts` が Auth emulator に
   * **localId = TEACHER_UID** でユーザーを作成し、custom claim `{role:"teacher", school_id: SCHOOL_ID}`
   * を付与する。
   *
   * **`uid` は localId (= ID トークンの `sub`) から来る、custom claim ではない**: firebase-admin の
   * `verifySessionCookie` が返す `decoded.uid` は常に Auth ユーザーの localId であり、`uid` という名の
   * custom claim は予約衝突で上書きされる (実験で確認)。本番も Identity Platform ユーザーの localId に
   * DB の users.id (UUID) を採る運用なので、e2e でも **localId = TEACHER_UID (UUID)** にして本番と揃える。
   * これで session.ts の `normalizeClaims` が `decoded.uid` を UUID として受理し、`withSession`→RLS が
   * 教員の所属校 (SCHOOL_ID) にスコープされる。
   * - `TEACHER_UID`: Auth localId = ID トークン sub = users.id = users.identity_uid。UUID 必須。
   * - email / password: テスト専用の明白値 (実 credential ではない、CLAUDE.md ルール5)。
   */
  TEACHER_UID: "00000000-0000-4000-8000-000000000021",
  TEACHER_EMAIL: "teacher.e2e@example.com",
  TEACHER_PASSWORD: "e2e-teacher-password",
} as const;

/**
 * 認証済み教員の storageState 保存先 (#48-O 第 3 増分)。`auth.setup.ts` が書き、
 * `admin-auth.spec.ts` が `storageState` で読む。**定数のみここに置く**理由: `auth.setup.ts`
 * は読み込むと `setup(...)` (= test) を登録するため、spec から import すると chromium project に
 * setup テストが混入する。副作用の無い本モジュールに定数を置き両者が参照することで混入を防ぐ。
 * .gitignore 済 (emulator トークン由来の __session を含む)。
 */
export const TEACHER_STORAGE_STATE = "e2e/.auth/teacher.json";

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
    await seedGoldenClass(sql);
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

/**
 * 完全 golden-path 専用クラスを SCHOOL1 配下に seed する (#48-O 第 4 増分 / PR #233 Reviewer Medium-1)。
 * golden-path は連絡を破壊的 UPDATE するため `signage.spec.ts` の共有クラスと干渉しないよう専用化する。
 * 教員 (school_id=SCHOOL_ID) が編集できるよう SCHOOL1 / 既存 grade 配下に作る。初期連絡を 1 件入れて
 * NoticeEditor に編集対象の入力欄が出るようにする (golden-path がこれを一意文字列へ置換する)。
 */
async function seedGoldenClass(sql: RawSql): Promise<void> {
  const schoolId = SEED.SCHOOL_ID;
  const gradeId = "00000000-0000-4000-8000-000000000002"; // seed() の SCHOOL1 1年 grade
  const classId = SEED.GOLDEN_CLASS_ID;
  const magicLinkId = "00000000-0000-4000-8000-000000000032";
  const dailyId = "00000000-0000-4000-8000-000000000033";

  const tokenHash = hashToken(SEED.GOLDEN_TOKEN);
  const today = jstToday();
  const notices = JSON.stringify([{ text: SEED.GOLDEN_INITIAL_NOTICE }]);

  await sql.unsafe(
    `INSERT INTO classes (id, school_id, grade_id, academic_year, name, grade)
     VALUES ('${classId}', '${schoolId}', '${gradeId}', 2026, '2組', 1)
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

/**
 * 適用順の真実ソースは `@kimiterrace/db/migrate-files` の `collectMigrationFiles`
 * (vitest RLS テストの globalSetup と共有)。drizzle/ → migrations/ をファイル名昇順で**全件**適用する
 * (旧実装は subset をハードコードしていたが、prod スキーマと完全一致させる)。CI Postgres は新品なので
 * `DROP SCHEMA` は不要。superuser (postgres) で適用する。
 */
async function applyMigrations(sql: RawSql): Promise<void> {
  // 拡張 (pgvector + pgcrypto)。
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

  for (const file of collectMigrationFiles(dbPackageRoot)) {
    await runMigrationFile(sql, file);
  }
}

/**
 * golden-path 用の最小データを seed する。superuser 接続なので RLS をバイパスして直接 INSERT。
 * すべて固定 UUID で冪等にし、再実行 (CI のリトライや reuseExistingServer) でも衝突しないよう
 * ON CONFLICT DO NOTHING にする。監査カラム created_by/updated_by はシステム作成として NULL。
 */
async function seed(sql: RawSql): Promise<void> {
  const schoolId = SEED.SCHOOL_ID;
  const gradeId = "00000000-0000-4000-8000-000000000002";
  const classId = SEED.CLASS_ID;
  const magicLinkId = "00000000-0000-4000-8000-000000000004";
  const dailyId = "00000000-0000-4000-8000-000000000005";
  const schoolScopeDailyId = "00000000-0000-4000-8000-000000000006";

  const tokenHash = hashToken(SEED.KNOWN_TOKEN);
  const today = jstToday();

  // 描画で itemLabel (title/label/text/subject/name/content の順) が拾える形にする。
  // notices: {text}, assignments: {subject,...}, schedules: {subject,period}。
  const schedules = JSON.stringify([{ period: 1, subject: SEED.SCHEDULE_TEXT }]);
  const notices = JSON.stringify([{ text: SEED.NOTICE_TEXT }]);
  const assignments = JSON.stringify([
    { deadline: today, subject: SEED.ASSIGNMENT_TEXT, task: "p.10-12" },
  ]);
  // SCHOOL1 の school スコープ行 (class_id NULL)。RLS 単独で分離される経路の漏れ検知用 (#213)。
  const schoolScopeSchedules = JSON.stringify([{ period: 1, subject: SEED.SCHOOL_SCOPE_TEXT }]);

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

  // 認証 e2e (#48-O 第 3 増分) の教員ユーザー。id = identity_uid = Auth emulator の localId =
  // ID トークン sub = TEACHER_UID (UUID) で一意に揃える (auth.setup.ts が同じ localId で作成)。
  // 監査カラム created_by/updated_by はシステム作成として NULL。RLS スコープは school_id=SCHOOL1。
  await sql.unsafe(
    `INSERT INTO users (id, school_id, identity_uid, role, display_name, email, is_active)
     VALUES ('${SEED.TEACHER_UID}', '${schoolId}', '${SEED.TEACHER_UID}',
             'teacher', 'E2E 教員', '${SEED.TEACHER_EMAIL}', true)
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

  // 当日の **school スコープ**日次データ (class_id/grade_id/department_id NULL = ck_daily_data_scope OK)。
  // app 側に school_id フィルタが無い `eq(scope,'school')` 経路に乗るため、別校描画に漏れたら RLS 不全。
  // SCHOOL2 は schedules を持たない (seedSchool2 は notices のみ) ので、漏れた場合 SCHOOL2 の時間割欄に
  // SCHOOL_SCOPE_TEXT が出る → negative テストで検知できる。
  await sql.unsafe(
    `INSERT INTO daily_data (id, school_id, scope, date, schedules)
     VALUES ('${schoolScopeDailyId}', '${schoolId}', 'school', '${today}', '${schoolScopeSchedules}'::jsonb)
     ON CONFLICT (id) DO NOTHING;`,
  );
}

// 旧 runSqlFile / splitSqlStatements は @kimiterrace/db/migrate-files の runMigrationFile に統合した
// (真実ソースの手動コピーを廃止 = 同期負債を解消、docs/parallel-lanes.md §4)。
