import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 連絡 / 提出物 / 来校者 / 生徒呼び出しエディタの **Tab 縦移動**（共有フック `useGridTabNavigation`）を固定する。
 * 要望 2026-06-23: 「連絡・提出物などコンテンツ編集で Tab を押すと下に行くようにしてほしい」。予定エディタ
 * （schedule-editor-nav.test）と同じスプレッドシート挙動を横展開した: Tab=同じ列の次の行 / Shift+Tab=前の行 /
 * 最終行 Tab で行追加。日付 / 時刻の native ピッカー列は**介入しない**（内部セグメント間 Tab を残す）。
 *
 * ここでは各エディタの**配線**（どの入力をどの論理列で登録したか・native ピッカーを登録していないこと）を固定する。
 * フック共通の挙動（Shift+Tab で前行 / 先頭行は既定動作）は schedule-editor-nav.test が代表して固定済み。
 *
 * フォーカス移動のみ検証する（保存 / 検証 / RLS / 監査はサーバ側）。各 Server Action は import 時に DB を
 * 引き込むため mock（NoticeEditor / AssignmentEditor は target-school 経由で schedule-actions も読むため併せて mock）。
 */

const h = vi.hoisted(() => ({
  noop: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { count: 0 } })),
}));
// ScheduleEditor は useRouter を使う（対象日切替）。フォーカス移動のテストでは遷移しないので stub でよい。
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: (...a: unknown[]) => h.noop(...a),
  setAssignmentsAction: (...a: unknown[]) => h.noop(...a),
}));
vi.mock("@/lib/editor/schedule-actions", () => ({
  setScheduleAction: (...a: unknown[]) => h.noop(...a),
}));
vi.mock("@/lib/editor/callouts-actions", () => ({
  setCalloutsAction: (...a: unknown[]) => h.noop(...a),
}));
vi.mock("@/lib/editor/visitors-actions", () => ({
  setVisitorsAction: (...a: unknown[]) => h.noop(...a),
}));

import { AssignmentEditor } from "../../app/app/editor/[classId]/_components/AssignmentEditor";
import { CalloutsEditor } from "../../app/app/editor/[classId]/_components/CalloutsEditor";
import { NoticeEditor } from "../../app/app/editor/[classId]/_components/NoticeEditor";
import { ScheduleEditor } from "../../app/app/editor/[classId]/_components/ScheduleEditor";
import { VisitorsEditor } from "../../app/app/editor/[classId]/_components/VisitorsEditor";
import type { ScheduleItem } from "../../lib/editor/schedule-core";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-06-23";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("NoticeEditor Tab 縦移動（連絡・本文 1 列）", () => {
  const items = () => [{ text: "連絡A" }, { text: "連絡B" }];

  it("本文で Tab → 次の行の本文へ（列 0）", () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    input("1 件目の連絡事項").focus();
    fireEvent.keyDown(input("1 件目の連絡事項"), { key: "Tab" });
    expect(document.activeElement).toBe(input("2 件目の連絡事項"));
  });

  it("Shift+Tab → 前の行の本文へ", () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    input("2 件目の連絡事項").focus();
    fireEvent.keyDown(input("2 件目の連絡事項"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(input("1 件目の連絡事項"));
  });

  it("最終行で Tab → 新規行を追加して本文へ", () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={[{ text: "連絡A" }]} />);
    input("1 件目の連絡事項").focus();
    fireEvent.keyDown(input("1 件目の連絡事項"), { key: "Tab" });
    expect(document.activeElement).toBe(input("2 件目の連絡事項"));
  });
});

