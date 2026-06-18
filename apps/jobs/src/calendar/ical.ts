/**
 * ADR-045: 学校行事カレンダーの公開 iCal/ICS（RFC 5545）テキストの **純粋なパース** ロジック。
 *
 * ネットワーク I/O は含まない（fixture でモックして単体検証できる、`jma-warning.ts` / `news-parse.ts` と同じ方針）。
 * 取得・upsert・fail-soft の I/O 結線は weather の `run.ts`（per-school フェーズで相乗り）、Cloud Run Job エントリは
 * `weather-job.ts` が担う。
 *
 * ## ★ RFC 5545 を手書きで完全実装しない（ADR-045 §iCal パース方式）
 * RFC 5545 は巨大（タイムゾーン VTIMEZONE・複雑な RRULE・PERIOD 等）。本パーサは **依存を増やさず**、サイネージの
 * 「学校公開行事カレンダー」表示に必要な **防御的サブセット**だけを自前で読む:
 *   - VEVENT の **UID / SUMMARY / DTSTART / DTEND / LOCATION**
 *   - **終日**判定（`DTSTART;VALUE=DATE` = 日付のみ → allDay=true）と **時刻付き**（`DTSTART:...T...`）
 *   - 行折り返し（unfolding: 行頭が空白/タブの継続行を前行に連結）
 *   - エスケープ（`\n` `\,` `\;` `\\`）の最小デコード
 *   - **単純 RRULE のサブセット**: `FREQ=DAILY` / `FREQ=WEEKLY` の `UNTIL` / `COUNT`（上限あり）のみ展開。
 *     それ以外（MONTHLY/YEARLY、BYDAY 等の複雑な規則、EXDATE、RDATE）は **展開せず元の 1 件のみ**を返す
 *     （取りこぼしても落とさない・fail-soft）。
 * これ以上の繰返し対応が要件化したら軽量ライブラリ採用（Dependency Review CI 通過前提）を再検討する
 * （ADR-045 §再検討トリガ）。
 *
 * ## ★ fail-soft（ADR-045 / NFR02）
 * 壊れた VEVENT（DTSTART 不正・UID 欠落で生成も不能 等）は **その 1 件だけ skip** し throw しない。原文は
 * 呼び出し側が `raw` に保全する（本パーサは正規化フィールド + per-event の生プロパティ map を返す）。
 *
 * ## ★ PII（ルール4 / ADR-045）
 * 接続するのは「学校公開行事カレンダー」専用の運用前提。SUMMARY / LOCATION は公開行事名・場所のみが入る想定で、
 * 生徒氏名等の PII を含む私的カレンダーを繋がない。本パーサは取得テキストをそのまま正規化するだけで、外部送信
 * （LLM / embedding）はしない。
 */

/** パース済みの 1 イベント（DB の school_calendar_events upsert 入力に構造一致、PII 非格納の運用前提）。 */
export interface ParsedCalendarEvent {
  /** iCal VEVENT UID（無ければ呼び出し側が生成。本パーサは読めたものをそのまま返し、欠落は null）。 */
  uid: string | null;
  /** 行事名（SUMMARY、エスケープ解除済）。無ければ null。 */
  summary: string | null;
  /** 開始日（JST 暦日 'YYYY-MM-DD'）。終日・時刻付きいずれもセットする。導出不能な VEVENT は skip される。 */
  startDate: string;
  /** 終了日（JST 暦日 'YYYY-MM-DD'）。単日 / 不明なら null。 */
  endDate: string | null;
  /** 時刻付き開始（DTSTART に時刻があるとき）。終日は null。 */
  startAt: Date | null;
  /** 時刻付き終了（DTEND に時刻があるとき）。終日 / 不明は null。 */
  endAt: Date | null;
  /** 終日行事か（DTSTART;VALUE=DATE）。 */
  allDay: boolean;
  /** 場所（LOCATION、エスケープ解除済）。無ければ null。 */
  location: string | null;
  /** パース済みの生プロパティ（後追い解析・raw 保全用、{ name: value }）。 */
  raw: Record<string, string>;
}

/** RRULE 展開の安全上限（無限・巨大 COUNT で行を量産しない）。 */
const MAX_RECURRENCE_OCCURRENCES = 366;

/**
 * iCal の行折り返し（RFC 5545 §3.1）を解除する。CRLF / LF いずれも受け、次行が空白 / タブで始まれば前行に連結する。
 */
function unfoldLines(text: string): string[] {
  const rawLines = text.split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * iCal プロパティ行 `NAME;PARAM=VAL:VALUE` を `{ name, params, value }` に分解する。
 * name は大文字化、params はキー大文字化した map。`:` が無い行（壊れ）は null。
 */
function parsePropertyLine(
  line: string,
): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const headParts = head.split(";");
  const name = (headParts[0] ?? "").trim().toUpperCase();
  if (name.length === 0) return null;
  const params: Record<string, string> = {};
  for (const p of headParts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) {
      params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim();
    }
  }
  return { name, params, value };
}

