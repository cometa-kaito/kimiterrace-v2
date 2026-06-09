"use client";

import { createProvisioningJobAction } from "@/lib/tv/provisioning-actions";
import {
  WEEKDAY_LABELS,
  type TvScheduleFormState,
  formStateToScheduleInput,
} from "@/lib/tv/config-edit-core";
import Link from "next/link";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import { ProvisionProgress } from "./ProvisionProgress";

/**
 * C方式 TV プロビジョニング ジョブ作成フォーム。**Client Component** — 設置先（学校 → クラス）・TV IP・
 * ラベル・target_mac・スケジュール（既定 平日 08:00–17:00）を収集し `createProvisioningJobAction` に渡す。
 * 認可（system_admin）・検証・signage_url 発行・device 事前作成・ジョブ作成は Server Action と RLS が担保。
 * 作成後は採番 device_id / signage_url を提示し、`ProvisionProgress` でライブ進捗を表示する。
 *
 * 型は client-safe な `config-edit-core` / `@kimiterrace/db/schema` から取り、postgres を引き込まない（#148）。
 */

type SchoolOption = { id: string; name: string; prefecture: string };
type ClassOption = { id: string; name: string; schoolId: string };
type Created = { jobId: string; deviceId: string; signageUrl: string };

/** 既定スケジュール: 平日（月〜金）08:00–17:00 表示。weekdays index 0=日..6=土。 */
const DEFAULT_SCHEDULE: TvScheduleFormState = {
  enabled: true,
  onHour: "8",
  offHour: "17",
  weekdays: [false, true, true, true, true, true, false],
};

