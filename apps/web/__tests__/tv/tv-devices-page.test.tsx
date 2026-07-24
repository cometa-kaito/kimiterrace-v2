import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F15 §4.2 / F16 §5 (ADR-022/ADR-023, #494 Reviewer Low-2): TV デバイス一覧の「操作」列リンク出し分けを pin する。
 *
 * 一覧 (`/ops/tv-devices`) は `ADMIN_ROLES`（teacher 含む）が閲覧できる。操作列には:
 *  - **稼働履歴**（F16 §5、`/[id]/history`）: 閲覧専用ページで ADMIN_ROLES 全員に出す（teacher も到達可）。
 *  - **設定編集**（F15 §4.2、`/[id]/edit`）: `TV_CONFIG_EDIT_ROLES`（school_admin / system_admin）限定。
 *    teacher に出すと 403 に終わる死リンクになるため、**編集可ロールのときだけ**出す（死リンク防止）。
 * 操作列ヘッダ自体は履歴リンクが全員に出るため常に表示する。実体の認可は各ページの `requireRole` + RLS が
 * 担保するので、本テストは UX 層の出し分け（描画）だけを検証する。
 *
 * guard / db / `@kimiterrace/db` を mock し、`requireRole(ADMIN_ROLES)` で teacher も到達することを保ったまま
 * role を差し替えてリンクの有無を確認する。`isRoleAllowed` は純粋述語なので忠実な実装を差し込む
 * （副作用を持つ `requireRole` だけ vi.fn に置換、real `isRoleAllowed` は session.ts → next/headers を
 * 巻き込むため import しない）。
 */

vi.mock("../../lib/auth/guard", () => ({
  requireRole: vi.fn(),
  // real guard.ts の `isRoleAllowed` と等価な純粋述語（allowed.includes(role)）。
  isRoleAllowed: (role: string, allowed: readonly string[]) => allowed.includes(role),
}));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("@kimiterrace/db", () => ({ listTvDevices: vi.fn(), listSchools: vi.fn() }));

import { listSchools, listTvDevices } from "@kimiterrace/db";
import TvDevicesPage from "../../app/ops/tv-devices/page";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { ADMIN_ROLES } from "../../lib/nav";
import { TV_CONFIG_EDIT_ROLES } from "../../lib/tv/config-edit-core";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const listMock = vi.mocked(listTvDevices);
const listSchoolsMock = vi.mocked(listSchools);

const SCHOOL_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SCHOOL_B = "bbbbbbbb-0000-4000-8000-000000000002";

// 一覧 1 行ぶんの最小 fixture。label は編集リンクの aria-label に使われる。
const DEVICE = {
  id: "00000000-0000-0000-0000-000000000001",
  label: "1年A組",
  deviceId: "dev-abcdef",
  schoolId: SCHOOL_A,
  schoolName: "岐阜県立岐南工業高等学校",
  targetMac: "AA:BB:CC:DD:EE:FF",
  version: 3,
  lastSeenAt: null,
  monitoringEnabled: true,
};
const EDIT_LINK_NAME = "1年A組 の設定を編集";
const HISTORY_LINK_NAME = "1年A組 の稼働履歴を表示";

/** 学校セレクトの選択肢（listSchools の射影のうち本ページが使う分）。 */
const SCHOOLS = [
  { id: SCHOOL_A, name: "岐阜県立岐南工業高等学校", prefecture: "岐阜県" },
  { id: SCHOOL_B, name: "岐阜県立各務原高等学校", prefecture: "岐阜県" },
];

function arrangeRole(role: string) {
  requireRoleMock.mockResolvedValue({ uid: "u1", role, schoolId: "s1" } as never);
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn({}, { uid: "u1", role, schoolId: "s1" }))) as typeof withSession);
}

/** ページの props（Server Component が受ける searchParams Promise）。未指定 = 絞り込みなし。 */
function pageProps(search: Record<string, string | string[]> = {}) {
  return { searchParams: Promise.resolve(search) };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([DEVICE] as never);
  // 既定は複数校が見える閲覧者（system_admin 相当）= 学校列・学校セレクトが出る条件。
  listSchoolsMock.mockResolvedValue(SCHOOLS as never);
});

