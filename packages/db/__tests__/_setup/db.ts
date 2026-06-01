import postgres from "postgres";

/**
 * テスト用 DB 接続ユーティリティ。
 *
 * - DATABASE_URL が未設定なら null を返す。各 test ファイルは null を見て skip する。
 * - RLS テストでは「RLS をバイパスしない接続」が必要。CI / dev とも postgres スーパーユーザーで
 *   接続するが、`SET ROLE NONE` ではなく `RESET ROLE` でロール影響を消し、テスト中に
 *   `SET LOCAL ROLE kimiterrace_app` でアプリ視点に切り替える。
 */
export function getConnectionUrl(): string | null {
  if (process.env.RLS_TESTS_SKIP === "1") return null;
  return process.env.DATABASE_URL ?? null;
}

export function createSql(url: string): ReturnType<typeof postgres> {
  return postgres(url, { max: 4, onnotice: () => {} });
}

/**
 * セッションコンテキストを設定するヘルパー。
 *
 * `SET LOCAL` を使うため必ずトランザクション内で呼ぶこと。
 */
export type RlsContext = {
  schoolId?: string | null;
  role?: "system_admin" | "school_admin" | "teacher" | "student" | "guardian" | null;
  userId?: string | null;
};

/**
 * 共通テスト fixture: 2 校 + system_admin を投入。
 *
 * BYPASSRLS なロール (postgres スーパーユーザー) で実行する想定。
 */
export type SeededFixture = {
  schoolA: string;
  schoolB: string;
  userA: string;
  userB: string;
  sysAdmin: string;
};

export async function seedBaseFixture(sql: ReturnType<typeof postgres>): Promise<SeededFixture> {
  // RLS 全テーブル truncate (RESTART IDENTITY CASCADE)
  // audit_log は RLS + TRUNCATE トリガで弾かれるため、ALTER で一時的に無効化する
  await sql.unsafe("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate;");
  await sql.unsafe("ALTER TABLE audit_log DISABLE TRIGGER audit_log_hash_chain;");
  try {
    await sql.unsafe(`
      TRUNCATE
        audit_log,
        teacher_input_attachments, teacher_inputs,
        ai_chat_messages, ai_chat_sessions, ai_extractions, ai_rate_limit_windows,
        events, publishes, content_versions, contents,
        ads, daily_data, school_configs, departments, grades,
        magic_links, memberships, classes, users,
        monthly_reports,
        feedback,
        communications, contracts, advertisers,
        system_admins,
        schools
      RESTART IDENTITY CASCADE;
    `);
  } finally {
    await sql.unsafe("ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_truncate;");
    await sql.unsafe("ALTER TABLE audit_log ENABLE TRIGGER audit_log_hash_chain;");
  }

  const [a] = await sql<{ id: string }[]>`
    INSERT INTO schools (name, prefecture, code)
    VALUES ('テスト高校 A', '岐阜県', 'A001')
    RETURNING id
  `;
  const [b] = await sql<{ id: string }[]>`
    INSERT INTO schools (name, prefecture, code)
    VALUES ('テスト高校 B', '岐阜県', 'B002')
    RETURNING id
  `;
  const [uA] = await sql<{ id: string }[]>`
    INSERT INTO users (school_id, identity_uid, role, display_name)
    VALUES (${a.id}, 'uid-A', 'school_admin', '管理者 A')
    RETURNING id
  `;
  const [uB] = await sql<{ id: string }[]>`
    INSERT INTO users (school_id, identity_uid, role, display_name)
    VALUES (${b.id}, 'uid-B', 'school_admin', '管理者 B')
    RETURNING id
  `;
  const [sa] = await sql<{ id: string }[]>`
    INSERT INTO system_admins (identity_uid, display_name, email)
    VALUES ('uid-sys', 'システム管理者', 'sysadmin@example.com')
    RETURNING id
  `;
  return { schoolA: a.id, schoolB: b.id, userA: uA.id, userB: uB.id, sysAdmin: sa.id };
}
