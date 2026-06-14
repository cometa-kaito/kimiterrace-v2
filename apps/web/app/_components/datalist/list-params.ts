/**
 * UIUX-03: admin 一覧の URL searchParams 正規化 (共通 DataList 基盤の純ロジック層)。
 *
 * すべての一覧ページが `?q=&sort=&dir=&page=&from=&to=&<filter>=` を同じ作法で解釈できるよう、
 * 解析 (検証込み) とクエリ文字列再構築をここに集約する。React 非依存 (Server Component /
 * クエリ層のどちらからも import 可)。不正値は黙って既定値に落とす (URL は外部入力)。
 */

export type SortDir = "asc" | "desc";

/** 解析済みの一覧パラメータ。`filters` は config.filterKeys で許可したキーのみ保持する。 */
export type ListParams = {
  q: string;
  sort: string;
  dir: SortDir;
  page: number;
  pageSize: number;
  /** JST の日付文字列 (YYYY-MM-DD)。範囲フィルタ非対応ページでは null のまま。 */
  from: string | null;
  to: string | null;
  filters: Record<string, string>;
};

export type ListParamsConfig = {
  /** ソート可能な列キーの allowlist。 */
  sortKeys: readonly string[];
  defaultSort: string;
  defaultDir?: SortDir;
  /** セレクト型フィルタとして受け付けるキーの allowlist。 */
  filterKeys?: readonly string[];
  pageSize?: number;
};

export type RawSearchParams = Record<string, string | string[] | undefined>;

export const DEFAULT_PAGE_SIZE = 50;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function parseDate(value: string): string | null {
  if (!DATE_RE.test(value)) {
    return null;
  }
  // 2026-02-31 のような実在しない日付は Date 化のラウンドトリップで弾く。
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  const valid = dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  return valid ? value : null;
}

/** searchParams を検証付きで {@link ListParams} に解決する。不正値は既定値へフォールバック。 */
export function parseListParams(raw: RawSearchParams, config: ListParamsConfig): ListParams {
  const q = first(raw.q).trim().slice(0, 200);

  const sortRaw = first(raw.sort);
  const sort = config.sortKeys.includes(sortRaw) ? sortRaw : config.defaultSort;
  const dirRaw = first(raw.dir);
  const dir: SortDir =
    dirRaw === "asc" || dirRaw === "desc" ? dirRaw : (config.defaultDir ?? "desc");

  const pageRaw = Number.parseInt(first(raw.page), 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(pageRaw, 100_000) : 1;

  let from = parseDate(first(raw.from));
  let to = parseDate(first(raw.to));
  if (from && to && from > to) {
    // 逆転範囲は入力ミスとみなし入れ替える (0 件表示よりも意図に近い)。
    [from, to] = [to, from];
  }

  const filters: Record<string, string> = {};
  for (const key of config.filterKeys ?? []) {
    const value = first(raw[key]).trim().slice(0, 200);
    if (value !== "") {
      filters[key] = value;
    }
  }

  return { q, sort, dir, page, pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE, from, to, filters };
}

/**
 * 現在の {@link ListParams} を保ったままクエリ文字列を再構築する (ソートリンク・ページャ用)。
 * `overrides.page: null` で page を 1 に戻す (フィルタ/ソート変更時の定石)。
 */
export function listQueryString(
  params: ListParams,
  overrides?: Partial<Pick<ListParams, "q" | "sort" | "dir" | "from" | "to">> & {
    page?: number | null;
    filters?: Record<string, string>;
  },
): string {
  const merged = {
    q: overrides?.q ?? params.q,
    sort: overrides?.sort ?? params.sort,
    dir: overrides?.dir ?? params.dir,
    page: overrides?.page === null ? 1 : (overrides?.page ?? params.page),
    from: overrides?.from !== undefined ? overrides.from : params.from,
    to: overrides?.to !== undefined ? overrides.to : params.to,
    filters: overrides?.filters ?? params.filters,
  };
  const sp = new URLSearchParams();
  if (merged.q) {
    sp.set("q", merged.q);
  }
  sp.set("sort", merged.sort);
  sp.set("dir", merged.dir);
  if (merged.page > 1) {
    sp.set("page", String(merged.page));
  }
  if (merged.from) {
    sp.set("from", merged.from);
  }
  if (merged.to) {
    sp.set("to", merged.to);
  }
  for (const [key, value] of Object.entries(merged.filters)) {
    if (value !== "") {
      sp.set(key, value);
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * JST 日付範囲を timestamptz 境界へ変換する。`untilExclusive` は to の翌日 0:00 JST
 * (`< untilExclusive` で当日末尾まで含む)。DB セッション TZ に依存しない明示オフセット。
 */
export function dateRangeBounds(params: Pick<ListParams, "from" | "to">): {
  since: Date | null;
  untilExclusive: Date | null;
} {
  const since = params.from ? new Date(`${params.from}T00:00:00+09:00`) : null;
  let untilExclusive: Date | null = null;
  if (params.to) {
    const end = new Date(`${params.to}T00:00:00+09:00`);
    end.setUTCDate(end.getUTCDate() + 1);
    untilExclusive = end;
  }
  return { since, untilExclusive };
}

/** ILIKE パターン用に `%` `_` `\` をエスケープする (検索語を literal 扱いにする)。 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** SELECT count/offset の総件数からページ数を計算する (最低 1)。 */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** 一覧 SELECT に渡す limit/offset。page が末尾超過でも DB は空配列を返すだけで安全。 */
export function pageWindow(params: Pick<ListParams, "page" | "pageSize">): {
  limit: number;
  offset: number;
} {
  return { limit: params.pageSize, offset: (params.page - 1) * params.pageSize };
}
