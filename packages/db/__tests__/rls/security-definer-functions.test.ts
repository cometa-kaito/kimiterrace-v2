import { afterAll, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * E-02 / SEC-025: SECURITY DEFINER 関数の監査（敵対的セキュリティテスト）
 *
 * SECURITY DEFINER 関数は所有者権限で走り RLS をバイパスできる「RLS をくぐる唯一の扉」。
 * 誤用すると tenant 越境 SELECT を生む（ADR-019 §代替E が却下した形）。本スイートは
 * threat-model E-02（SEC-025）の防御を敵対的・監査的に検証する:
 *
 *   1. prosecdef=true（SECURITY DEFINER）のアプリ定義関数が許可リスト 2 本のみであること
 *      = 将来誰かが安易に SECURITY DEFINER 関数を足したら CI が落ちて検知する（回帰防止）。
 *   2. 各関数が search_path を固定していること
 *      = SECURITY DEFINER + 可変 search_path は、呼び出し側が search_path を攻撃者スキーマへ
 *        張ることで関数本体の `public.magic_links` 等の解決を乗っ取れる（CVE 級の昇格経路）。
 *   3. 各関数が PUBLIC から EXECUTE を剥がし kimiterrace_app にのみ付与（最小権限）。
 *   4. resolve_magic_link が最小列のみ返し token_hash / 監査列を漏らさないこと。
 *   5. submit_feedback（INSERT 扉）を実際に呼び、同じ匿名 app ロールが書いた行すら
 *      読み戻せないこと（SELECT 面を一切開けない＝越境読取に悪用不能）を能動的に攻めて確認。
 *
 * resolve_magic_link 側の解決（有効/失効/不正 token）の機能カバレッジは既存
 * magic-links.test.ts に委ね、本スイートは SECURITY DEFINER という RLS バイパス機構
 * **そのもの**の網羅監査に集中する（二重化しない）。メタ監査（1-4）は seed 不要・truncate
 * しない＝並行 RLS テストの DB 状態を汚さない。#5 は sentinel rollback で INSERT を隔離する。
 *
 * 拡張（pgvector 等）が public に入れる関数は pg_depend(deptype='e') で除外し、
 * アプリが定義した SECURITY DEFINER 関数のみを監査対象にする。
 */

// 許可された SECURITY DEFINER 関数。これ以外が現れたら設計レビュー必須（ADR-019）。
const ALLOWED_SECURITY_DEFINER = ["resolve_magic_link", "submit_feedback"] as const;

describeOrSkip("RLS / SECURITY DEFINER 監査 (E-02 / SEC-025)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("public スキーマのアプリ定義 SECURITY DEFINER 関数は許可リストのみ（想定外の追加を検知）", async () => {
    const rows = await sql<{ proname: string }[]>`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef = true
        AND n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
        )
      ORDER BY p.proname
    `;
    const names = rows.map((r) => r.proname);
    // 完全一致: 許可リスト以外の SECURITY DEFINER 関数が増えたら fail
    // = RLS バイパス機構の無断追加を阻止する。新たに必要なら本リスト + ADR で明示すること。
    expect(names).toEqual([...ALLOWED_SECURITY_DEFINER]);
  });

  it("各 SECURITY DEFINER 関数は search_path を固定している（search_path 乗っ取り耐性）", async () => {
    const rows = await sql<{ proname: string; proconfig: string[] | null }[]>`
      SELECT p.proname, p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef = true
        AND n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
        )
    `;
    expect(rows.length).toBe(ALLOWED_SECURITY_DEFINER.length);
    for (const r of rows) {
      // proconfig は ["search_path="] の形（SET search_path = '' は空値で格納される）。
      const hasSearchPath = (r.proconfig ?? []).some((c) => c.startsWith("search_path="));
      expect(hasSearchPath, `${r.proname} に search_path 固定がない`).toBe(true);
    }
  });

  it("各 SECURITY DEFINER 関数は PUBLIC から EXECUTE 剥奪・kimiterrace_app のみ実行可（最小権限）", async () => {
    const rows = await sql<{ proname: string; oid: string }[]>`
      SELECT p.proname, p.oid::text AS oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef = true
        AND n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
        )
    `;
    expect(rows.length).toBe(ALLOWED_SECURITY_DEFINER.length);
    for (const r of rows) {
      const [priv] = await sql<{ pub: boolean; app: boolean }[]>`
        SELECT
          has_function_privilege('public', ${r.oid}::oid, 'EXECUTE') AS pub,
          has_function_privilege('kimiterrace_app', ${r.oid}::oid, 'EXECUTE') AS app
      `;
      expect(priv.pub, `${r.proname} が PUBLIC に EXECUTE を開けている`).toBe(false);
      expect(priv.app, `${r.proname} を kimiterrace_app が実行できない`).toBe(true);
    }
  });

  it("resolve_magic_link は最小列（id/school_id/class_id）のみ返し token_hash/監査列を漏らさない", async () => {
    const [row] = await sql<{ result: string }[]>`
      SELECT pg_get_function_result(p.oid) AS result
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'resolve_magic_link' AND n.nspname = 'public'
    `;
    const result = row.result;
    expect(result).toContain("school_id");
    expect(result).toContain("class_id");
    // 漏らしてはいけない列（token 平文ハッシュ・監査・期限）を戻り定義に含めない。
    expect(result).not.toContain("token_hash");
    expect(result).not.toContain("created_by");
    expect(result).not.toContain("expires_at");
  });

  it("敵対: submit_feedback (SECURITY DEFINER) は INSERT できても、書いた行を同じ匿名 app ロールで読み戻せない (扉は SELECT 面を開けない)", async () => {
    let insertedId: string | null = null;
    let readbackCount = -1;
    // sentinel error で rollback し、INSERT 行を永続化しない (並行 RLS テストを汚さない)。
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        // テナント context も system_admin role も無い匿名 app ロールが、RLS をくぐる唯一の扉
        // submit_feedback で 1 行 INSERT する (school_id=NULL で FK 不要、自己申告 schoolName のみ)。
        const [ins] = await tx<{ new_id: string }[]>`
          SELECT submit_feedback('SD監査校', NULL::uuid, '1-A', 3, 4, NULL, NULL) AS new_id
        `;
        insertedId = ins.new_id;
        // 同じ匿名 app ロールで、今 INSERT した行すら読み戻せない。SELECT 面は system_admin_only の
        // まま = SECURITY DEFINER INSERT 扉は SELECT 経路を一切開けていない (越境読取に悪用不能)。
        const readback = await tx<{ id: string }[]>`
          SELECT id FROM public.feedback WHERE id = ${ins.new_id}
        `;
        readbackCount = readback.length;
        throw new Error("__sd_audit_rollback__");
      }),
    ).rejects.toThrow("__sd_audit_rollback__");
    // INSERT 扉は機能した (uuid が返る) が、SELECT 面は閉じている (読み戻し 0 行)。
    expect(insertedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(readbackCount).toBe(0);
  });
});