describe("AssignmentEditor Tab 縦移動（提出物・科目=列0 / 提出物=列1）", () => {
  const items = () => [
    { deadline: DATE, subject: "国語", task: "P.10" },
    { deadline: DATE, subject: "数学", task: "P.20" },
  ];

  it("科目で Tab → 次の行の科目へ（列 0）", () => {
    render(<AssignmentEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    input("1 件目の科目名").focus();
    fireEvent.keyDown(input("1 件目の科目名"), { key: "Tab" });
    expect(document.activeElement).toBe(input("2 件目の科目名"));
  });

  it("提出物で Tab → 次の行の提出物へ（列 1）", () => {
    render(<AssignmentEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    input("1 件目の提出物").focus();
    fireEvent.keyDown(input("1 件目の提出物"), { key: "Tab" });
    expect(document.activeElement).toBe(input("2 件目の提出物"));
  });

  it("提出期限（native date）は Tab を介入しない（既定動作のまま）", () => {
    render(<AssignmentEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const d0 = input("1 件目の提出期限");
    d0.focus();
    // 未登録列＝ハンドラ無し → preventDefault しない（fireEvent は true を返す）。フォーカスも動かさない。
    const notPrevented = fireEvent.keyDown(d0, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(d0);
  });

  it("最終行で Tab → 新規行を追加して同じ列へ", () => {
    render(<AssignmentEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    input("2 件目の科目名").focus();
    fireEvent.keyDown(input("2 件目の科目名"), { key: "Tab" });
    expect(document.activeElement).toBe(input("3 件目の科目名"));
  });
});

describe("CalloutsEditor Tab 縦移動（呼び出し・コア＝生徒氏名=列0 のみ。呼出先/用件は詳細パネルで通常 Tab）", () => {
  const items = () =>
    [
      { scheduledTime: "10:00", studentName: "山田", location: "職員室", reason: "面談" },
      { scheduledTime: "11:00", studentName: "佐藤", location: "保健室", reason: "連絡" },
    ] as never[];

  it("生徒氏名で Tab → 次の行の生徒氏名へ（列 0）", () => {
    render(<CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    input("1 行目の生徒氏名").focus();
    fireEvent.keyDown(input("1 行目の生徒氏名"), { key: "Tab" });
    expect(document.activeElement).toBe(input("2 行目の生徒氏名"));
  });

  it("用件は「詳細」パネルへ畳んだ任意項目＝grid-nav 未登録で Tab を介入しない（通常 Tab に委ねる）", () => {
    // 入力済み行（location/reason あり）は詳細が初期から開くので用件 input は存在する。畳んだ任意項目は
    // useGridTabNavigation に登録しないため Tab を preventDefault せず、フォーカスも縦移動しない（既定動作）。
    render(<CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const r0 = input("1 行目の用件");
    r0.focus();
    const notPrevented = fireEvent.keyDown(r0, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(r0);
  });

  it("時刻（native time）は Tab を介入しない", () => {
    render(<CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const t0 = input("1 行目の時刻");
    t0.focus();
    const notPrevented = fireEvent.keyDown(t0, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(t0);
  });

  it("最終行で Tab → 新規行を追加して同じ列へ", () => {
    render(<CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    input("2 行目の生徒氏名").focus();
    fireEvent.keyDown(input("2 行目の生徒氏名"), { key: "Tab" });
    expect(document.activeElement).toBe(input("3 行目の生徒氏名"));
  });
});

describe("ScheduleEditor Tab 縦移動（予定・詳細パネル内の欄も縦移動 #1256）", () => {
  // 両方の行に詳細値あり → 詳細パネルは初期から開く（useRowDisclosure・入力済みを隠さない）。
  const detailItems = (): ScheduleItem[] => [
    { period: 1, subject: "数学", note: "小テスト", location: "体育館", targetAudience: "3年" },
    { period: 2, subject: "国語", note: "音読", location: "教室", targetAudience: "1年" },
  ];

  it("詳細パネルの補足 / 場所 / 対象者で Tab → 次の行の同じ欄へ（列 3/4/5）", () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={detailItems()} />);
    for (const field of ["補足", "場所", "対象者"]) {
      input(`1 行目の${field}`).focus();
      fireEvent.keyDown(input(`1 行目の${field}`), { key: "Tab" });
      expect(document.activeElement).toBe(input(`2 行目の${field}`));
    }
  });

  it("詳細パネルの欄で Shift+Tab → 前の行の同じ欄へ", () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={detailItems()} />);
    input("2 行目の場所").focus();
    fireEvent.keyDown(input("2 行目の場所"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(input("1 行目の場所"));
  });

  it("次の行の詳細パネルが閉じているときは介入しない（既定 Tab に委ねる＝preventDefault しない）", () => {
    // 2 行目は詳細値なし → パネルは初期閉 → 2 行目の場所欄は未登録。
    const items: ScheduleItem[] = [
      { period: 1, subject: "数学", location: "体育館" },
      { period: 2, subject: "国語" },
    ];
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items} />);
    const loc0 = input("1 行目の場所");
    loc0.focus();
    const notPrevented = fireEvent.keyDown(loc0, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(loc0);
  });

  it("前の行の詳細パネルが閉じているときの Shift+Tab も介入しない", () => {
    const items: ScheduleItem[] = [
      { period: 1, subject: "数学" },
      { period: 2, subject: "国語", location: "教室" },
    ];
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items} />);
    const loc1 = input("2 行目の場所");
    loc1.focus();
    const notPrevented = fireEvent.keyDown(loc1, { key: "Tab", shiftKey: true });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(loc1);
  });

  it("最終行の詳細パネル欄で Tab → 行を追加しない（新規行のパネルは閉じておりフォーカス先が無いため）", () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={detailItems()} />);
    const aud1 = input("2 行目の対象者");
    aud1.focus();
    const notPrevented = fireEvent.keyDown(aud1, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(aud1);
    // 行が増えていない（コア列＝科目名の 3 行目が生まれない）。
    expect(screen.queryByLabelText("3 行目の科目名")).toBeNull();
  });

  it("時限「その他」の自由入力で Tab → 次の行の自由入力へ（列 2・両行がその他のとき）", () => {
    const items: ScheduleItem[] = [
      { period: { custom: "補習" }, subject: "数学" },
      { period: { custom: "講習" }, subject: "英語" },
    ];
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items} />);
    input("1 行目の時限（自由入力）").focus();
    fireEvent.keyDown(input("1 行目の時限（自由入力）"), { key: "Tab" });
    expect(document.activeElement).toBe(input("2 行目の時限（自由入力）"));
  });

  it("次の行が「その他」でない場合の自由入力 Tab は介入しない（既定 Tab に委ねる）", () => {
    const items: ScheduleItem[] = [
      { period: { custom: "補習" }, subject: "数学" },
      { period: 2, subject: "国語" },
    ];
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items} />);
    const custom0 = input("1 行目の時限（自由入力）");
    custom0.focus();
    const notPrevented = fireEvent.keyDown(custom0, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(custom0);
  });

  it("最終行の自由入力で Tab → 行を追加しない（新規行は時限未選択で自由入力欄を持たないため）", () => {
    const items: ScheduleItem[] = [{ period: { custom: "補習" }, subject: "数学" }];
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items} />);
    const custom0 = input("1 行目の時限（自由入力）");
    custom0.focus();
    const notPrevented = fireEvent.keyDown(custom0, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(screen.queryByLabelText("2 行目の科目名")).toBeNull();
  });

  it("コア列（科目）の最終行 Tab は従来どおり行を追加して同じ列へ（回帰なし）", () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={detailItems()} />);
    input("2 行目の科目名").focus();
    fireEvent.keyDown(input("2 行目の科目名"), { key: "Tab" });
    expect(document.activeElement).toBe(input("3 行目の科目名"));
  });
});

