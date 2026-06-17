/**
 * PostgreSQL の SQLSTATE 判定ユーティリティ（apps/web 共通の単一ソース）。
 *
 * **なぜ cause 連鎖を辿るか**: Drizzle は postgres ドライバの `PostgresError` を `DrizzleQueryError`
 * （"Failed query: …"）でラップし、元の SQLSTATE を top-level の `.code` から `.cause.code` へ移す。
 * さらに複数段ラップされうるため、`error.code` だけを見る判定は UNIQUE(23505) / CHECK(23514) /
 * FK(23503) を取りこぼす。取りこぼすと Server Action が制約違反を「想定外の例外」として再 throw し、
 * ルートエラー境界（apps/web/app/error.tsx）の全画面 500 になる（本番 digest 2578603502 = 学科重複登録,
 * #1019）。Route Handler では恒久エラー（→409）を一時エラー（→5xx）と誤判定し無限再送を招く。
 *
 * provisioning-actions.ts(pgCode) / schools-actions.ts(pgErrorCode) に重複していた抽出ロジックを
 * 1 か所へ集約した（[[ref_drizzle_wraps_pg_error_cause_sqlstate]]）。各サーフェスが握る SQLSTATE 集合
 * （23505 のみ / +23514 / +23503 等）は呼出側が `isPgErrorCode` の引数で明示する。
 */

/** cause 連鎖を最大 5 段辿り、最初に見つかった文字列の `code`（SQLSTATE）を返す。無ければ undefined。 */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * （Drizzle が wrap しうる）エラーの SQLSTATE が `codes` のいずれかに一致するかを返す。
 * 例: `isPgErrorCode(error, "23505")`（unique のみ） / `isPgErrorCode(error, "23505", "23514", "23503")`。
 */
export function isPgErrorCode(error: unknown, ...codes: string[]): boolean {
  const code = pgErrorCode(error);
  return code !== undefined && codes.includes(code);
}
