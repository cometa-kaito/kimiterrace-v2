"use client";

import { setClassWeeklyTimetableAction } from "@/lib/editor/weekly-timetable-actions";
import {
  WEEKDAY_LABEL,
  WEEKDAY_NUMBERS,
  type WeekdayNumber,
  type WeeklyTimetable,
} from "@/lib/editor/weekly-timetable-core";
import { tokens } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  errorTextStyle,
  inputStyle,
  primaryBtnDisabledStyle,
  primaryBtnStyle,
  savedTextStyle,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
} from "./editor-styles";

/**
 * 週次ベース時間割エディタ（F5・セカンド層）。**月〜金 × 1〜6 限**の基本時間割（科目）を 1 画面で登録・編集し、
 * `setClassWeeklyTimetableAction` で **1 クラス 1 行**保存する。ここで登録した基本時間割は、日々のエディタで
 * **対象日の予定が空のとき初期値に seed** される（コピーオンライト・盤面の表示時マージはしない）。
 *
 * 補足（場所/対象者）は日ごとに変わるため基本時間割には持たせず、**科目のみ**をシンプルに登録する（v1）。保存は
 * 計画作業（週 1 回程度）なので自動保存ではなく明示「保存」にする。科目名の長さ上限（32 文字）はサーバ検証
 * （`validateScheduleItems`）が担い、超過時は保存エラーで表示する。
 */
const PERIODS = [1, 2, 3, 4, 5, 6] as const;

/** grid[weekday][period] = 科目名。空文字は未設定。 */
type Grid = Record<WeekdayNumber, Record<number, string>>;

function buildGrid(initial: WeeklyTimetable): Grid {
  const grid = {} as Grid;
  for (const wd of WEEKDAY_NUMBERS) {
    grid[wd] = {};
    for (const p of PERIODS) {
      grid[wd][p] = "";
    }
    for (const item of initial[`${wd}`] ?? []) {
      // 数値時限 1..6 のみグリッドに載せる（特殊スロット/7限以降は v1 のグリッド対象外＝保存時も送らない）。
      if (typeof item.period === "number" && item.period >= 1 && item.period <= 6) {
        grid[wd][item.period] = item.subject;
      }
    }
  }
  return grid;
}

/** grid を保存ペイロード（曜日別 ScheduleItem 配列）に正規化する。空科目のコマは落とす。 */
function toTimetable(grid: Grid): WeeklyTimetable {
  const out: WeeklyTimetable = {};
  for (const wd of WEEKDAY_NUMBERS) {
    const items = PERIODS.filter((p) => grid[wd][p]?.trim()).map((p) => ({
      period: p,
      subject: grid[wd][p] as string,
    }));
    if (items.length > 0) {
      out[`${wd}`] = items;
    }
  }
  return out;
}

export function WeeklyTimetableEditor({
  classId,
  initial,
}: {
  classId: string;
  initial: WeeklyTimetable;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [grid, setGrid] = useState<Grid>(() => buildGrid(initial));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  function update(wd: WeekdayNumber, period: number, subject: string) {
    setGrid((prev) => ({ ...prev, [wd]: { ...prev[wd], [period]: subject } }));
    setDirty(true);
  }

  function save() {
    startTransition(async () => {
      const res = await setClassWeeklyTimetableAction(classId, toTimetable(grid));
      if (res.ok) {
        setDirty(false);
        setMsg({ ok: true, text: "基本時間割を保存しました。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <section aria-label="週次ベース時間割" style={{ display: "grid", gap: "0.75rem" }}>
      <p style={{ margin: 0, fontSize: tokens.fontSize.sm, color: tokens.color.muted }}>
        月〜金の基本時間割（科目）を登録します。日々の編集で、その日の予定が空のときに初期値として表示されます
        （確認・修正して保存すると盤面に反映）。場所や対象者は日ごとに編集してください。
      </p>
      {msg ? <output style={msg.ok ? savedTextStyle : errorTextStyle}>{msg.text}</output> : null}

      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: "3.5rem" }}>時限</th>
              {WEEKDAY_NUMBERS.map((wd) => (
                <th key={wd} style={thStyle}>
                  {WEEKDAY_LABEL[wd]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERIODS.map((p) => (
              <tr key={p}>
                <td style={{ ...tdStyle, fontWeight: 600, whiteSpace: "nowrap" }}>{p}限</td>
                {WEEKDAY_NUMBERS.map((wd) => (
                  <td key={wd} style={tdStyle}>
                    <input
                      value={grid[wd][p] ?? ""}
                      onChange={(e) => update(wd, p, e.target.value)}
                      placeholder="科目名"
                      style={{ ...inputStyle, width: "100%" }}
                      aria-label={`${WEEKDAY_LABEL[wd]}曜 ${p}限の科目名`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          style={pending || !dirty ? primaryBtnDisabledStyle : primaryBtnStyle}
        >
          {pending ? "保存中…" : "基本時間割を保存"}
        </button>
      </div>
    </section>
  );
}