describe("VisitorsEditor Tab 縦移動（来校者・コア＝氏名=列0 のみ。所属/用件/対応者/備考は詳細パネルで通常 Tab）", () => {
  const items = () =>
    [
      {
        scheduledTime: "10:00",
        visitorName: "山田",
        affiliation: "A社",
        purpose: "営業",
        host: "教頭",
        note: "",
      },
      {
        scheduledTime: "11:00",
        visitorName: "佐藤",
        affiliation: "B社",
        purpose: "見学",
        host: "校長",
        note: "",
      },
    ] as never[];

  it("氏名で Tab → 次の行の氏名へ（列 0）", () => {
    render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    input("1 行目の氏名").focus();
    fireEvent.keyDown(input("1 行目の氏名"), { key: "Tab" });
    expect(document.activeElement).toBe(input("2 行目の氏名"));
  });

  it("対応者は「詳細」パネルへ畳んだ任意項目＝grid-nav 未登録で Tab を介入しない（通常 Tab に委ねる）", () => {
    // 入力済み行（affiliation 等あり）は詳細が初期から開くので対応者 input は存在する。畳んだ任意項目は
    // useGridTabNavigation に登録しないため Tab を preventDefault せず、フォーカスも縦移動しない（既定動作）。
    render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const h0 = input("1 行目の対応者");
    h0.focus();
    const notPrevented = fireEvent.keyDown(h0, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(h0);
  });

  it("時刻（native time）は Tab を介入しない", () => {
    render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const t0 = input("1 行目の時刻");
    t0.focus();
    const notPrevented = fireEvent.keyDown(t0, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(t0);
  });

  it("最終行（コア＝氏名）で Tab → 新規行を追加して氏名へ", () => {
    render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    input("2 行目の氏名").focus();
    fireEvent.keyDown(input("2 行目の氏名"), { key: "Tab" });
    expect(document.activeElement).toBe(input("3 行目の氏名"));
  });
});
