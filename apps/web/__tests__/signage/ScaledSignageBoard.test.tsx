import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * F（盤面ビューの再利用部品化）: `SignageBoardView`（純粋な盤面描画層）と `ScaledSignageBoard`（静的・縮小
 * ラッパ）の軽いレンダリングテスト。サンプル payload から主要領域（日付ヘッダー / 予定 / 連絡 / 提出物 / 広告）が
 * 描かれること、`ScaledSignageBoard` が read-only（時計非表示・リンク非生成・ローテーションドット無し）で
 * 静的描画することを確認する。実機の再生制御挙動は SignageClient.test 側（region ドリフトガード）が担保する。
 */

import { ScaledSignageBoard } from "../../app/(signage)/signage/[classToken]/_components/ScaledSignageBoard";
import {
  type SignageBoardProps,
  SignageBoardView,
} from "../../app/(signage)/signage/[classToken]/_components/SignageBoardView";
import type { SignagePayload } from "../../lib/signage/signage-display";

const AD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const emptySection = { items: [] as unknown[], source: null };

function ad(adId: string): SignagePayload["ads"][number] {
  return {
    adId,
    schoolId: "22222222-2222-4222-8222-222222222222",
    sourceScope: "class",
    scopeRank: 3,
    isInherited: false,
    mediaUrl: "https://cdn.example/a.png",
    mediaType: "image",
    durationSec: 10,
    linkUrl: null,
    caption: "サンプル広告",
    captionFontScale: 1,
    displayOrder: 0,
  };
}

/** 主要領域（予定/連絡/提出物）に中身を持つ pattern1 のサンプル payload。 */
function samplePayload(overrides: Partial<SignagePayload> = {}): SignagePayload {
  return {
    date: "2026-05-31",
    designPattern: "pattern1",
    assignmentDeadlineFormat: "daysLeft",
    daily: {
      date: "2026-05-31",
      schedules: emptySection,
      notices: { items: [{ text: "保護者会は15時から" }], source: null },
      assignments: {
        items: [{ subject: "数学", task: "問題集P10", deadline: "2026-06-05" }],
        source: null,
      },
      quietHours: emptySection,
    },
    scheduleDays: [
      { date: "2026-05-31", schedule: { source: null, items: [{ period: 1, subject: "国語" }] } },
    ],
    ads: [ad(AD_A)],
    weather: null,
    classContext: { departmentName: "電子工学科", gradeName: "1年", className: "A組" },
    presenceCount: null,
    visitors: null,
    callouts: null,
    trainStatus: null,
    news: null,
    weatherWarnings: null,
    heatAlerts: null,
    blackout: false,
    ...overrides,
  };
}

/** SignageBoardView を実機 SignageClient と同じ props 形（再生制御から確定済み値）で描画する。 */
function boardProps(payload: SignagePayload): SignageBoardProps {
  const firstAd = payload.ads[0] ?? null;
  return {
    data: payload,
    ad: firstAd,
    adLink: null,
    adCount: payload.ads.length,
    safeIndex: 0,
    now: null,
    onAdTap: () => {},
  };
}

