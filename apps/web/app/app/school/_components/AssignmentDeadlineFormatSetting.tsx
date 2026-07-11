"use client";

import { saveAssignmentDeadlineFormatAction } from "@/lib/school-admin/display-settings-actions";
import {
  ASSIGNMENT_DEADLINE_FORMATS,
  ASSIGNMENT_DEADLINE_FORMAT_LABELS,
  type AssignmentDeadlineFormat,
} from "@/lib/signage/assignment-deadline-format";
import { tokens } from "@kimiterrace/ui";
import { useState, useTransition } from "react";

/**
 * サイネージ「提出物の期日表示形式」の学校別設定（#1258 教員フィードバック対応③）。**Client Component** —
 * ラジオで `daysLeft`（残り日数・既定）/ `until`（M/Dまで）を選ぶと `saveAssignmentDeadlineFormatAction` で
 * 即保存する。検証・認可・監査・RLS・相乗りキー保全は Server Action 側が担保するので、ここは選択と結果表示に
 * 徹する（BlackoutToggle と同作法。表示形式の切替は可逆で実データを消さないため確認ダイアログは挟まない）。
 * 全クラスの実機サイネージにはポーリングで反映される（最大 1 分）。
 */
export function AssignmentDeadlineFormatSetting({
  initialFormat,
}: {
  initialFormat: AssignmentDeadlineFormat;
}) {
  const [pending, startTransition] = useTransition();
  const [format, setFormat] = useState<AssignmentDeadlineFormat>(initialFormat);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function select(next: AssignmentDeadlineFormat) {
    if (pending || next === format) {
      return;
    }
    startTransition(async () => {
      const res = await saveAssignmentDeadlineFormatAction(next);
      if (res.ok) {
        setFormat(res.data.format);
        setMsg({ ok: true, text: "保存しました。各教室のサイネージに反映されます（最大 1 分）。" });
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <div style={wrapStyle}>
      <fieldset style={fieldsetStyle} disabled={pending}>
        <legend style={legendStyle}>提出物の期日表示</legend>
        {ASSIGNMENT_DEADLINE_FORMATS.map((value) => (
          <label key={value} style={optionStyle}>
            <input
              type="radio"
              name="assignment-deadline-format"
              value={value}
              checked={format === value}
              onChange={() => select(value)}
            />
            <span>{ASSIGNMENT_DEADLINE_FORMAT_LABELS[value]}</span>
          </label>
        ))}
      </fieldset>
      <p style={hintStyle}>
        サイネージ盤面「提出物」の期限の見せ方を切り替えます（例: 「あと3日」⇔「7/15まで」）。
        期限切れの「N日超過」表示と緊急色（3日以内の赤）はどちらの形式でも変わりません。
      </p>
      {msg ? (
        <output
          style={{
            display: "block",
            color: msg.ok ? tokens.color.successFg : tokens.color.dangerFg,
          }}
        >
          {msg.text}
        </output>
      ) : null}
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.5rem",
  padding: "0.85rem 1rem",
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  background: tokens.color.bgSoft,
};
const fieldsetStyle: React.CSSProperties = {
  display: "flex",
  gap: "1.25rem",
  flexWrap: "wrap",
  border: "none",
  margin: 0,
  padding: 0,
};
const legendStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  color: tokens.color.ink,
  padding: 0,
  marginBottom: "0.4rem",
};
const optionStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  fontSize: tokens.fontSize.sm,
  cursor: "pointer",
};
const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
};
