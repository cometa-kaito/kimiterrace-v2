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
    classId: "11111111-1111-4111-8111-111111111111",
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

  it("designPattern=pattern3（廊下）は pattern2 と同一ブロックを dispatch しつつ大型ヘッダーを出す", () => {
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
});
