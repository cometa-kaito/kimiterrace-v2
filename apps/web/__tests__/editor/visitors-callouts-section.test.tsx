import type { ClassVisitor, StudentCallout } from "@kimiterrace/db";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 来校者一覧 / 生徒呼び出しセクション（{@link VisitorsCalloutsSection}）の回帰テスト。
 *
 * ## 再現する実バグ（本番 6/21→6/22）
 * 対象日を変えると「来校者一覧」が複製され「生徒呼び出し」が下へ押し出される、とユーザーが実画面で観察。
 * 真因は親が `<VisitorsEditor key={date} />` と `<CalloutsEditor key={date} />` を**同一親内で同じ key**で
 * 並べていたこと（兄弟キー衝突）。`?date=` ソフトナビで date が変わると React の keyed reconciliation が
 * 衝突キーで破綻して複製/順序崩れになる。本テストは「対象日を複数回（データ有/無）変えても、来校者一覧 /
 * 生徒呼び出しが各 1 つずつ正しい順序で出る」を固定し、衝突キーへの逆戻りを検知する。
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
// 各エディタが server action（"use server" → next/cache を引く）を import するのでモックして島だけ評価する。
vi.mock("@/lib/editor/visitors-actions", () => ({
  setVisitorsAction: vi.fn(async () => ({ ok: true, data: { count: 0 } })),
}));
vi.mock("@/lib/editor/callouts-actions", () => ({
  setCalloutsAction: vi.fn(async () => ({ ok: true, data: { count: 0 } })),
}));

import { VisitorsCalloutsSection } from "../../app/app/editor/[classId]/_components/VisitorsCalloutsSection";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";

function visitor(id: string, name: string): ClassVisitor {
  return {
    id,
    visitorName: name,
    affiliation: null,
    scheduledTime: null,
    purpose: null,
    host: null,
    note: null,
  } as ClassVisitor;
}
function callout(id: string, name: string): StudentCallout {
  return {
    id,
    studentName: name,
    location: null,
    reason: null,
    scheduledTime: null,
  } as StudentCallout;
}

afterEach(cleanup);

describe("VisitorsCalloutsSection — 対象日変更で複製しない（再現バグの回帰ガード）", () => {
  it("対象日を複数回変えても来校者一覧/生徒呼び出しは各 1 つずつ・順序維持", () => {
    const { rerender } = render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-21"
        showVisitors
        showCallouts
        visitors={[visitor("v1", "来校 太郎")]}
        callouts={[callout("c1", "生徒 花子")]}
      />,
    );
    const assertExactlyOneEach = () => {
      expect(screen.getAllByRole("heading", { name: "来校者一覧", level: 2 })).toHaveLength(1);
      expect(screen.getAllByRole("heading", { name: "生徒呼び出し", level: 2 })).toHaveLength(1);
      // 順序: 来校者一覧 → 生徒呼び出し（盤面の 2 カラム対応・押し出されない）。
      const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
      expect(headings).toEqual(["来校者一覧", "生徒呼び出し"]);
    };
    assertExactlyOneEach();

    // 6/22: データ有 → 衝突キーだとここで「来校者一覧」が 2 つに複製していた。
    rerender(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-22"
        showVisitors
        showCallouts
        visitors={[visitor("v2", "来校 次郎")]}
        callouts={[callout("c2", "生徒 桃子")]}
      />,
    );
    assertExactlyOneEach();

    // 6/23: データ無（空配列）でも各 1 つずつ・順序維持。
    rerender(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-23"
        showVisitors
        showCallouts
        visitors={[]}
        callouts={[]}
      />,
    );
    assertExactlyOneEach();
  });

  it("パターンに含まれないブロックは出さない（visitors のみ）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-21"
        showVisitors
        showCallouts={false}
        visitors={[visitor("v1", "来校 太郎")]}
        callouts={null}
      />,
    );
    expect(screen.getByRole("heading", { name: "来校者一覧", level: 2 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "生徒呼び出し", level: 2 })).toBeNull();
  });

  it("両方非表示なら何も描かない", () => {
    const { container } = render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-21"
        showVisitors={false}
        showCallouts={false}
        visitors={null}
        callouts={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