describe("TvDevicesPage 操作列リンクの role 出し分け", () => {
  it("一覧自体は ADMIN_ROLES（teacher 含む）で要求する", async () => {
    arrangeRole("teacher");
    await TvDevicesPage(pageProps());
    expect(requireRoleMock).toHaveBeenCalledWith(ADMIN_ROLES);
    // 死リンク回避の前提: teacher は編集可ロールに含まれない。
    expect(TV_CONFIG_EDIT_ROLES).not.toContain("teacher");
  });

  it("teacher には「履歴」リンクは出すが「編集」リンクは出さない（履歴は閲覧専用、編集は死リンク防止）", async () => {
    arrangeRole("teacher");
    render(await TvDevicesPage(pageProps()));
    // 行自体は見える（一覧は閲覧可）。
    expect(screen.getByText("1年A組")).toBeInTheDocument();
    // 稼働履歴は ADMIN_ROLES 全員に出る（行 PK の履歴ページ、F16 §5）。
    const history = screen.getByRole("link", { name: HISTORY_LINK_NAME });
    expect(history).toHaveAttribute("href", `/ops/tv-devices/${DEVICE.id}/history`);
    // 操作列ヘッダは履歴リンクのため常に出る。編集リンクだけが teacher には無い（死リンク防止）。
    expect(screen.getByText("操作")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: EDIT_LINK_NAME })).toBeNull();
  });

  it("school_admin には「編集」リンク（行 PK の編集ページ）と「履歴」リンクを出す", async () => {
    arrangeRole("school_admin");
    render(await TvDevicesPage(pageProps()));
    const link = screen.getByRole("link", { name: EDIT_LINK_NAME });
    expect(link).toHaveAttribute("href", `/ops/tv-devices/${DEVICE.id}/edit`);
    expect(screen.getByRole("link", { name: HISTORY_LINK_NAME })).toHaveAttribute(
      "href",
      `/ops/tv-devices/${DEVICE.id}/history`,
    );
    expect(screen.getByText("操作")).toBeInTheDocument();
  });

  it("system_admin にも「編集」リンクを出す", async () => {
    arrangeRole("system_admin");
    render(await TvDevicesPage(pageProps()));
    expect(screen.getByRole("link", { name: EDIT_LINK_NAME })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: HISTORY_LINK_NAME })).toBeInTheDocument();
  });
});

describe("TvDevicesPage 稼働ステータス絞り込み（?status=）", () => {
  // DEVICE は lastSeenAt:null → "never"。判定基準はリクエスト時刻なので相対時刻で online/down を作る。
  const DOWN = {
    ...DEVICE,
    id: "00000000-0000-0000-0000-000000000002",
    label: "応答なし組",
    deviceId: "dev-down",
    lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h 前 → down（>1h）
  };
  const ONLINE = {
    ...DEVICE,
    id: "00000000-0000-0000-0000-000000000003",
    label: "稼働中組",
    deviceId: "dev-online",
    lastSeenAt: new Date(), // 直近 → online（<=5min）
  };

  it("?status=down は応答なしの端末だけ表示する", async () => {
    arrangeRole("system_admin");
    listMock.mockResolvedValue([DEVICE, DOWN, ONLINE] as never);
    render(await TvDevicesPage(pageProps({ status: "down" })));
    expect(screen.getByText("応答なし組")).toBeInTheDocument();
    expect(screen.queryByText("稼働中組")).toBeNull();
    expect(screen.queryByText("1年A組")).toBeNull(); // never は対象外
  });

  it("status 未指定は全件表示する", async () => {
    arrangeRole("system_admin");
    listMock.mockResolvedValue([DEVICE, DOWN, ONLINE] as never);
    render(await TvDevicesPage(pageProps()));
    expect(screen.getByText("応答なし組")).toBeInTheDocument();
    expect(screen.getByText("稼働中組")).toBeInTheDocument();
    expect(screen.getByText("1年A組")).toBeInTheDocument();
  });

  it("不正な status は全件表示にフォールバックする（CWE-20 防御・URL 改竄耐性）", async () => {
    arrangeRole("system_admin");
    listMock.mockResolvedValue([DEVICE, DOWN, ONLINE] as never);
    render(await TvDevicesPage(pageProps({ status: "garbage" })));
    expect(screen.getByText("応答なし組")).toBeInTheDocument();
    expect(screen.getByText("稼働中組")).toBeInTheDocument();
    expect(screen.getByText("1年A組")).toBeInTheDocument();
  });
});

/**
 * 学校の次元（列 + `?school=` セレクト）。`label` は設置場所の自由文字列で学校をまたぐと重複する
 * （「進路指導室前」が各務原 3 校 + 岐南工業に並ぶ）ため、全校を見る運用者が行を identify できることを pin する。
 * 出し分けは role ではなく**可視学校数**から導く（RLS が決めた可視範囲と定義上ズレない）。
 */
