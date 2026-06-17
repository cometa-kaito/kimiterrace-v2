import { describe, expect, it } from "vitest";
import { isPgErrorCode, pgErrorCode } from "../../lib/pg-error";

/**
 * pg-error: Drizzle が wrap した PostgreSQL エラーの SQLSTATE 抽出（apps/web 共通）。
 *
 * 回帰の要: 本番では Drizzle が PostgresError を DrizzleQueryError で包み SQLSTATE を `.cause.code` へ
 * 移す。top-level の code だけを見る旧実装はこれを取りこぼし全画面 500 を招いた（#1019）。ここでは
 * **本番同形（cause.code に SQLSTATE）** を中心に、複数段 wrap・非該当・非エラーまで網羅する。
 */

/** 本番同形: DrizzleQueryError は自身に code を持たず、cause(PostgresError) に SQLSTATE が乗る。 */
function drizzleWrapped(code: string): unknown {
  return Object.assign(new Error("Failed query: insert into ..."), {
    cause: Object.assign(new Error("duplicate key value"), { code }),
  });
}

describe("pgErrorCode", () => {
  it("top-level に code がある素の pg エラーから取り出す", () => {
    expect(pgErrorCode(Object.assign(new Error("x"), { code: "23505" }))).toBe("23505");
  });

  it("Drizzle wrap（cause.code に SQLSTATE）から取り出す（本番同形・回帰の要）", () => {
    expect(pgErrorCode(drizzleWrapped("23505"))).toBe("23505");
    expect(pgErrorCode(drizzleWrapped("23514"))).toBe("23514");
    expect(pgErrorCode(drizzleWrapped("23503"))).toBe("23503");
  });

  it("複数段 wrap（cause.cause.code）でも 5 段まで辿る", () => {
    const nested = Object.assign(new Error("outer"), {
      cause: Object.assign(new Error("mid"), {
        cause: Object.assign(new Error("inner"), { code: "23505" }),
      }),
    });
    expect(pgErrorCode(nested)).toBe("23505");
  });

  it("code が無い / 非エラー / null は undefined", () => {
    expect(pgErrorCode(new Error("no code"))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode(undefined)).toBeUndefined();
    expect(pgErrorCode("string")).toBeUndefined();
    expect(pgErrorCode({ cause: { cause: {} } })).toBeUndefined();
  });
});

describe("isPgErrorCode", () => {
  it("指定した SQLSTATE 集合に一致すれば true（wrap 済も含む）", () => {
    expect(isPgErrorCode(drizzleWrapped("23505"), "23505")).toBe(true);
    expect(isPgErrorCode(drizzleWrapped("23514"), "23505", "23514")).toBe(true);
    expect(isPgErrorCode(drizzleWrapped("23503"), "23505", "23514", "23503")).toBe(true);
  });

  it("集合に無い code は false（取りこぼさず正しく除外）", () => {
    expect(isPgErrorCode(drizzleWrapped("23503"), "23505")).toBe(false);
    expect(isPgErrorCode(drizzleWrapped("40001"), "23505", "23514")).toBe(false);
    expect(isPgErrorCode(new Error("no code"), "23505")).toBe(false);
    expect(isPgErrorCode(null, "23505")).toBe(false);
  });
});
