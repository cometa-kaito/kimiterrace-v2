import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import type { ListParams } from "./list-params";

const { color, fontSize, radius, space } = tokens;

/**
 * UIUX-03: admin 一覧の共通フィルタバー (Server Component)。
 *
 * `<form method="get">` でフリーワード検索 / セレクトフィルタ / 日付範囲を URL searchParams に
 * 反映する (JS 不要・リロード型。管理者向けは網羅性 > 滑らかさ)。ソート状態 (`sort`/`dir`) は
 * hidden で温存し、フィルタ変更時は page を 1 に戻す (page を form に含めない)。
 * 「クリア」は basePath への素のリンク (全条件リセット)。
 *
 * **本フォーム外の URL 状態は {@link DataListControls} の `hidden` で温存する**: GET フォームの送信は
 * URL を丸ごと置き換えるため、フォームに含めない条件 (例: `/ops/tv-devices` の `?status=` タブ) は
 * hidden を渡さないと絞り込みのたびに黙って消える。sort/dir と同じ理由の仕組み。
 */

export type DataListSelect = {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
};

export function DataListControls({
  basePath,
  params,
  searchPlaceholder,
  selects = [],
  dateRange = false,
  dateRangeLabel = "期間",
  hidden,
}: {
  basePath: string;
  params: ListParams;
  /** 指定したときだけフリーワード検索欄を出す。 */
  searchPlaceholder?: string;
  selects?: readonly DataListSelect[];
  dateRange?: boolean;
  dateRangeLabel?: string;
  /**
   * フォーム外で持っている URL 条件を送信時に温存する追加 hidden (例: `{ status: "down" }`)。
   * 値が空文字のキーは出さない (空パラメータで URL を汚さない)。
   */
  hidden?: Readonly<Record<string, string>>;
}) {
  return (
    <form method="get" action={basePath} style={formStyle}>
      {/* ソート UI を持たない一覧 (sortKeys 空 → sort "") では sort/dir を URL に出さない。 */}
      {params.sort !== "" && (
        <>
          <input type="hidden" name="sort" value={params.sort} />
          <input type="hidden" name="dir" value={params.dir} />
        </>
      )}
      {Object.entries(hidden ?? {}).map(([name, value]) =>
        value === "" ? null : <input key={name} type="hidden" name={name} value={value} />,
      )}

      {searchPlaceholder !== undefined && (
        <label style={fieldStyle}>
          <span style={labelStyle}>検索</span>
          <input
            type="search"
            name="q"
            defaultValue={params.q}
            placeholder={searchPlaceholder}
            style={{ ...inputStyle, minWidth: "14rem" }}
          />
        </label>
      )}

      {selects.map((sel) => (
        <label key={sel.name} style={fieldStyle}>
          <span style={labelStyle}>{sel.label}</span>
          <select name={sel.name} defaultValue={params.filters[sel.name] ?? ""} style={inputStyle}>
            <option value="">すべて</option>
            {sel.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      ))}

      {dateRange && (
        <label style={fieldStyle}>
          <span style={labelStyle}>{dateRangeLabel}</span>
          <span style={rangeStyle}>
            <input type="date" name="from" defaultValue={params.from ?? ""} style={inputStyle} />
            <span style={tildeStyle}>〜</span>
            <input type="date" name="to" defaultValue={params.to ?? ""} style={inputStyle} />
          </span>
        </label>
      )}

      <button type="submit" style={submitStyle}>
        絞り込む
      </button>
      <Link href={basePath} style={clearStyle}>
        クリア
      </Link>
    </form>
  );
}

const formStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: space.md,
  padding: space.md,
  background: color.bgSoft,
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  marginBottom: space.lg,
};
const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space.xs,
};
const labelStyle: React.CSSProperties = { fontSize: fontSize.xs, color: color.muted };
const inputStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  padding: `0.35rem ${space.sm}`,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  background: "#fff",
  color: color.ink,
};
const rangeStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: space.xs };
const tildeStyle: React.CSSProperties = { color: color.muted, fontSize: fontSize.sm };
const submitStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: "#fff",
  background: color.primary,
  border: "none",
  borderRadius: radius.sm,
  padding: `0.4rem ${space.lg}`,
  cursor: "pointer",
};
const clearStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.muted,
  alignSelf: "center",
};