export function ProvisionForm({
  schools,
  classes,
}: {
  schools: SchoolOption[];
  classes: ClassOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const [schoolId, setSchoolId] = useState("");
  const [classId, setClassId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [targetIp, setTargetIp] = useState("");
  const [label, setLabel] = useState("");
  const [targetMac, setTargetMac] = useState("");
  const [schedule, setSchedule] = useState<TvScheduleFormState>(DEFAULT_SCHEDULE);

  // 選択中の学校のクラスのみを class セレクトに出す（school→class カスケード）。
  const schoolClasses = useMemo(
    () => classes.filter((c) => c.schoolId === schoolId),
    [classes, schoolId],
  );

  function onSchoolChange(next: string) {
    setSchoolId(next);
    setClassId(""); // 学校を変えたらクラス選択をリセット（別校のクラスが残らないように）。
  }

  function toggleWeekday(i: number) {
    setSchedule((s) => ({
      ...s,
      weekdays: s.weekdays.map((checked, idx) => (idx === i ? !checked : checked)),
    }));
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const scheduleInput = formStateToScheduleInput(schedule);
    startTransition(async () => {
      const res = await createProvisioningJobAction({
        schoolId,
        classId,
        deviceId,
        targetIp,
        label,
        targetMac,
        schedule: scheduleInput,
        monitoringEnabled: true,
      });
      if (res.ok) {
        setCreated(res.data);
      } else {
        setError(res.error.message);
      }
    });
  }

  if (created) {
    return (
      <div style={successStyle}>
        <p style={{ fontWeight: 700, margin: "0 0 0.5rem", color: "#166534" }}>
          プロビジョニングジョブを作成しました。
        </p>
        <p style={{ margin: "0 0 0.35rem", fontSize: "0.9rem" }}>
          現地の <strong>provision-agent</strong> がこのジョブを claim して adb 一連を実行します。
        </p>
        <dl style={dlStyle}>
          <dt style={dtStyle}>device_id</dt>
          <dd style={ddStyle}>
            <code style={monoStyle}>{created.deviceId}</code>
          </dd>
          <dt style={dtStyle}>signage_url</dt>
          <dd style={ddStyle}>
            <code style={monoStyle}>{created.signageUrl}</code>
          </dd>
        </dl>
        <ProvisionProgress jobId={created.jobId} />
        <div style={{ display: "flex", gap: "1rem", marginTop: "1rem", flexWrap: "wrap" }}>
          <Link href="/admin/tv-devices" style={linkBtnStyle}>
            一覧へ戻る
          </Link>
          <button type="button" onClick={() => setCreated(null)} style={linkBtnBtnStyle}>
            続けて別の TV をプロビジョン
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={formStyle}>
      {error ? <output style={{ display: "block", color: "#b91c1c" }}>{error}</output> : null}

      <label style={fieldStyle}>
        <span style={labelTextStyle}>設置先の学校 *</span>
        <select
          value={schoolId}
          onChange={(e) => onSchoolChange(e.target.value)}
          disabled={pending}
          required
          style={inputStyle}
        >
          <option value="">学校を選択してください</option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>
              {s.prefecture}／{s.name}
            </option>
          ))}
        </select>
      </label>

      <label style={fieldStyle}>
        <span style={labelTextStyle}>設置先のクラス *</span>
        <select
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          disabled={pending || schoolId === ""}
          required
          style={inputStyle}
        >
          <option value="">
            {schoolId === "" ? "先に学校を選択" : "クラスを選択してください"}
          </option>
          {schoolClasses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {schoolId !== "" && schoolClasses.length === 0 ? (
          <span style={{ color: "#b91c1c", fontSize: "0.8rem" }}>
            この学校にはクラスがありません。先にクラスを登録してください。
          </span>
        ) : null}
      </label>

      <label style={fieldStyle}>
        <span style={labelTextStyle}>TV の IP アドレス（現地 LAN、adb 接続用）</span>
        <input
          type="text"
          value={targetIp}
          onChange={(e) => setTargetIp(e.target.value)}
          disabled={pending}
          placeholder="192.168.1.50"
          style={inputStyle}
        />
      </label>

      <label style={fieldStyle}>
        <span style={labelTextStyle}>device_id（空欄で自動採番）</span>
        <input
          type="text"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          maxLength={128}
          disabled={pending}
          placeholder="工場リセット後に再生成される値を後で報告。通常は空欄"
          style={inputStyle}
        />
      </label>

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
        <span style={labelTextStyle}>県 Wi-Fi 固定 MAC（reset 安全判定の基準）</span>
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
        <legend style={labelTextStyle}>サイネージ スケジュール（既定 平日 08:00–17:00）</legend>
        <label style={checkRowStyle}>
          <input
            type="checkbox"
            checked={schedule.enabled}
            onChange={(e) => setSchedule((s) => ({ ...s, enabled: e.target.checked }))}
            disabled={pending}
          />
          <span>スケジュール表示を有効にする（OFF 時間帯はバックライト消灯）</span>
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
        <div style={weekdayGroupStyle}>
          <span style={labelTextStyle}>表示する曜日</span>
          <div style={weekdayRowStyle}>
            {WEEKDAY_LABELS.map((dayLabel, i) => {
              const checked = schedule.weekdays[i] ?? false;
              return (
                <label key={dayLabel} style={weekdayItemStyle}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleWeekday(i)}
                    disabled={pending}
                    aria-label={`${dayLabel}曜日`}
                  />
                  <span>{dayLabel}</span>
                </label>
              );
            })}
          </div>
        </div>
      </fieldset>

      <div>
        <button type="submit" disabled={pending} style={submitStyle}>
          {pending ? "ジョブ作成中…" : "プロビジョン"}
        </button>
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
const weekdayGroupStyle: React.CSSProperties = { display: "grid", gap: "0.35rem" };
const weekdayRowStyle: React.CSSProperties = { display: "flex", gap: "0.6rem", flexWrap: "wrap" };
const weekdayItemStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  fontSize: "0.85rem",
};
const submitStyle: React.CSSProperties = {
  padding: "0.5rem 1.25rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "0.4rem",
  fontWeight: 600,
  cursor: "pointer",
};
const successStyle: React.CSSProperties = {
  border: "1px solid #bbf7d0",
  background: "#f0fdf4",
  borderRadius: "0.5rem",
  padding: "1rem 1.25rem",
  maxWidth: "560px",
};
const dlStyle: React.CSSProperties = { display: "grid", gap: "0.25rem", margin: "0.5rem 0 0" };
const dtStyle: React.CSSProperties = { fontSize: "0.8rem", fontWeight: 600, color: "#374151" };
const ddStyle: React.CSSProperties = { margin: "0 0 0.4rem" };
const monoStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.82rem",
  background: "#fff",
  border: "1px solid #d1d5db",
  borderRadius: "0.4rem",
  padding: "0.3rem 0.55rem",
  userSelect: "all",
  display: "inline-block",
  wordBreak: "break-all",
};
const linkBtnStyle: React.CSSProperties = {
  color: "#1d4ed8",
  fontWeight: 600,
  textDecoration: "none",
  fontSize: "0.9rem",
};
const linkBtnBtnStyle: React.CSSProperties = {
  ...linkBtnStyle,
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 0,
};