/** iCal TEXT 値のエスケープ（RFC 5545 §3.3.11）を最小デコードする。 */
function decodeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/** 'YYYY-MM-DD' を作る（ローカル TZ 非依存の純粋な文字列組み立て）。 */
function isoDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 解析した DTSTART/DTEND の中間表現。 */
interface ParsedDateTime {
  /** 暦日 'YYYY-MM-DD'（JST 想定。Z 付き UTC は +9h して JST 暦日に倒す）。 */
  date: string;
  /** 時刻付きなら Date（無ければ null = 終日 / 日付のみ）。 */
  at: Date | null;
  /** 終日（VALUE=DATE または日付のみ）か。 */
  allDay: boolean;
}

/**
 * iCal の日時値をパースする（防御的）。対応形式:
 *   - `YYYYMMDD`（VALUE=DATE / 終日）
 *   - `YYYYMMDDThhmmss`（floating / ローカル）→ JST 暦日として扱う
 *   - `YYYYMMDDThhmmssZ`（UTC）→ +9h して JST 暦日に倒す
 * パースできなければ null（呼び出し側が skip / null 扱い）。VTIMEZONE 参照（TZID）は時刻を信頼して JST 暦日に
 * 倒す簡略実装（PoC 規模では学校カレンダーは JST 前提・ADR-045 §iCal パース方式）。
 */
export function parseICalDate(value: string, isDateValue: boolean): ParsedDateTime | null {
  const v = value.trim();
  // 終日（日付のみ）: YYYYMMDD
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (isDateValue || dateOnly) {
    const m = dateOnly;
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { date: isoDate(y, mo, d), at: null, allDay: true };
  }
  // 時刻付き: YYYYMMDDThhmmss(Z)?
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (dt) {
    const y = Number(dt[1]);
    const mo = Number(dt[2]);
    const d = Number(dt[3]);
    const hh = Number(dt[4]);
    const mm = Number(dt[5]);
    const ss = Number(dt[6]);
    const isUtc = dt[7] === "Z";
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
    if (isUtc) {
      // UTC として解釈し、JST 暦日（+9h）に倒す。
      const at = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss));
      const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
      return {
        date: isoDate(jst.getUTCFullYear(), jst.getUTCMonth() + 1, jst.getUTCDate()),
        at,
        allDay: false,
      };
    }
    // floating / TZID 付き: JST のローカル壁時計として扱う（+09:00 を明示して Date 化）。
    const at = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss) - 9 * 60 * 60 * 1000);
    return { date: isoDate(y, mo, d), at, allDay: false };
  }
  return null;
}

/** 'YYYY-MM-DD' に日数を足した 'YYYY-MM-DD' を返す（UTC 基準で日付演算）。 */
function addDays(isoDay: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!m) return isoDay;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const next = new Date(base + days * 24 * 60 * 60 * 1000);
  return isoDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** RRULE 文字列 `FREQ=WEEKLY;COUNT=5;UNTIL=...` を `{ KEY: VAL }` map に分解する。 */