describe("TvDevicesPage 学校の列と絞り込み（?school=）", () => {
  // 同名ラベルが 2 校に並ぶ実データの再現（本機能の動機そのもの）。
  const GINAN = {
    ...DEVICE,
    id: "00000000-0000-0000-0000-000000000011",
    label: "進路指導室前",
    deviceId: "dev-ginan",
    schoolId: SCHOOL_A,
    schoolName: "岐阜県立岐南工業高等学校",
  };
  const KAKAMI = {
    ...DEVICE,
    id: "00000000-0000-0000-0000-000000000012",
    label: "進路指導室前",
    deviceId: "dev-kakami",
    schoolId: SCHOOL_B,
    schoolName: "岐阜県立各務原高等学校",
  };

  it("複数校が見える閲覧者には学校列を出し、同名ラベルを校名で区別できる", async () => {
    arrangeRole("system_admin");
    listMock.mockResolvedValue([GINAN, KAKAMI] as never);
    render(await TvDevicesPage(pageProps()));
    expect(screen.getByRole("columnheader", { name: "学校" })).toBeInTheDocument();
    // 同名ラベルが 2 行、校名は行ごとに異なる（= 区別できる）。
    expect(screen.getAllByText("進路指導室前")).toHaveLength(2);
    expect(screen.getByText("岐阜県立岐南工業高等学校")).toBeInTheDocument();
    expect(screen.getByText("岐阜県立各務原高等学校")).toBeInTheDocument();
  });

  it("自校しか見えない閲覧者には学校列・学校セレクトを出さない（全行同じ値のノイズを避ける）", async () => {
    arrangeRole("school_admin");
    listSchoolsMock.mockResolvedValue([SCHOOLS[0]] as never);
    listMock.mockResolvedValue([GINAN] as never);
    render(await TvDevicesPage(pageProps()));
    expect(screen.queryByRole("columnheader", { name: "学校" })).toBeNull();
    expect(screen.queryByLabelText("学校")).toBeNull();
    // 行自体は従来どおり見える。
    expect(screen.getByText("進路指導室前")).toBeInTheDocument();
  });

  it("?school= は指定校の端末だけ表示する", async () => {
    arrangeRole("system_admin");
    listMock.mockResolvedValue([GINAN, KAKAMI] as never);
    render(await TvDevicesPage(pageProps({ school: SCHOOL_B })));
    expect(screen.getByText("岐阜県立各務原高等学校")).toBeInTheDocument();
    expect(screen.queryByText("岐阜県立岐南工業高等学校")).toBeNull();
  });

  it("不可視・不正な school は全件表示にフォールバックする（URL 改竄耐性。境界は RLS）", async () => {
    arrangeRole("system_admin");
    listMock.mockResolvedValue([GINAN, KAKAMI] as never);
    render(await TvDevicesPage(pageProps({ school: "cccccccc-0000-4000-8000-000000000009" })));
    expect(screen.getByText("岐阜県立岐南工業高等学校")).toBeInTheDocument();
    expect(screen.getByText("岐阜県立各務原高等学校")).toBeInTheDocument();
  });

  it("学校セレクトを出すとき、選択中の稼働ステータスを hidden で温存する（絞り込みで status が消えない）", async () => {
    arrangeRole("system_admin");
    listMock.mockResolvedValue([GINAN, KAKAMI] as never);
    const { container } = render(
      await TvDevicesPage(pageProps({ school: SCHOOL_B, status: "never" })),
    );
    const hidden = container.querySelector('input[type="hidden"][name="status"]');
    expect(hidden).toHaveAttribute("value", "never");
    // ソート UI を持たないページなので sort/dir は URL に出さない。
    expect(container.querySelector('input[type="hidden"][name="sort"]')).toBeNull();
  });

  it("稼働ステータスのタブは学校スコープを保つ（?school= を落とさない）", async () => {
    arrangeRole("system_admin");
    listMock.mockResolvedValue([GINAN, KAKAMI] as never);
    render(await TvDevicesPage(pageProps({ school: SCHOOL_B })));
    // 「すべて」タブ = status 無し + school 保持。
    expect(screen.getByRole("link", { name: /^すべて（/ })).toHaveAttribute(
      "href",
      `/ops/tv-devices?school=${SCHOOL_B}`,
    );
  });
});
