"use client";

import { updateTvDeviceConfigAction } from "@/lib/tv/config-edit-actions";
import type { TvSchedule } from "@kimiterrace/db/schema";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F15 §4.2 (ADR-022): TV デバイス設定編集フォーム。**Client Component** — 現在の設定を `defaultValue` と
 * してローカル state に持ち、保存時に編集可能フィールドだけを `updateTvDeviceConfigAction` に渡す。
 *
 * 認可・検証（URL 形式 / 長さ / schedule 形）・version +1・監査・cross-tenant 防止は Server Action 側
 * (`config-edit-actions.ts`) と RLS が担保するので、ここは入力収集と結果表示に徹する（薄い UI）。
 * `device_id` / `school_id` / `version` 等のシステム管理列はそもそもフォームに出さない（編集不可）。
 *
 * 型は `@kimiterrace/db/schema`（client-safe、postgres 非依存）から `TvSchedule` を import する。barrel は
 * postgres を引き込むため client へバンドルすると next build が落ちる（quiet-hours と同じ #148 の罠）。
 */

type InitialConfig = {
  label: string | null;
  targetMac: string | null;
  signageUrl: string | null;
  webhookUrl: string | null;
  schedule: TvSchedule | null;
  monitoringEnabled: boolean;
  notes: string | null;
};

/** schedule をフォーム用の素朴な編集 state に展開する（hour 入力は文字列で持ち、送信時に数値化）。 */
type ScheduleForm = {
  enabled: boolean;
  onHour: string;
  offHour: string;
};

function toScheduleForm(s: TvSchedule | null): ScheduleForm {
  return {
    enabled: s?.enabled ?? false,
    onHour: s?.onHour === undefined ? "" : String(s.onHour),
    offHour: s?.offHour === undefined ? "" : String(s.offHour),
  };
}

/** 文字列の hour 入力を 0-23 の数値 or undefined に変換（空欄は未指定）。範囲検証は Server 側に委ねる。 */
function parseHour(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function TvConfigEditForm({
  deviceRowId,
  initial,
  currentVersion,
}: {
  deviceRowId: string;
  initial: InitialConfig;
  currentVersion: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [label, setLabel] = useState(initial.label ?? "");
  const [signageUrl, setSignageUrl] = useState(initial.signageUrl ?? "");
  const [webhookUrl, setWebhookUrl] = useState(initial.webhookUrl ?? "");
  const [targetMac, setTargetMac] = useState(initial.targetMac ?? "");
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [monitoringEnabled, setMonitoringEnabled] = useState(initial.monitoringEnabled);
  const [schedule, setSchedule] = useState<ScheduleForm>(toScheduleForm(initial.schedule));

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // schedule は enabled が立っているか時刻が入っていれば送る（全て空なら null = スケジュール無し）。
    const onHour = parseHour(schedule.onHour);
    const offHour = parseHour(schedule.offHour);
    const hasSchedule = schedule.enabled || onHour !== undefined || offHour !== undefined;
    const scheduleInput: TvSchedule | null = hasSchedule
      ? {
          enabled: schedule.enabled,
          ...(onHour !== undefined ? { onHour } : {}),
          ...(offHour !== undefined ? { offHour } : {}),
        }
      : null;

    startTransition(async () => {
      const res = await updateTvDeviceConfigAction(deviceRowId, {
        label,
        signageUrl,
        webhookUrl,
        targetMac,
        notes,
        monitoringEnabled,
        schedule: scheduleInput,
      });
      if (res.ok) {
        setMsg({ ok: true, text: `保存しました（設定版 v${res.data.version}）。` });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <form onSubmit={submit} style={formStyle}>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      <label style={fieldStyle}>
        <span style={labelTextStyle}>教室ラベル</span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={200}
          disabled={pending}
          placeholder="電子工学科 1年"
          style={inputStyle}
        />
      </label>

      <label style={fieldStyle}>
        <span style={labelTextStyle}>サイネージ URL</span>
        <input
          type="url"
          value={signageUrl}
          onChange={(e) => setSignageUrl(e.target.value)}
          disabled={pending}
          placeholder="https://app.school-signage.net/?..."
          style={inputStyle}
        />
      </label>

      <label style={fieldStyle}>
        <span style={labelTextStyle}>Webhook URL</span>
        <input
          type="url"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          disabled={pending}
          placeholder="https://.../api/sensors/switchbot/webhook?key=..."
          style={inputStyle}
        />
      </label>

      <label style={fieldStyle}>
        <span style={labelTextStyle}>センサー MAC</span>
        <input
          type="text"
          value={targetMac}
          onChange={(e) => setTargetMac(e.target.value)}
          maxLength={64}
          disabled={pending}
          placeholder="DC:A5:B3:C2:98:D7"
          style={inputStyle}
        />
      </label>

      <fieldset style={fieldsetStyle}>
        <legend style={labelTextStyle}>サイネージ スケジュール</legend>
        <label style={checkRowStyle}>
          <input
            type="checkbox"
            checked={schedule.enabled}
            onChange={(e) => setSchedule((s) => ({ ...s, enabled: e.target.checked }))}
            disabled={pending}
          />
          <span>スケジュール表示を有効にする</span>
        </label>
        <div style={hourRowStyle}>
          <label style={hourFieldStyle}>
            <span style={labelTextStyle}>表示開始（時）</span>
            <input
              type="number"
              min={0}
              max={23}
              value={schedule.onHour}
              onChange={(e) => setSchedule((s) => ({ ...s, onHour: e.target.value }))}
              disabled={pending}
              style={inputStyle}
            />
          </label>
          <label style={hourFieldStyle}>
            <span style={labelTextStyle}>表示終了（時）</span>
            <input
              type="number"
              min={0}
              max={23}
              value={schedule.offHour}
              onChange={(e) => setSchedule((s) => ({ ...s, offHour: e.target.value }))}
              disabled={pending}
              style={inputStyle}
            />
          </label>
        </div>
      </fieldset>

      <label style={checkRowStyle}>
        <input
          type="checkbox"
          checked={monitoringEnabled}
          onChange={(e) => setMonitoringEnabled(e.target.checked)}
          disabled={pending}
        />
        <span>死活監視を有効にする（メンテナンス中は外す）</span>
      </label>

      <label style={fieldStyle}>
        <span style={labelTextStyle}>メモ</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={2000}
          rows={3}
          disabled={pending}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <button type="submit" disabled={pending} style={submitStyle}>
          {pending ? "保存中…" : "保存"}
        </button>
        <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>
          現在の設定版: v{currentVersion}
        </span>
      </div>
    </form>
  );
}

const formStyle: React.CSSProperties = { display: "grid", gap: "1rem", maxWidth: "560px" };
const fieldStyle: React.CSSProperties = { display: "grid", gap: "0.3rem" };
const labelTextStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "#374151",
};
const inputStyle: React.CSSProperties = {
  padding: "0.45rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.4rem",
  fontSize: "0.9rem",
};
const fieldsetStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.6rem",
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
  padding: "0.75rem",
};
const checkRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.9rem",
};
const hourRowStyle: React.CSSProperties = { display: "flex", gap: "1rem" };
const hourFieldStyle: React.CSSProperties = { display: "grid", gap: "0.3rem", maxWidth: "8rem" };
const submitStyle: React.CSSProperties = {
  padding: "0.5rem 1.25rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "0.4rem",
  fontWeight: 600,
  cursor: "pointer",
};
