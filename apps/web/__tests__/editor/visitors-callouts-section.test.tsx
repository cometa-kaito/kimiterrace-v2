import type { ClassVisitor, StudentCallout } from "@kimiterrace/db";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
      // 順序: 生徒呼び出し → 来校者一覧（盤面 pattern2/3 の左右順に一致・#12／押し出されない）。
      const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
      expect(headings).toEqual(["生徒呼び出し", "来校者一覧"]);
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

  it("初回 render 時点でも来校者一覧/生徒呼び出しは各 1 つずつ・順序維持（rerender 経路とは別経路の固定）", () => {
    // rerender（?date= ソフトナビ）経路は上のケースで固定済。こちらは初回マウント単体を独立に固定し、
    // 将来 key 戦略を弄った時に初回描画側の退行も検知できるようにする。
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-21"
        showVisitors
        showCallouts
        visitors={[visitor("v1", "来校 太郎")]}
        callouts={[callout("c1", "生徒 花子")]}
      />,
    );
    expect(screen.getAllByRole("heading", { name: "来校者一覧", level: 2 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "生徒呼び出し", level: 2 })).toHaveLength(1);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    // 順序: 生徒呼び出し → 来校者一覧（盤面 pattern2/3 の左右順に一致・#12）。
    expect(headings).toEqual(["生徒呼び出し", "来校者一覧"]);
  });

  it("各編集欄を盤面ジャンプ用の anchor id を持つラッパで囲む（#2 のジャンプ先・順序は呼び出し→来校者）", () => {
    const { container } = render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-21"
        showVisitors
        showCallouts
        visitors={[visitor("v1", "来校 太郎")]}
        callouts={[callout("c1", "生徒 花子")]}
      />,
    );
    // focusRegion が getElementById で到達する anchor。両方とも存在する。
    expect(container.querySelector("#editor-region-callouts")).not.toBeNull();
    expect(container.querySelector("#editor-region-visitors")).not.toBeNull();
    // DOM 上の左右順は 呼び出し(left) → 来校者(right)（盤面 pattern2/3 と一致・#12）。
    const ids = Array.from(container.querySelectorAll("[id^='editor-region-']")).map((el) => el.id);
    expect(ids).toEqual(["editor-region-callouts", "editor-region-visitors"]);
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

describe("VisitorsEditor — 来校者の表示順を並べ替えできる（上へ/下へ）", () => {
  const nameAt = (row: number) =>
    (screen.getByLabelText(`${row} 行目の氏名`) as HTMLInputElement).value;

  it("下の行を上へ移動すると順序が入れ替わる（配列順 = 保存順 = 盤面の表示順）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-21"
        showVisitors
        showCallouts={false}
        visitors={[visitor("v1", "来校 太郎"), visitor("v2", "来校 次郎")]}
        callouts={null}
      />,
    );
    expect(nameAt(1)).toBe("来校 太郎");
    expect(nameAt(2)).toBe("来校 次郎");

    fireEvent.click(screen.getByRole("button", { name: "2 行目を上へ移動（全 2 行中）" }));

    expect(nameAt(1)).toBe("来校 次郎");
    expect(nameAt(2)).toBe("来校 太郎");
  });

  it("先頭の上 / 末尾の下は無効（端で押せない）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-21"
        showVisitors
        showCallouts={false}
        visitors={[visitor("v1", "来校 太郎"), visitor("v2", "来校 次郎")]}
        callouts={null}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "1 行目を上へ移動（全 2 行中）" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "2 行目を下へ移動（全 2 行中）" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("来校者が 1 行のときは並べ替えコントロールを出さない", () => {
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
    expect(screen.queryByRole("button", { name: /行目を上へ移動/ })).toBeNull();
  });
});

describe("CalloutsEditor — 生徒呼び出しの表示順を並べ替えできる（上へ/下へ）", () => {
  const nameAt = (row: number) =>
    (screen.getByLabelText(`${row} 行目の生徒氏名`) as HTMLInputElement).value;

  it("下の行を上へ移動すると順序が入れ替わる（配列順 = 保存順 = 盤面の表示順）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-21"
        showVisitors={false}
        showCallouts
        visitors={null}
        callouts={[callout("c1", "生徒 花子"), callout("c2", "生徒 桃子")]}
      />,
    );
    expect(nameAt(1)).toBe("生徒 花子");
    expect(nameAt(2)).toBe("生徒 桃子");

    fireEvent.click(screen.getByRole("button", { name: "2 行目を上へ移動（全 2 行中）" }));

    expect(nameAt(1)).toBe("生徒 桃子");
    expect(nameAt(2)).toBe("生徒 花子");
  });

  it("先頭の上 / 末尾の下は無効（端で押せない）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-21"
        showVisitors={false}
        showCallouts
        visitors={null}
        callouts={[callout("c1", "生徒 花子"), callout("c2", "生徒 桃子")]}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "1 行目を上へ移動（全 2 行中）" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "2 行目を下へ移動（全 2 行中）" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("呼び出しが 1 行のときは並べ替えコントロールを出さない", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        date="2026-06-21"
        showVisitors={false}
        showCallouts
        visitors={null}
        callouts={[callout("c1", "生徒 花子")]}
      />,
    );
    expect(screen.queryByRole("button", { name: /行目を上へ移動/ })).toBeNull();
  });
});
