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
        pattern="pattern2"
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
        pattern="pattern2"
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
        pattern="pattern2"
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
        pattern="pattern2"
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
        pattern="pattern2"
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
        pattern="pattern2"
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
        pattern="pattern2"
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

describe("VisitorsEditor — 来校者の表示順を並べ替え（ドラッグ / ↑↓キー・上下ボタンは廃止）", () => {
  const nameAt = (row: number) =>
    (screen.getByLabelText(`${row} 行目の氏名`) as HTMLInputElement).value;

  it("グリップに ↑ キーで 2 行目が 1 行目になる（配列順 = 保存順 = 盤面の表示順）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors
        showCallouts={false}
        visitors={[visitor("v1", "来校 太郎"), visitor("v2", "来校 次郎")]}
        callouts={null}
      />,
    );
    expect(nameAt(1)).toBe("来校 太郎");
    expect(nameAt(2)).toBe("来校 次郎");

    // ポインタ D&D は jsdom に座標/elementFromPoint が無く検証できないため、同じ並べ替え経路をキーボードで叩く。
    fireEvent.keyDown(screen.getByRole("button", { name: "2 行目を並べ替え" }), { key: "ArrowUp" });

    expect(nameAt(1)).toBe("来校 次郎");
    expect(nameAt(2)).toBe("来校 太郎");
  });

  it("上へ/下へボタンは出さない・各行にドラッグハンドル（role=button）を出す", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors
        showCallouts={false}
        visitors={[visitor("v1", "来校 太郎"), visitor("v2", "来校 次郎")]}
        callouts={null}
      />,
    );
    expect(screen.queryByRole("button", { name: /上へ移動/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /下へ移動/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /行目を並べ替え/ })).toHaveLength(2);
  });

  it("来校者が 1 行のときはドラッグハンドルを出さない", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors
        showCallouts={false}
        visitors={[visitor("v1", "来校 太郎")]}
        callouts={null}
      />,
    );
    expect(screen.queryByRole("button", { name: /行目を並べ替え/ })).toBeNull();
  });
});

describe("CalloutsEditor — 生徒呼び出しの表示順を並べ替え（ドラッグ / ↑↓キー・上下ボタンは廃止）", () => {
  const nameAt = (row: number) =>
    (screen.getByLabelText(`${row} 行目の生徒氏名`) as HTMLInputElement).value;

  it("グリップに ↑ キーで 2 行目が 1 行目になる（配列順 = 保存順 = 盤面の表示順）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors={false}
        showCallouts
        visitors={null}
        callouts={[callout("c1", "生徒 花子"), callout("c2", "生徒 桃子")]}
      />,
    );
    expect(nameAt(1)).toBe("生徒 花子");
    expect(nameAt(2)).toBe("生徒 桃子");

    fireEvent.keyDown(screen.getByRole("button", { name: "2 行目を並べ替え" }), { key: "ArrowUp" });

    expect(nameAt(1)).toBe("生徒 桃子");
    expect(nameAt(2)).toBe("生徒 花子");
  });

  it("上へ/下へボタンは出さない・各行にドラッグハンドル（role=button）を出す", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors={false}
        showCallouts
        visitors={null}
        callouts={[callout("c1", "生徒 花子"), callout("c2", "生徒 桃子")]}
      />,
    );
    expect(screen.queryByRole("button", { name: /上へ移動/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /下へ移動/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /行目を並べ替え/ })).toHaveLength(2);
  });

  it("呼び出しが 1 行のときはドラッグハンドルを出さない", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors={false}
        showCallouts
        visitors={null}
        callouts={[callout("c1", "生徒 花子")]}
      />,
    );
    expect(screen.queryByRole("button", { name: /行目を並べ替え/ })).toBeNull();
  });
});