function parseRRule(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      out[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * 単純な RRULE（FREQ=DAILY / WEEKLY の COUNT / UNTIL のみ）を **開始日リスト**に展開する。
 * 対応外（MONTHLY/YEARLY・BYDAY 等・無限で COUNT/UNTIL も無い）は **元の 1 件のみ**（base のみ）を返す。
 * 安全上限 `MAX_RECURRENCE_OCCURRENCES` を超えない。各回は base から「1 日 / 7 日」刻みで進める。
 *
 * @param baseDate 'YYYY-MM-DD' の初回開始日。
 * @param rrule    RRULE 値（`FREQ=...;...`）。
 * @returns 展開後の開始日（'YYYY-MM-DD'）配列（必ず baseDate を含む）。
 */
export function expandSimpleRRule(baseDate: string, rrule: string): string[] {
  const rule = parseRRule(rrule);
  const freq = (rule.FREQ ?? "").toUpperCase();
  const step = freq === "DAILY" ? 1 : freq === "WEEKLY" ? 7 : 0;
  // 対応外の FREQ は展開しない（base のみ）。
  if (step === 0) return [baseDate];

  const count = Number.parseInt(rule.COUNT ?? "", 10);
  // UNTIL は日付 / 日時いずれもありうる。日付部分（先頭 8 桁）だけ取り出して暦日比較する。
  const untilParsed = rule.UNTIL ? parseICalDate(rule.UNTIL.slice(0, 8), true) : null;
  const until = untilParsed?.date ?? null;

  // COUNT も UNTIL も無い無限規則は base のみ（行を量産しない・fail-soft）。
  if (!(Number.isFinite(count) && count > 0) && until == null) {
    return [baseDate];
  }

  const limit =
    Number.isFinite(count) && count > 0
      ? Math.min(count, MAX_RECURRENCE_OCCURRENCES)
      : MAX_RECURRENCE_OCCURRENCES;
  const out: string[] = [];
  let cur = baseDate;
  for (let i = 0; i < limit; i++) {
    if (until != null && cur > until) break;
    out.push(cur);
    cur = addDays(cur, step);
  }
  return out.length > 0 ? out : [baseDate];
}

/** VEVENT ブロック（プロパティ行配列）から 1 つの中間 record を作る。 */
function collectEventProps(
  lines: string[],
): Map<string, { params: Record<string, string>; value: string }> {
  const props = new Map<string, { params: Record<string, string>; value: string }>();
  for (const line of lines) {
    const parsed = parsePropertyLine(line);
    if (!parsed) continue;
    // 同名プロパティ（EXDATE 等）は最初の 1 つを採る（DTSTART/DTEND/SUMMARY/UID/LOCATION/RRULE は単一想定）。
    if (!props.has(parsed.name)) {
      props.set(parsed.name, { params: parsed.params, value: parsed.value });
    }
  }
  return props;
}

/**
 * iCal/ICS テキストを `ParsedCalendarEvent[]` に変換する（防御的・fail-soft）。
 *
 * - BEGIN:VEVENT 〜 END:VEVENT を 1 ブロックとして抽出（VTIMEZONE 等は無視）。
 * - DTSTART が読めない VEVENT は skip（throw しない）。
 * - 単純 RRULE（DAILY/WEEKLY の COUNT/UNTIL）は複数行に展開（uid に `_<n>` を付与して一意化）。
 * - 壊れた行・想定外プロパティは無視して読めたぶんだけ返す。
 *
 * @param text iCal/ICS 全文。
 * @returns 正規化済みイベント配列（空もありうる）。
 */
export function parseIcs(text: string): ParsedCalendarEvent[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const lines = unfoldLines(text);
  const events: ParsedCalendarEvent[] = [];

  let inEvent = false;
  let block: string[] = [];
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      inEvent = true;
      block = [];
      continue;
    }
    if (upper === "END:VEVENT") {
      inEvent = false;
      // 1 ブロックを変換（失敗は skip）。
      try {
        events.push(...buildEventsFromBlock(block));
      } catch {
        // 壊れた VEVENT はその 1 件だけ skip（他イベント・他カレンダーを巻き込まない・fail-soft）。
      }
      block = [];
      continue;
    }
    if (inEvent) block.push(line);
  }
  return events;
}

/** 1 VEVENT ブロックを（RRULE 展開込みで）0 件以上の ParsedCalendarEvent に変換する。 */
function buildEventsFromBlock(blockLines: string[]): ParsedCalendarEvent[] {
  const props = collectEventProps(blockLines);
  const dtstartRaw = props.get("DTSTART");
  if (!dtstartRaw) return [];
  const dtstart = parseICalDate(
    dtstartRaw.value,
    dtstartRaw.params.VALUE?.toUpperCase() === "DATE",
  );
  if (!dtstart) return [];

  const dtendRaw = props.get("DTEND");
  const dtend = dtendRaw
    ? parseICalDate(dtendRaw.value, dtendRaw.params.VALUE?.toUpperCase() === "DATE")
    : null;

  const uidRaw = props.get("UID")?.value?.trim() || null;
  const summary = props.get("SUMMARY")
    ? decodeText(props.get("SUMMARY")?.value ?? "") || null
    : null;
  const location = props.get("LOCATION")
    ? decodeText(props.get("LOCATION")?.value ?? "") || null
    : null;

  // 生プロパティ map を raw 保全用に作る（値はエスケープ未解除の原文）。
  const raw: Record<string, string> = {};
  for (const [name, { value }] of props) {
    raw[name] = value;
  }

  const baseEvent: Omit<ParsedCalendarEvent, "startDate" | "uid"> = {
    summary,
    endDate: dtend ? dtend.date : null,
    startAt: dtstart.at,
    endAt: dtend ? dtend.at : null,
    allDay: dtstart.allDay,
    location,
    raw,
  };

  // RRULE が無ければ単発。
  const rruleRaw = props.get("RRULE")?.value;
  if (!rruleRaw) {
    return [{ ...baseEvent, uid: uidRaw, startDate: dtstart.date }];
  }

  // 単純 RRULE を開始日リストに展開。各回の uid に連番を付けて (school_id, uid) 一意を満たす。
  const days = expandSimpleRRule(dtstart.date, rruleRaw);
  if (days.length <= 1) {
    return [{ ...baseEvent, uid: uidRaw, startDate: dtstart.date }];
  }
  return days.map((day, i) => ({
    ...baseEvent,
    // 展開分は uid に `_<index>` を付与（元 uid が無ければ呼び出し側が生成する null のまま）。
    uid: uidRaw ? `${uidRaw}_${i}` : null,
    startDate: day,
    // 終了日は初回の差分を保つ場合があるが、PoC では各回の終了日は null（単日表示）に倒す。
    endDate: i === 0 ? baseEvent.endDate : null,
    // 展開分の時刻は初回のみ保持（各回の壁時計再計算は PoC スコープ外）。
    startAt: i === 0 ? baseEvent.startAt : null,
    endAt: i === 0 ? baseEvent.endAt : null,
  }));
}