describe("SignageBoardView（純粋な盤面描画層）", () => {
  it("pattern1 のサンプル payload から 日付ヘッダー / 予定 / 連絡 / 提出物 / 広告 を描く", () => {
    render(<SignageBoardView {...boardProps(samplePayload())} />);
    // 日付ヘッダー（盤面日付・YYYY年M月D日）。
    expect(screen.getByText("2026年5月31日")).toBeInTheDocument();
    // 主要 region。
    const schedule = screen.getByRole("region", { name: "予定" });
    expect(schedule).toHaveTextContent("国語");
    expect(screen.getByRole("region", { name: "連絡" })).toHaveTextContent("保護者会は15時から");
    const assignments = screen.getByRole("region", { name: "提出物" });
    expect(assignments).toHaveTextContent("数学");
    expect(assignments).toHaveTextContent("問題集P10");
    // 広告（complementary landmark = <aside aria-label="広告">）。
    expect(screen.getByRole("complementary", { name: "広告" })).toBeInTheDocument();
  });

  it("now=null では実時計を出さない（SSR / 静的描画と一致）", () => {
    render(<SignageBoardView {...boardProps(samplePayload())} />);
    // HH:MM 形式の時刻テキストが盤面に存在しない。
    expect(screen.queryByText(/^\d{2}:\d{2}$/)).toBeNull();
  });

  it("designPattern=pattern2 では掲示盤面（呼び出し/来校者/鉄道/センサ）を dispatch する", () => {
    render(<SignageBoardView {...boardProps(samplePayload({ designPattern: "pattern2" }))} />);
    expect(screen.getByRole("region", { name: "生徒呼び出し" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "来校者一覧" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "鉄道" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "人感センサカウンタ" })).toBeInTheDocument();
  });

  it("designPattern=pattern3（廊下）は pattern2 から時事ニュースを除いたブロックを dispatch しつつ大型ヘッダーを出す", () => {
    const weather: SignagePayload["weather"] = {
      areaCode: "210000",
      areaName: "岐阜県",
      fetchedAt: null,
      isStale: false,
      days: [
        {
          forecastDate: "2026-05-31",
          weatherCode: "100",
          weatherText: "晴れ",
          icon: "sunny",
          iconLabel: "晴れ",
          tempMin: 21,
          tempMax: 28,
          pop: null,
        },
      ],
    };
    render(
      <SignageBoardView {...boardProps(samplePayload({ designPattern: "pattern3", weather }))} />,
    );
    // pattern2 と同一の掲示ブロック（先方確定コンテンツ据え置き）。
    expect(screen.getByRole("region", { name: "生徒呼び出し" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "来校者一覧" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "鉄道" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "人感センサカウンタ" })).toBeInTheDocument();
    // 廊下版ヘッダーは当日の天気サマリ（気温）を時刻の隣に「最高° / 最低°」のスラッシュ表記で出す。週間天気帯
    // も最高/最低を出すが帯側は別 span（"28°" と "21°" を分離）なので、スラッシュ連結はヘッダー固有＝これが
    // あれば pattern3 の大型ヘッダーが描かれたと言える。
    expect(screen.getByText(/28°\s*\/\s*21°/)).toBeInTheDocument();
  });

  // Approach A の behavior-preserving 保証: editRegions を渡さない（live TV / モニタの壁の経路）と、編集ボタンは
  // 一切描かれず region 名（予定/連絡/提出物）も従来どおり残る＝出力不変。
  it("editRegions 無し（live / 壁）では編集ボタンを描かず region 名も従来どおり残す（出力不変）", () => {
    render(<SignageBoardView {...boardProps(samplePayload())} />);
    expect(screen.queryByRole("button", { name: "予定を編集" })).toBeNull();
    expect(screen.queryByRole("button", { name: "連絡を編集" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提出物を編集" })).toBeNull();
    expect(screen.getByRole("region", { name: "予定" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "連絡" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "提出物" })).toBeInTheDocument();
  });
});

describe("予定グリッドの列数がデータ日数に追従する（#1127 全パターン5日化の退行ガード）", () => {
  /** N 件の空き予定日を作る（列数の検証用・中身は問わない）。 */
  function scheduleDaysOf(n: number): SignagePayload["scheduleDays"] {
    return Array.from({ length: n }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      schedule: { source: null, items: [] as unknown[] },
    }));
  }

  it("pattern1: scheduleDays が 3 件なら予定グリッドは 3 列（--schedule-cols=3）", () => {
    render(
      <SignageBoardView
        {...boardProps(
          samplePayload({ designPattern: "pattern1", scheduleDays: scheduleDaysOf(3) }),
        )}
      />,
    );
    const region = screen.getByRole("region", { name: "予定" });
    const grid = region.querySelector('[style*="--schedule-cols"]') as HTMLElement;
    expect(grid).not.toBeNull();
    expect(grid.style.getPropertyValue("--schedule-cols")).toBe("3");
  });

  it("pattern3: scheduleDays が 5 件なら予定は 5 列（--p3-schedule-cols=5）", () => {
    render(
      <SignageBoardView
        {...boardProps(
          samplePayload({ designPattern: "pattern3", scheduleDays: scheduleDaysOf(5) }),
        )}
      />,
    );
    // pattern3 は予定 section 自身（region）に列数変数を載せる。
    const region = screen.getByRole("region", { name: "予定" });
    expect(region.style.getPropertyValue("--p3-schedule-cols")).toBe("5");
  });
});

describe("予定の空き行は罫線を出さず『空行』として数える（2026-06-24 ユーザー確定・#1196 を更新）", () => {
  // 罫線（点線）自体は `.schedulePlaceholder { border-bottom: none }`（CSS）で消す＝jsdom では計測不能なので、
  // ここで担保するのは **空き行が可視数ぶん確保される（counted・畳まない）** こと。以前（#1196）は予定 0 件の列を
  // プレースホルダーで埋めず完全な空列にしていたが、罫線を CSS で消したので全列で可視数まで空き行を確保する。
  /** 1 列ぶんの予定の空き行（track の子要素数）を返す。viewport は `--visible-rows` を持つ唯一の要素。 */
  function scheduleSlotsIn(region: HTMLElement): { visible: number; slots: number } {
    const viewport = region.querySelector('[style*="--visible-rows"]') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    const track = (viewport as HTMLElement).firstElementChild as HTMLElement;
    return {
      visible: Number((viewport as HTMLElement).style.getPropertyValue("--visible-rows")),
      slots: track.childElementCount,
    };
  }

  it("予定 0 件の列も可視数ぶん空き行を確保する（完全な空列に畳まない＝空行を数える）", () => {
    render(
      <SignageBoardView
        {...boardProps(
          samplePayload({
            scheduleDays: [
              { date: "2026-05-31", schedule: { source: null, items: [] as unknown[] } },
            ],
          }),
        )}
      />,
    );
    const { visible, slots } = scheduleSlotsIn(screen.getByRole("region", { name: "予定" }));
    expect(visible).toBeGreaterThan(0);
    // 予定 0 件でも visibleRows ぶんの空き行（プレースホルダー）が並ぶ＝畳まずに空行として数える。
    expect(slots).toBe(visible);
  });

  it("一部だけ埋まった列は 埋めた行 + 残りの空き行で可視数まで確保する", () => {
    render(
      <SignageBoardView
        {...boardProps(
          samplePayload({
            scheduleDays: [
              {
                date: "2026-05-31",
                schedule: {
                  source: null,
                  items: [
                    { period: 1, subject: "国語" },
                    { period: 2, subject: "数学" },
                  ],
                },
              },
            ],
          }),
        )}
      />,
    );
    const region = screen.getByRole("region", { name: "予定" });
    expect(region).toHaveTextContent("国語");
    expect(region).toHaveTextContent("数学");
    const { visible, slots } = scheduleSlotsIn(region);
    // 2 行 + (visible-2) 空き行 = visible 行ぶん（埋めた行 + 空き行の合計が可視数）。
    expect(slots).toBe(visible);
  });
});

describe("SignageBoardView 編集モード（Approach A・実エリア直接クリック）", () => {
  it("editRegions を渡すと予定/連絡/提出物の編集ボタンが実セクションを覆い、region 名/装飾見出しは AT から外れる", () => {
    const onRegion = vi.fn();
    render(
      <SignageBoardView
        {...boardProps(samplePayload())}
        editRegions={{ active: null, onRegion }}
      />,
    );
    // 各領域の編集ボタンがアクセシブルに出る（実セクションを inset:0 で覆う実描画要素）。
    const scheduleBtn = screen.getByRole("button", { name: "予定を編集" });
    expect(scheduleBtn).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "連絡を編集" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提出物を編集" })).toBeInTheDocument();
    // クリックで onRegion(region) を呼ぶ。
    fireEvent.click(scheduleBtn);
    expect(onRegion).toHaveBeenCalledWith("schedules");
    // 編集モードでは盤面内部の region 名 / h2 見出しを外し、編集器側と二重化しない（広告 region は残る）。
    expect(screen.queryByRole("region", { name: "予定" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "連絡" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "提出物" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "広告" })).toBeInTheDocument();
  });

  it("active な領域のボタンは aria-pressed=true（選択中ハイライト）", () => {
    render(
      <SignageBoardView
        {...boardProps(samplePayload())}
        editRegions={{ active: "notices", onRegion: () => {} }}
      />,
    );
    expect(screen.getByRole("button", { name: "連絡を編集" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "予定を編集" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("pattern2 では予定の編集ボタンのみ出す（連絡/提出物は pattern2 盤面に無いので対象外）", () => {
    render(
      <SignageBoardView
        {...boardProps(samplePayload({ designPattern: "pattern2" }))}
        editRegions={{ active: null, onRegion: () => {} }}
      />,
    );
    expect(screen.getByRole("button", { name: "予定を編集" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "連絡を編集" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提出物を編集" })).toBeNull();
  });

  // 指摘 v2-ed-ai5: 空き広告枠の黒帯を教員が「壊れ/未表示」と誤認しないよう、編集モード（editRegions あり）かつ
  // 広告未設定のときだけ「広告枠（広告管理で設定）」のラベルを出す。live TV（editRegions 無し）では出さず実機不変。
  it("編集モードかつ広告未設定なら『広告枠』ラベルを空き広告枠に出す（誤認防止）", () => {
    render(
      <SignageBoardView
        {...boardProps(samplePayload({ ads: [] }))}
        editRegions={{ active: null, onRegion: () => {} }}
      />,
    );
    const aside = screen.getByRole("complementary", { name: "広告" });
    expect(within(aside).getByText("広告枠")).toBeInTheDocument();
    expect(within(aside).getByText("広告管理で設定します")).toBeInTheDocument();
  });

  it("live TV（editRegions 無し）では広告未設定でも『広告枠』ラベルを出さない（実機の見た目不変）", () => {
    render(<SignageBoardView {...boardProps(samplePayload({ ads: [] }))} />);
    expect(screen.queryByText("広告枠")).toBeNull();
  });

  it("編集モードでも広告が設定済みなら『広告枠』ラベルは出さない（広告本体を出す）", () => {
    render(
      <SignageBoardView
        {...boardProps(samplePayload())}
        editRegions={{ active: null, onRegion: () => {} }}
      />,
    );
    const aside = screen.getByRole("complementary", { name: "広告" });
    expect(within(aside).queryByText("広告枠")).toBeNull();
    expect(within(aside).getByText("サンプル広告")).toBeInTheDocument();
  });
});

describe("ScaledSignageBoard（静的・縮小ラッパ）", () => {
  it("payload の主要領域を描く（日付ヘッダー / 予定 / 連絡 / 提出物 / 広告）", () => {
    render(<ScaledSignageBoard payload={samplePayload()} />);
    expect(screen.getByText("2026年5月31日")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "予定" })).toHaveTextContent("国語");
    expect(screen.getByRole("region", { name: "連絡" })).toHaveTextContent("保護者会は15時から");
    expect(screen.getByRole("region", { name: "提出物" })).toHaveTextContent("数学");
    expect(screen.getByRole("complementary", { name: "広告" })).toBeInTheDocument();
  });

  it("read-only: 実時計を出さず、linkUrl 付き広告でもリンク化しない（クリックは親が扱う）", () => {
    const payload = samplePayload({
      ads: [{ ...ad(AD_A), linkUrl: "https://sponsor.example/lp" }],
    });
    render(<ScaledSignageBoard payload={payload} />);
    // 時計非表示。
    expect(screen.queryByText(/^\d{2}:\d{2}$/)).toBeNull();
    // linkUrl があってもラッパは adLink=null で渡すのでリンクを張らない。
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("広告は先頭のみ静止表示し、ローテーションドット（複数広告インジケータ）を出さない", () => {
    const payload = samplePayload({ ads: [ad("ad-1"), ad("ad-2"), ad("ad-3")] });
    const { container } = render(<ScaledSignageBoard payload={payload} />);
    const aside = screen.getByRole("complementary", { name: "広告" });
    // 先頭広告のキャプションが出ている。
    expect(within(aside).getByText("サンプル広告")).toBeInTheDocument();
    // adCount=1 扱いなのでドット列（複数広告の位置インジケータ）は描かれない。
    expect(container.querySelectorAll("video").length).toBe(0);
  });

  it("width 指定時は枠幅を固定し --sb-scale を width/1280 で与える（JS 不要のスケール）", () => {
    const { container } = render(<ScaledSignageBoard payload={samplePayload()} width={640} />);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.width).toBe("640px");
    // 640 / 1280 = 0.5。
    expect(frame.style.getPropertyValue("--sb-scale")).toBe("0.5");
  });

  it("width 省略時は枠幅をインライン固定せず container query 既定にまかせる", () => {
    const { container } = render(<ScaledSignageBoard payload={samplePayload()} />);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.width).toBe("");
    expect(frame.style.getPropertyValue("--sb-scale")).toBe("");
  });

  // ヘッダー一致: now を渡すと（WYSIWYG エディタが live TV と同じ実時計を流す経路）ヘッダーに HH:MM の時計を出す。
  // 既定（省略）は従来どおり時計を出さない（サムネ/壁の静的描画は不変）。
  it("now を渡すとヘッダーに実時計（HH:MM）を出す", () => {
    // 2026-05-31 12:34（JST）固定。toLocaleTimeString(Asia/Tokyo) で 12:34 を出す UTC 時刻を渡す。
    const fixed = new Date("2026-05-31T03:34:00Z"); // = JST 12:34
    render(<ScaledSignageBoard payload={samplePayload()} now={fixed} />);
    expect(screen.getByText("12:34")).toBeInTheDocument();
  });

  it("now 省略時は実時計を出さない（静的描画と一致＝従来不変）", () => {
    render(<ScaledSignageBoard payload={samplePayload()} />);
    expect(screen.queryByText(/^\d{2}:\d{2}$/)).toBeNull();
  });
});

describe("ScaledSignageBoard 広告ローテーション（adIndex prop・要望: エディタ画面でも広告が回る）", () => {
  /** 区別できるよう caption だけ差し替えた広告（現在広告の caption が盤面に出るので index を判定できる）。 */
  const captioned = (adId: string, caption: string): SignagePayload["ads"][number] => ({
    ...ad(adId),
    caption,
  });
  const ads = [
    captioned("ad-a", "広告アルファ"),
    captioned("ad-b", "広告ベータ"),
    captioned("ad-c", "広告ガンマ"),
  ];

  it("adIndex を渡すとその広告を表示し、index を進めると切り替わる（＝ローテーション）", () => {
    const payload = samplePayload({ ads });
    const { rerender } = render(<ScaledSignageBoard payload={payload} adIndex={1} />);
    const aside = screen.getByRole("complementary", { name: "広告" });
    // 先頭ではなく 2 番目の広告が出る（回転している証）。
    expect(within(aside).getByText("広告ベータ")).toBeInTheDocument();
    expect(within(aside).queryByText("広告アルファ")).toBeNull();
    // index が進むと次の広告へ切り替わる。
    rerender(<ScaledSignageBoard payload={payload} adIndex={2} />);
    expect(within(aside).getByText("広告ガンマ")).toBeInTheDocument();
    expect(within(aside).queryByText("広告ベータ")).toBeNull();
  });

  it("範囲外の adIndex は件数で丸める（落ちない）", () => {
    render(<ScaledSignageBoard payload={samplePayload({ ads })} adIndex={4} />); // 4 % 3 = 1
    const aside = screen.getByRole("complementary", { name: "広告" });
    expect(within(aside).getByText("広告ベータ")).toBeInTheDocument();
  });

  it("adIndex 省略時は従来どおり先頭広告を静止表示する（サムネ / モニタの壁は不変）", () => {
    render(<ScaledSignageBoard payload={samplePayload({ ads })} />);
    const aside = screen.getByRole("complementary", { name: "広告" });
    expect(within(aside).getByText("広告アルファ")).toBeInTheDocument();
    expect(within(aside).queryByText("広告ベータ")).toBeNull();
  });
});

/**
 * F1 ページング（規定超過 → BoardPager・editor-input-tiers-and-signage-paging.md）の**構造ガード**。
 * 視覚（フェード・opacity）は jsdom で検証できない（[[ref_apps_web_tsx_tests_need_full_suite]]）ので、担保するのは:
 *   1. **超過時のみ**ページャが発動し、先頭ページが active・後続ページは `aria-hidden`（初期状態）。
 *   2. **未超過時**はページャ無し（全行が active＝従来のプレースホルダー固定枠の見た目を保つ）。
 *   3. 超過時も**全件が DOM に残る**（クリップ/hide でなくページ切替で全件見せる＝切り捨てゼロ）。
 * 規定行数（可視数）は単一ソース `blockRowCapacity(pattern, kind)`（=5）。可視数 inline（`--visible-rows`）は
 * 固定枠ビューポート（§11a）に常に付く（固定行高の基準）。
 */
describe("F1 規定超過の盤面ページング（BoardPager の構造ガード）", () => {
  /** N 件の連絡 section を作る。 */
  function noticesOf(n: number): SignagePayload["daily"]["notices"] {
    return {
      items: Array.from({ length: n }, (_, i) => ({ text: `連絡${i + 1}` })),
      source: null,
    };
  }
  /** 1 日に N コマの予定を持つ scheduleDays（1 列）を作る。 */
  function scheduleDayWith(n: number): SignagePayload["scheduleDays"] {
    return [
      {
        date: "2026-05-31",
        schedule: {
          source: null,
          items: Array.from({ length: n }, (_, i) => ({ period: i + 1, subject: `コマ${i + 1}` })),
        },
      },
    ];
  }
  /** N 件の来校者を作る（氏名 + 用件のメタ 2 行目を持つ＝可変高アイテムのクリップ検証用）。 */
  function visitorsOf(n: number): SignagePayload["visitors"] {
    return Array.from({ length: n }, (_, i) => ({
      id: `v-${i + 1}`,
      scheduledTime: "10:00",
      visitorName: `来校者${i + 1}`,
      affiliation: "ABC社",
      purpose: `用件${i + 1}`,
      host: "担任",
    })) as NonNullable<SignagePayload["visitors"]>;
  }
  /** N 件の生徒呼び出しを作る。 */
  function calloutsOf(n: number): SignagePayload["callouts"] {
    return Array.from({ length: n }, (_, i) => ({
      id: `c-${i + 1}`,
      scheduledTime: "10:00",
      studentName: `生徒${i + 1}`,
      location: "進路指導室",
      reason: `用件${i + 1}`,
    })) as NonNullable<SignagePayload["callouts"]>;
  }
  /** 固定枠ビューポート（§11a）の可視数 inline（`--visible-rows`）。ページングでも常に付く（固定行高の基準）。 */
  function visibleRowsIn(region: HTMLElement): string {
    const viewport = region.querySelector('[style*="--visible-rows"]') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    return (viewport as HTMLElement).style.getPropertyValue("--visible-rows");
  }
  /**
   * テキスト `text` を持つ行が**非 active ページ**（`aria-hidden="true"` の `.pagerPage`）に居るか。
   * ページャ未発動（未超過＝静的）の行はどの祖先にも aria-hidden が無い（=false）。
   */
  function inHiddenPage(region: HTMLElement, text: string | RegExp): boolean {
    return within(region).getByText(text).closest('[aria-hidden="true"]') !== null;
  }
  // pattern2/3 も A2 で F1 ページング化（旧 JS AutoScroll / p3 CSS マーキーは撤廃）。構造ガードは pattern1 と
  // 同じ inHiddenPage ベース（全件 DOM 保持 + 超過分は非 active ページ）。

  it("pattern1 連絡: 6 件（規定 5 超過）でページャ発動＝全 6 件が DOM に残り、6 件目は次ページ（aria-hidden）", () => {
    render(
      <SignageBoardView
        {...boardProps(
          samplePayload({ daily: { ...samplePayload().daily, notices: noticesOf(6) } }),
        )}
      />,
    );
    const region = screen.getByRole("region", { name: "連絡" });
    expect(visibleRowsIn(region)).toBe("5");
    // 全件が DOM に残る（クリップせずページ切替で全件見せる＝切り捨てゼロ）。
    expect(region).toHaveTextContent("連絡1");
    expect(region).toHaveTextContent("連絡6");
    // 初期は先頭ページ（1〜5 件目）が active、6 件目は 2 ページ目（aria-hidden）。
    expect(inHiddenPage(region, "連絡1")).toBe(false);
    expect(inHiddenPage(region, "連絡6")).toBe(true);
  });

  it("pattern1 連絡: 3 件（規定 5 未満）ではページャを使わない（静的・固定枠の見た目維持）", () => {
    render(
      <SignageBoardView
        {...boardProps(
          samplePayload({ daily: { ...samplePayload().daily, notices: noticesOf(3) } }),
        )}
      />,
    );
    const region = screen.getByRole("region", { name: "連絡" });
    expect(visibleRowsIn(region)).toBe("5");
    for (let i = 1; i <= 3; i++) {
      expect(inHiddenPage(region, `連絡${i}`)).toBe(false);
    }
  });

  it("pattern1 予定列: 6 コマ（規定 5 超過）でページャ発動＝全コマが DOM に残り、6 コマ目は次ページ", () => {
    render(
      <SignageBoardView {...boardProps(samplePayload({ scheduleDays: scheduleDayWith(6) }))} />,
    );
    const region = screen.getByRole("region", { name: "予定" });
    expect(visibleRowsIn(region)).toBe("5");
    expect(region).toHaveTextContent("コマ1");
    expect(region).toHaveTextContent("コマ6");
    expect(inHiddenPage(region, "コマ1")).toBe(false);
    expect(inHiddenPage(region, "コマ6")).toBe(true);
  });

  it("pattern2 予定列: 6 コマ（1 ページ 4 コマ=メタ 2 行対策の保守値）でページャ発動＝5 コマ目以降は次ページ", () => {
    render(
      <SignageBoardView
        {...boardProps(
          samplePayload({ designPattern: "pattern2", scheduleDays: scheduleDayWith(6) }),
        )}
      />,
    );
    const region = screen.getByRole("region", { name: "予定" });
    expect(region).toHaveTextContent("コマ1");
    expect(region).toHaveTextContent("コマ6");
    expect(inHiddenPage(region, "コマ1")).toBe(false);
    expect(inHiddenPage(region, "コマ5")).toBe(true);
    expect(inHiddenPage(region, "コマ6")).toBe(true);
  });

  it("pattern2 来校者: 6 件（1 ページ 3 件・自然高さ保守値）でページャ発動＝4 件目以降は次ページ・用件メタも DOM 保持", () => {
    render(
      <SignageBoardView
        {...boardProps(samplePayload({ designPattern: "pattern2", visitors: visitorsOf(6) }))}
      />,
    );
    const region = screen.getByRole("region", { name: "来校者一覧" });
    expect(region).toHaveTextContent("来校者6");
    expect(region).toHaveTextContent("用件6");
    expect(inHiddenPage(region, "来校者1")).toBe(false);
    expect(inHiddenPage(region, "来校者4")).toBe(true);
    expect(inHiddenPage(region, "来校者6")).toBe(true);
  });

  it("pattern2 呼び出し: 6 件（1 ページ 3 件）でページャ発動＝4 件目以降は次ページ・用件メタも DOM 保持", () => {
    render(
      <SignageBoardView
        {...boardProps(samplePayload({ designPattern: "pattern2", callouts: calloutsOf(6) }))}
      />,
    );
    const region = screen.getByRole("region", { name: "生徒呼び出し" });
    expect(region).toHaveTextContent("生徒6");
    expect(region).toHaveTextContent("用件6");
    expect(inHiddenPage(region, "生徒1")).toBe(false);
    expect(inHiddenPage(region, "生徒4")).toBe(true);
  });

  it("pattern2 呼び出し: 3 件（規定内）はページャ無しで静的", () => {
    render(
      <SignageBoardView
        {...boardProps(samplePayload({ designPattern: "pattern2", callouts: calloutsOf(3) }))}
      />,
    );
    const region = screen.getByRole("region", { name: "生徒呼び出し" });
    for (let i = 1; i <= 3; i++) {
      expect(inHiddenPage(region, `生徒${i}`)).toBe(false);
    }
  });

  it("pattern3 予定列: 6 コマ（可視 5 超過）でページャ発動＝全コマ DOM 保持・6 コマ目は次ページ", () => {
    render(
      <SignageBoardView
        {...boardProps(
          samplePayload({ designPattern: "pattern3", scheduleDays: scheduleDayWith(6) }),
        )}
      />,
    );
    const region = screen.getByRole("region", { name: "予定" });
    expect(region).toHaveTextContent("コマ1");
    expect(region).toHaveTextContent("コマ6");
    expect(inHiddenPage(region, "コマ1")).toBe(false);
    expect(inHiddenPage(region, "コマ6")).toBe(true);
  });

  it("pattern3 予定列: 5 コマ（規定内）はページャ無しで静的", () => {
    render(
      <SignageBoardView
        {...boardProps(
          samplePayload({ designPattern: "pattern3", scheduleDays: scheduleDayWith(5) }),
        )}
      />,
    );
    const region = screen.getByRole("region", { name: "予定" });
    for (let i = 1; i <= 5; i++) {
      expect(inHiddenPage(region, `コマ${i}`)).toBe(false);
    }
  });

  it("pattern3 来校者: 6 件（可視 5 超過）でページャ発動＝6 件目は次ページ", () => {
    render(
      <SignageBoardView
        {...boardProps(samplePayload({ designPattern: "pattern3", visitors: visitorsOf(6) }))}
      />,
    );
    const region = screen.getByRole("region", { name: "来校者一覧" });
    expect(region).toHaveTextContent("来校者6");
    expect(inHiddenPage(region, "来校者1")).toBe(false);
    expect(inHiddenPage(region, "来校者6")).toBe(true);
  });

  it("提出物: 6 件（規定 5 超過）でページャ発動＝各ページが完全なテーブルになり全件が DOM に残る", () => {
    render(
      <SignageBoardView
        {...boardProps(
          samplePayload({
            daily: {
              ...samplePayload().daily,
              assignments: {
                items: Array.from({ length: 6 }, (_, i) => ({
                  subject: `科目${i + 1}`,
                  task: `課題${i + 1}`,
                  deadline: "2026-06-05",
                })),
                source: null,
              },
            },
          }),
        )}
      />,
    );
    const region = screen.getByRole("region", { name: "提出物" });
    // 旧 `.taskTable tbody>tr:nth-of-type(n+6){display:none}`（6 件目以降を黙って隠す）は撤廃＝全件 DOM に残り、
    // 6 件目は 2 ページ目（aria-hidden・thead 込みの完全なテーブル）に居る。
    expect(region).toHaveTextContent("課題1");
    expect(region).toHaveTextContent("課題6");
    expect(inHiddenPage(region, "課題1")).toBe(false);
    expect(inHiddenPage(region, "課題6")).toBe(true);
  });
});