describe("来校者 / 生徒呼び出しの事前生成（prefillRows・盤面の規定枠 = pattern2/3 は 5）", () => {
  it("pattern2 は来校者を規定枠 5 行ぶん事前生成する（既存 1 件 + 空行 4・6 行目は無い）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors
        showCallouts={false}
        visitors={[visitor("v1", "来校 太郎")]}
        callouts={null}
      />,
    );
    expect((screen.getByLabelText("1 行目の氏名") as HTMLInputElement).value).toBe("来校 太郎");
    expect((screen.getByLabelText("5 行目の氏名") as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText("6 行目の氏名")).toBeNull();
  });

  it("空行には並べ替えハンドルを出さない（実入力 2 件 + 空行 3 → ハンドルは実入力 2 件のみ）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors
        showCallouts={false}
        visitors={[visitor("v1", "来校 太郎"), visitor("v2", "来校 次郎")]}
        callouts={null}
      />,
    );
    // 5 行（実入力 2 + 空行 3）だが、並べ替えハンドルは実入力の 2 件だけ（空行 3 行には出さない）。
    expect(screen.getByLabelText("5 行目の氏名")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /行目を並べ替え/ })).toHaveLength(2);
  });

  it("生徒呼び出しも pattern2 で 5 行ぶん事前生成する（既存 1 件 + 空行 4）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors={false}
        showCallouts
        visitors={null}
        callouts={[callout("c1", "生徒 花子")]}
      />,
    );
    expect((screen.getByLabelText("1 行目の生徒氏名") as HTMLInputElement).value).toBe("生徒 花子");
    expect((screen.getByLabelText("5 行目の生徒氏名") as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText("6 行目の生徒氏名")).toBeNull();
  });
});

describe("並べ替えで実入力行を末尾の空行スロットへ落とさない（行間の空きを作らない・no-op）", () => {
  // 事前生成（pattern2 = 5 枠）の各エディタで、最後の実入力行を ↓ キーで送ろうとしても、行き先が空行なら
  // 移動しない（no-op）ことの回帰ガード。修正前は moveItem が実入力行を空行スロットへ swap し、実入力行どうしの
  // 間に空行が挟まって「行間が空いて盤面が崩れて見える」見た目バグになっていた（データは無害＝順序は実入力行
  // のみで保存される）。↑ キーでの正規の並べ替えが動くことは上の describe で固定済み（本ブロックは下方向の no-op）。
  // ポインタ D&D の同経路（ヒットテストが空行を指す）は jsdom に座標/elementFromPoint が無いためキーボードで叩く。

  // 規定枠 5 行ぶんの名前入力値を上から収集する（空行は ""）。並びは toItems(filledRows) の保存ペイロード順と一致。
  const visitorNames = () =>
    [1, 2, 3, 4, 5].map(
      (row) => (screen.getByLabelText(`${row} 行目の氏名`) as HTMLInputElement).value,
    );
  const calloutNames = () =>
    [1, 2, 3, 4, 5].map(
      (row) => (screen.getByLabelText(`${row} 行目の生徒氏名`) as HTMLInputElement).value,
    );

  it("来校者: 末尾の実入力行で ↓ キーを押しても空行へ移らず順序不変（実入力 2 + 空行 3）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors
        showCallouts={false}
        visitors={[visitor("v1", "来校 太郎"), visitor("v2", "来校 次郎")]}
        callouts={null}
      />,
    );
    // 初期: 実入力 2（太郎 / 次郎）+ 空行 3。
    expect(visitorNames()).toEqual(["来校 太郎", "来校 次郎", "", "", ""]);

    // 2 行目（= 最後の実入力行）のグリップで ↓。行き先 3 行目は空行なので no-op。
    // 修正前はここで ["来校 太郎", "", "来校 次郎", "", ""] という「行間の空き」が生じていた。
    fireEvent.keyDown(screen.getByRole("button", { name: "2 行目を並べ替え" }), {
      key: "ArrowDown",
    });

    // 並び不変＝保存ペイロード順（DOM 上の実入力行順）も不変・行間の空き無し。
    expect(visitorNames()).toEqual(["来校 太郎", "来校 次郎", "", "", ""]);
  });

  it("生徒呼び出し: 末尾の実入力行で ↓ キーを押しても空行へ移らず順序不変（実入力 2 + 空行 3）", () => {
    render(
      <VisitorsCalloutsSection
        classId={CLASS_ID}
        pattern="pattern2"
        date="2026-06-21"
        showVisitors={false}
        showCallouts
        visitors={null}
        callouts={[callout("c1", "生徒 花子"), callout("c2", "生徒 桃子")]}
      />,
    );
    expect(calloutNames()).toEqual(["生徒 花子", "生徒 桃子", "", "", ""]);

    fireEvent.keyDown(screen.getByRole("button", { name: "2 行目を並べ替え" }), {
      key: "ArrowDown",
    });

    expect(calloutNames()).toEqual(["生徒 花子", "生徒 桃子", "", "", ""]);
  });
});
