import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getMonthlyAdvertiserReport } from "../../src/queries/advertiser-report.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F09 (#45): 広告主アカウント単位の月次レポート集計 `getMonthlyAdvertiserReport` を実 PG (RLS 込み) で検証する。
 *
 * 集計経路: `advertisers ⟶ contracts ⟶ contract_contents ⟶ contents ⟶ events` を JST 暦月で
 * view/tap/ask に分けて event 単位で重複排除集計する。検証ポリシー (CLAUDE.md ルール2 / 非 vacuous):
 *  (1) 広告主ごとに 1 行・view/tap/ask を type 別に正しく数える、
 *  (2) 広告主スコープ: A 社の event を B 社へ誤帰属しない (契約紐付けに基づく帰属)、
 *  (3) 重複排除: 同一コンテンツが同一広告主の複数契約に紐づいても event を二重計上しない、
 *  (4) JST 暦月窓: 前月・翌月・JST 月境界の event は当月に含めない、
 *  (5) **テナント越境しない**: school をまたぐ広告主の event は全校横断で正しく合算される一方、
 *      非 system_admin context (school_admin/teacher/...) では CRM 表が 0 行で結果も空になる、
 *  (6) 反応 0 の広告主も会社名 + 0 件で 1 行残る (LEFT JOIN)、
 *  (7) ask は content_id を持つ event のみ帰属・content_id 無しの一般 ask は誤帰属しない、
 *  (8) 並びは total 降順 → 会社名昇順 → advertiserId 昇順で決定的、
 *  (9) 月範囲外 (0/13) は RangeError、
 * (10) **active_in_month スコープ** (#555): 件数の対象は status='active' かつ契約期間が対象月窓と重なる
 *      契約のみ。draft/paused/terminated や期間外 (前月終了 / 翌月開始) の契約に紐づく当月 event は計上せず、
 *      該当広告主も 0 件で 1 行残る (網羅性不変)。契約開始の翌月境界 (excluded) / 当月境界 (included) も pin。
 *
 * fixture は 2 校 (schoolA / schoolB) + system_admin。広告主・契約・出稿コンテンツ・event は各テストで
 * seed する。時刻は make_timestamptz で DB 側に絶対 JST 時刻を組み now() 非依存にする ([[pg-date-bind-enum-insert]] と
 * 同方針で Date を bind しない)。
 */
describeOrSkip("F09 getMonthlyAdvertiserReport (広告主別 月次集計、RLS system_admin)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const Y = 2026;
  const M = 3; // 対象月 = 2026 年 3 月 (JST)

  // system_admin context (schoolId 無し → tenantScoped 降格しない → system_admin_full_access が全校発火)。
  const sysCtx = () => ({ userId: fx.sysAdmin, role: "system_admin" as const });

  /** 広告主を 1 件作って id を返す (BYPASSRLS スーパーユーザーで直接投入)。 */
  async function seedAdvertiser(companyName: string): Promise<string> {
    const [row] = await raw<{ id: string }[]>`
      INSERT INTO advertisers (company_name, status, is_active)
      VALUES (${companyName}, 'active', true)
      RETURNING id
    `;
    return row.id;
  }

  /** {y,mo,d} を JST 00:00 の timestamptz SQL 片にする (Date を bind せず DB 側で絶対時刻を組む)。 */
  const jstTs = (t: { y: number; mo: number; d: number }) =>
    raw`make_timestamptz(${t.y}::int, ${t.mo}::int, ${t.d}::int, 0, 0, 0, 'Asia/Tokyo')`;

  /**
   * 広告主に契約を 1 件作って契約 id を返す。
   *
   * 既定は「対象月 (Y/M) にアクティブな契約」: `status='active'`・started_at = Y/01/01 JST (当月より前)・
   * ended_at = NULL (継続中)。これにより active_in_month フィルタ (#555) 導入後も既存テストの契約が
   * 当月にアクティブと判定される。status / 契約期間を上書きして、draft/paused/terminated や期間外
   * (前月終了 / 翌月開始) の契約も作れる。
   */
  async function seedContract(
    advertiserId: string,
    opts: {
      status?: "draft" | "active" | "paused" | "terminated";
      started?: { y: number; mo: number; d: number };
      ended?: { y: number; mo: number; d: number } | null;
    } = {},
  ): Promise<string> {
    const status = opts.status ?? "active";
    const started = opts.started ?? { y: Y, mo: 1, d: 1 };
    const endedExpr = opts.ended ? jstTs(opts.ended) : raw`NULL`;
    const [row] = await raw<{ id: string }[]>`
      INSERT INTO contracts (advertiser_id, status, started_at, ended_at, monthly_fee_jpy)
      VALUES (${advertiserId}, ${status}, ${jstTs(started)}, ${endedExpr}, 50000)
      RETURNING id
    `;
    return row.id;
  }

  /** 学校にコンテンツを 1 件作って id を返す。 */
  async function seedContent(schoolId: string, title: string): Promise<string> {
    const [row] = await raw<{ id: string }[]>`
      INSERT INTO contents (school_id, title, publish_scope, status)
      VALUES (${schoolId}, ${title}, 'school', 'published')
      RETURNING id
    `;
    return row.id;
  }

  /** 契約 ⇄ コンテンツの紐付け (出稿)。 */
  async function linkContractContent(contractId: string, contentId: string): Promise<void> {
    await raw`INSERT INTO contract_contents (contract_id, content_id) VALUES (${contractId}, ${contentId})`;
  }

  /**
   * 指定コンテンツ・学校に event を 1 件、特定 JST 暦時刻で投入する (月境界検証用に絶対時刻)。
   * contentId=null で content_id 無し event も作れる (一般 ask 等の誤帰属検証)。
   */
  async function seedEventAt(
    schoolId: string,
    contentId: string | null,
    type: "view" | "tap" | "ask" | "dwell",
    ts: { y: number; mo: number; d: number; h: number; mi: number },
  ): Promise<void> {
    await raw`
      INSERT INTO events (school_id, content_id, type, occurred_at, payload)
      VALUES (
        ${schoolId}, ${contentId}, ${type},
        make_timestamptz(${ts.y}::int, ${ts.mo}::int, ${ts.d}::int, ${ts.h}::int, ${ts.mi}::int, 0, 'Asia/Tokyo'),
        '{}'::jsonb
      )
    `;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    // 各テストを独立させるため CRM + event + content を毎回クリア (BYPASSRLS)。
    // contract_contents → contracts → advertisers の順 (FK)、events / contents も掃除。
    await raw`DELETE FROM events`;
    await raw`DELETE FROM contract_contents`;
    await raw`DELETE FROM contracts`;
    await raw`DELETE FROM advertisers`;
    await raw`DELETE FROM contents`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("広告主ごとに view/tap/ask を type 別に数え、total = 合計反応数になる", async () => {
    const adv = await seedAdvertiser("アクメ社");
    const con = await seedContract(adv);
    const content = await seedContent(fx.schoolA, "アクメ広告掲示");
    await linkContractContent(con, content);
    // view×2 / tap×1 / ask×1 を当月に投入 (別時刻なので distinct event は 4 件)。
    await seedEventAt(fx.schoolA, content, "view", { y: Y, mo: M, d: 5, h: 10, mi: 0 });
    await seedEventAt(fx.schoolA, content, "view", { y: Y, mo: M, d: 5, h: 11, mi: 0 });
    await seedEventAt(fx.schoolA, content, "tap", { y: Y, mo: M, d: 6, h: 9, mi: 0 });
    await seedEventAt(fx.schoolA, content, "ask", { y: Y, mo: M, d: 7, h: 9, mi: 0 });
    // dwell は集計対象外。
    await seedEventAt(fx.schoolA, content, "dwell", { y: Y, mo: M, d: 7, h: 9, mi: 5 });

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    expect(rows).toEqual([
      { advertiserId: adv, companyName: "アクメ社", views: 2, taps: 1, asks: 1, total: 4 },
    ]);
  });

  it("広告主スコープ: A 社のコンテンツ event は B 社に帰属しない (契約紐付けで帰属)", async () => {
    const advA = await seedAdvertiser("A 社");
    const advB = await seedAdvertiser("B 社");
    const conA = await seedContract(advA);
    const conB = await seedContract(advB);
    const contentA = await seedContent(fx.schoolA, "A 社の掲示");
    const contentB = await seedContent(fx.schoolA, "B 社の掲示");
    await linkContractContent(conA, contentA);
    await linkContractContent(conB, contentB);
    // A 社コンテンツに tap×2、B 社コンテンツに tap×1。
    await seedEventAt(fx.schoolA, contentA, "tap", { y: Y, mo: M, d: 10, h: 9, mi: 0 });
    await seedEventAt(fx.schoolA, contentA, "tap", { y: Y, mo: M, d: 10, h: 10, mi: 0 });
    await seedEventAt(fx.schoolA, contentB, "tap", { y: Y, mo: M, d: 10, h: 9, mi: 0 });

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    // total 降順 (A=2 > B=1)。それぞれ自社コンテンツ分のみ。
    expect(rows).toEqual([
      { advertiserId: advA, companyName: "A 社", views: 0, taps: 2, asks: 0, total: 2 },
      { advertiserId: advB, companyName: "B 社", views: 0, taps: 1, asks: 0, total: 1 },
    ]);
  });

  it("重複排除: 同一コンテンツが同一広告主の複数契約に紐づいても event を二重計上しない", async () => {
    const adv = await seedAdvertiser("重複社");
    const con1 = await seedContract(adv);
    const con2 = await seedContract(adv); // 同一広告主の 2 契約目
    const content = await seedContent(fx.schoolA, "両契約に出した掲示");
    // 同じコンテンツを両方の契約に紐づける (fan-out 源)。
    await linkContractContent(con1, content);
    await linkContractContent(con2, content);
    // tap×1 のみ。素朴 count(*) なら 2 契約で 2 になるが、distinct event なら 1。
    await seedEventAt(fx.schoolA, content, "tap", { y: Y, mo: M, d: 12, h: 9, mi: 0 });

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    expect(rows).toEqual([
      { advertiserId: adv, companyName: "重複社", views: 0, taps: 1, asks: 0, total: 1 },
    ]);
  });

  it("JST 暦月窓: 前月・翌月・JST 月境界外の event は当月に含めない", async () => {
    const adv = await seedAdvertiser("月境界社");
    const con = await seedContract(adv);
    const content = await seedContent(fx.schoolA, "月境界掲示");
    await linkContractContent(con, content);
    await seedEventAt(fx.schoolA, content, "tap", { y: Y, mo: M, d: 15, h: 9, mi: 0 }); // 当月 → 計上
    await seedEventAt(fx.schoolA, content, "tap", { y: Y, mo: 2, d: 28, h: 9, mi: 0 }); // 前月 → 除外
    await seedEventAt(fx.schoolA, content, "tap", { y: Y, mo: 4, d: 1, h: 0, mi: 0 }); // 翌月頭 JST → 除外
    // JST 03/31 23:59 は 3 月 (= UTC 03/31 14:59) → 計上、JST 04/01 00:00 は 4 月 → 除外 (UTC 境界で誤判定しない)。
    await seedEventAt(fx.schoolA, content, "view", { y: Y, mo: M, d: 31, h: 23, mi: 59 }); // 3 月末 JST → 計上

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    expect(rows).toEqual([
      { advertiserId: adv, companyName: "月境界社", views: 1, taps: 1, asks: 0, total: 2 },
    ]);
  });

  it("テナント越境して合算: 広告主の契約コンテンツが複数校にまたがっても全校分を合算する (system_admin)", async () => {
    const adv = await seedAdvertiser("全国社");
    const con = await seedContract(adv);
    // 同一広告主の出稿コンテンツが A 校と B 校に 1 件ずつ。
    const contentA = await seedContent(fx.schoolA, "A 校での出稿");
    const contentB = await seedContent(fx.schoolB, "B 校での出稿");
    await linkContractContent(con, contentA);
    await linkContractContent(con, contentB);
    await seedEventAt(fx.schoolA, contentA, "tap", { y: Y, mo: M, d: 8, h: 9, mi: 0 });
    await seedEventAt(fx.schoolB, contentB, "tap", { y: Y, mo: M, d: 8, h: 9, mi: 0 });

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    // system_admin は全校横断 → A 校 + B 校の tap 合計 2。
    expect(rows).toEqual([
      { advertiserId: adv, companyName: "全国社", views: 0, taps: 2, asks: 0, total: 2 },
    ]);
  });

  it("非 system_admin context (school_admin/teacher/...) では CRM 表が不可視で結果は空 (deny-by-default)", async () => {
    const adv = await seedAdvertiser("見えない社");
    const con = await seedContract(adv);
    const content = await seedContent(fx.schoolA, "見えない掲示");
    await linkContractContent(con, content);
    await seedEventAt(fx.schoolA, content, "tap", { y: Y, mo: M, d: 9, h: 9, mi: 0 });

    // 非空虚の裏取り: system_admin では 1 行・tap 1 が見える。
    const asSys = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    expect(asSys).toEqual([
      { advertiserId: adv, companyName: "見えない社", views: 0, taps: 1, asks: 0, total: 1 },
    ]);

    // 各非 system_admin role + 自校 schoolId では advertisers が RLS で 0 行 → 結果も空。
    for (const role of ["school_admin", "teacher", "student", "guardian"] as const) {
      const rows = await withTenantContext(
        db,
        { userId: fx.userA, schoolId: fx.schoolA, role },
        (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
        APP,
      );
      expect(rows, `role=${role}`).toEqual([]);
    }
  });

  it("空コンテキストは deny-by-default で空配列", async () => {
    const adv = await seedAdvertiser("孤立社");
    const con = await seedContract(adv);
    const content = await seedContent(fx.schoolA, "孤立掲示");
    await linkContractContent(con, content);
    await seedEventAt(fx.schoolA, content, "tap", { y: Y, mo: M, d: 9, h: 9, mi: 0 });

    const rows = await withTenantContext(
      db,
      {},
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    expect(rows).toEqual([]);
  });

  it("反応 0 の広告主も会社名 + 0 件で 1 行残る (LEFT JOIN・一覧の網羅性)", async () => {
    // 契約も出稿も無い広告主 + 契約はあるが当月反応 0 の広告主。
    const advNoContract = await seedAdvertiser("契約なし社");
    const advActive = await seedAdvertiser("反応あり社");
    const con = await seedContract(advActive);
    const content = await seedContent(fx.schoolA, "反応ありの掲示");
    await linkContractContent(con, content);
    await seedEventAt(fx.schoolA, content, "tap", { y: Y, mo: M, d: 9, h: 9, mi: 0 });

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    // total 降順 → 反応あり社 (1) が先、契約なし社 (0) が後。両方 1 行ずつ存在する。
    expect(rows).toEqual([
      { advertiserId: advActive, companyName: "反応あり社", views: 0, taps: 1, asks: 0, total: 1 },
      {
        advertiserId: advNoContract,
        companyName: "契約なし社",
        views: 0,
        taps: 0,
        asks: 0,
        total: 0,
      },
    ]);
  });

  it("ask は content_id を持つ event のみ帰属し、content_id 無しの一般 ask は誤帰属しない", async () => {
    const adv = await seedAdvertiser("Q&A社");
    const con = await seedContract(adv);
    const content = await seedContent(fx.schoolA, "Q&A対象掲示");
    await linkContractContent(con, content);
    // 掲示に紐づく ask×1 → 帰属。content_id 無しの一般 ask×2 → どの広告主にも join しない。
    await seedEventAt(fx.schoolA, content, "ask", { y: Y, mo: M, d: 14, h: 9, mi: 0 });
    await seedEventAt(fx.schoolA, null, "ask", { y: Y, mo: M, d: 14, h: 10, mi: 0 });
    await seedEventAt(fx.schoolA, null, "ask", { y: Y, mo: M, d: 14, h: 11, mi: 0 });

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    expect(rows).toEqual([
      { advertiserId: adv, companyName: "Q&A社", views: 0, taps: 0, asks: 1, total: 1 },
    ]);
  });

  it("並びは total 降順 → 会社名昇順 → advertiserId 昇順で決定的 (同点解決)", async () => {
    // 会社名で並びが決まるよう、total 同点の 2 社を用意する。
    const advZ = await seedAdvertiser("ゼータ社");
    const advA = await seedAdvertiser("アルファ社");
    const conZ = await seedContract(advZ);
    const conA = await seedContract(advA);
    const contentZ = await seedContent(fx.schoolA, "Z 掲示");
    const contentA = await seedContent(fx.schoolA, "A 掲示");
    await linkContractContent(conZ, contentZ);
    await linkContractContent(conA, contentA);
    // 両社とも tap×1 (total 同点) → 会社名昇順で「アルファ社」が先。
    await seedEventAt(fx.schoolA, contentZ, "tap", { y: Y, mo: M, d: 9, h: 9, mi: 0 });
    await seedEventAt(fx.schoolA, contentA, "tap", { y: Y, mo: M, d: 9, h: 9, mi: 0 });

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    expect(rows.map((r) => r.companyName)).toEqual(["アルファ社", "ゼータ社"]);
  });

  it("active_in_month: draft/paused/terminated 契約の event は計上せず active のみ計上 (該当広告主も 0 件で 1 行残る)", async () => {
    // 各 status の契約を持つ広告主を用意し、すべて当月にコンテンツ event を 1 件投入する。
    // active 以外 (draft/paused/terminated) は active_in_month でないため、当月 event があっても計上されない。
    const advActive = await seedAdvertiser("アクティブ社");
    const advDraft = await seedAdvertiser("下書き社");
    const advPaused = await seedAdvertiser("停止社");
    const advTerminated = await seedAdvertiser("終了社");
    const cases = [
      [advActive, "active", "アクティブ掲示"],
      [advDraft, "draft", "下書き掲示"],
      [advPaused, "paused", "停止掲示"],
      [advTerminated, "terminated", "終了掲示"],
    ] as const;
    for (const [adv, status, title] of cases) {
      const con = await seedContract(adv, { status });
      const content = await seedContent(fx.schoolA, title);
      await linkContractContent(con, content);
      await seedEventAt(fx.schoolA, content, "tap", { y: Y, mo: M, d: 10, h: 9, mi: 0 });
    }

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    // active 社のみ tap 1 (total 降順で先頭に確定)。非空虚の正の対比 = 同じ seed 経路でも active なら計上される。
    expect(rows[0]).toEqual({
      advertiserId: advActive,
      companyName: "アクティブ社",
      views: 0,
      taps: 1,
      asks: 0,
      total: 1,
    });
    // 残り 3 社は 0 件だが LEFT JOIN で 1 行ずつ残る (一覧の網羅性は不変)。会社名 collation 順に依存しないよう集合で検証。
    const rest = rows.slice(1);
    expect(rest).toHaveLength(3);
    expect(new Set(rest.map((r) => r.advertiserId))).toEqual(
      new Set([advDraft, advPaused, advTerminated]),
    );
    expect(rest.every((r) => r.views === 0 && r.taps === 0 && r.asks === 0 && r.total === 0)).toBe(
      true,
    );
  });

  it("active_in_month: 契約期間が対象月窓と重ならない (前月終了 / 翌月開始) 契約の event は計上しない", async () => {
    const advEndedBefore = await seedAdvertiser("先月終了社");
    const advStartsAfter = await seedAdvertiser("来月開始社");
    const advOngoing = await seedAdvertiser("継続中社");
    // 先月終了: 1/1 開始・2/28 終了 (対象月 3 月より前に終了) → 当月 event は計上外。
    const conEnded = await seedContract(advEndedBefore, {
      status: "active",
      started: { y: Y, mo: 1, d: 1 },
      ended: { y: Y, mo: 2, d: 28 },
    });
    // 来月開始: 4/5 開始 (対象月 3 月より後に開始) → 計上外。
    const conAfter = await seedContract(advStartsAfter, {
      status: "active",
      started: { y: Y, mo: 4, d: 5 },
    });
    // 継続中: 1/1 開始・終了なし → 対象月にアクティブ → 計上。
    const conOngoing = await seedContract(advOngoing, {
      status: "active",
      started: { y: Y, mo: 1, d: 1 },
    });
    const contentEnded = await seedContent(fx.schoolA, "先月終了の掲示");
    const contentAfter = await seedContent(fx.schoolA, "来月開始の掲示");
    const contentOngoing = await seedContent(fx.schoolA, "継続中の掲示");
    await linkContractContent(conEnded, contentEnded);
    await linkContractContent(conAfter, contentAfter);
    await linkContractContent(conOngoing, contentOngoing);
    // 3 社とも当月 (3/15) に view を 1 件ずつ。
    await seedEventAt(fx.schoolA, contentEnded, "view", { y: Y, mo: M, d: 15, h: 9, mi: 0 });
    await seedEventAt(fx.schoolA, contentAfter, "view", { y: Y, mo: M, d: 15, h: 9, mi: 0 });
    await seedEventAt(fx.schoolA, contentOngoing, "view", { y: Y, mo: M, d: 15, h: 9, mi: 0 });

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    // 継続中社のみ view 1。期間外 2 社は 0 件で 1 行ずつ残る。
    expect(rows[0]).toEqual({
      advertiserId: advOngoing,
      companyName: "継続中社",
      views: 1,
      taps: 0,
      asks: 0,
      total: 1,
    });
    const rest = rows.slice(1);
    expect(rest).toHaveLength(2);
    expect(new Set(rest.map((r) => r.advertiserId))).toEqual(
      new Set([advEndedBefore, advStartsAfter]),
    );
    expect(rest.every((r) => r.total === 0)).toBe(true);
  });

  it("active_in_month 境界: 契約開始が翌月境界ちょうど (4/1 00:00 JST) は対象外、当月境界ちょうど (3/1 00:00 JST) は対象", async () => {
    const advAtNextStart = await seedAdvertiser("翌月頭開始社");
    const advAtMonthStart = await seedAdvertiser("当月頭開始社");
    // 開始 = 翌月 1 日 00:00 JST ちょうど → started_at < nextMonthStart が偽 → 対象外 (半開区間の上端)。
    const conNext = await seedContract(advAtNextStart, {
      status: "active",
      started: { y: Y, mo: 4, d: 1 },
    });
    // 開始 = 当月 1 日 00:00 JST ちょうど・継続中 → 対象。
    const conNow = await seedContract(advAtMonthStart, {
      status: "active",
      started: { y: Y, mo: M, d: 1 },
    });
    const contentNext = await seedContent(fx.schoolA, "翌月頭開始の掲示");
    const contentNow = await seedContent(fx.schoolA, "当月頭開始の掲示");
    await linkContractContent(conNext, contentNext);
    await linkContractContent(conNow, contentNow);
    // どちらも当月 (3/2) に tap。
    await seedEventAt(fx.schoolA, contentNext, "tap", { y: Y, mo: M, d: 2, h: 9, mi: 0 });
    await seedEventAt(fx.schoolA, contentNow, "tap", { y: Y, mo: M, d: 2, h: 9, mi: 0 });

    const rows = await withTenantContext(
      db,
      sysCtx(),
      (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: M }),
      APP,
    );
    expect(rows[0]).toEqual({
      advertiserId: advAtMonthStart,
      companyName: "当月頭開始社",
      views: 0,
      taps: 1,
      asks: 0,
      total: 1,
    });
    expect(rows.slice(1)).toEqual([
      {
        advertiserId: advAtNextStart,
        companyName: "翌月頭開始社",
        views: 0,
        taps: 0,
        asks: 0,
        total: 0,
      },
    ]);
  });

  it("月が範囲外 (0 / 13) は RangeError で弾く (UI 入力検証)", async () => {
    await expect(
      withTenantContext(
        db,
        sysCtx(),
        (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: 0 }),
        APP,
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      withTenantContext(
        db,
        sysCtx(),
        (tx) => getMonthlyAdvertiserReport(tx, { year: Y, month: 13 }),
        APP,
      ),
    ).rejects.toThrow(RangeError);
  });
});
