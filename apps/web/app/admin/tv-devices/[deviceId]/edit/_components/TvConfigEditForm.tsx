"use client";

import {
  DEFAULT_SIGNAGE_DESIGN_PATTERN,
  SIGNAGE_DESIGN_PATTERNS,
  SIGNAGE_DESIGN_PATTERN_LABELS,
  type SignageDesignPattern,
  applyDesignPatternToUrl,
  getDesignPatternFromUrl,
  stripDesignParam,
} from "@/lib/signage/design-pattern";
import { updateTvDeviceConfigAction } from "@/lib/tv/config-edit-actions";
import {
  type TvScheduleFormState,
  WEEKDAY_LABELS,
  formStateToScheduleInput,
  scheduleToFormState,
} from "@/lib/tv/config-edit-core";
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

export function TvConfigEditForm({
  deviceRowId,
  deviceId,
  initial,
  currentVersion,
}: {
  deviceRowId: string;
  deviceId: string;
  initial: InitialConfig;
  currentVersion: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  function copyText(text: string, key: string) {
    void navigator.clipboard?.writeText(text);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1500);
  }

  const [label, setLabel] = useState(initial.label ?? "");
  // サイネージ URL は **素の URL**（design を除いた base）をフォームに見せ、デザインは下のドロップダウンが
  // 持つ。保存時に Server Action 側で `?design=` を base に合成する（design-pattern.ts）。
  const [signageUrl, setSignageUrl] = useState(stripDesignParam(initial.signageUrl));
  const [design, setDesign] = useState<SignageDesignPattern>(
    getDesignPatternFromUrl(initial.signageUrl) ?? DEFAULT_SIGNAGE_DESIGN_PATTERN,
  );
  const [webhookUrl, setWebhookUrl] = useState(initial.webhookUrl ?? "");
  const [targetMac, setTargetMac] = useState(initial.targetMac ?? "");
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [monitoringEnabled, setMonitoringEnabled] = useState(initial.monitoringEnabled);
  const [schedule, setSchedule] = useState<TvScheduleFormState>(
    scheduleToFormState(initial.schedule),
  );

  /** 曜日チェックボックスのトグル（index 0=日..6=土）。 */
  function toggleWeekday(index: number) {
    setSchedule((s) => ({
      ...s,
      weekdays: s.weekdays.map((checked, i) => (i === index ? !checked : checked)),
    }));
  }

  // 選択中の design を素の URL に合成した「端末が実際に開く URL」。dropdown を変えると即更新され、開く/コピー
  // できる。これが無いと、URL 欄は design を含まない素の URL を表示するため、デザインを変えても見た目が変わらず
  // 「変更できていない」ように見えてしまう（保存前でも ?design は URL 側で効くのでプレビューで pattern2 を確認可）。
  const composedSignageUrl = signageUrl.trim()
    ? applyDesignPatternToUrl(signageUrl.trim(), design)
    : "";
  // クリック可能な href は **http(s) のみ**に限定する（保存時 checkEditableUrl が非 http(s) を弾くが、保存前の
  // 未検証入力が `javascript:` 等で href に載るのを防ぐ＝特権ユーザーの self-XSS 面も塞ぐ）。表示・コピーは可。
  const previewHref = /^https?:\/\//i.test(composedSignageUrl) ? composedSignageUrl : null;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 入力された表示時刻・曜日・有効フラグを送信用 TvSchedule に変換（全て空なら null = スケジュール無し）。
    // 範囲・整合の最終検証は Server Action 側 validateSchedule が行う。
    const scheduleInput: TvSchedule | null = formStateToScheduleInput(schedule);

    startTransition(async () => {
      const res = await updateTvDeviceConfigAction(deviceRowId, {
        label,
        signageUrl,
        webhookUrl,
        targetMac,
        notes,
        monitoringEnabled,
        schedule: scheduleInput,
        design,
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

      <div style={fieldStyle}>
        <span style={labelTextStyle}>
          デバイス ID（編集不可・プロビジョニング/設定でコピーして使用）
        </span>
        <div style={copyRowStyle}>
          <code style={codeStyle}>{deviceId}</code>
          <button type="button" onClick={() => copyText(deviceId, "deviceId")} style={copyBtnStyle}>
            {copied === "deviceId" ? "コピー済 ✓" : "コピー"}
          </button>
        </div>
      </div>

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
        <span style={labelTextStyle}>サイネージ デザイン</span>
        <select
          value={design}
          onChange={(e) => setDesign(e.target.value as SignageDesignPattern)}
          disabled={pending}
          style={inputStyle}
        >
          {SIGNAGE_DESIGN_PATTERNS.map((p) => (
            <option key={p} value={p}>
              {SIGNAGE_DESIGN_PATTERN_LABELS[p]}
            </option>
          ))}
        </select>
        <span style={hintStyle}>
          この TV デバイスの盤面デザイン。各 TV は保存後の次回ポーリング（最大 60
          秒以内）で切り替わります。 下の「配信される
          URL」で、選択中デザインのプレビューを開けます。
        </span>
      </label>

      {composedSignageUrl ? (
        <div style={fieldStyle}>
          <span style={labelTextStyle}>配信される URL（端末が実際に開く URL）</span>
          <input
            type="text"
            readOnly
            value={composedSignageUrl}
            onFocus={(e) => e.currentTarget.select()}
            style={{ ...inputStyle, background: "#f9fafb" }}
          />
          <span style={hintStyle}>
            選択中のデザインを反映した URL です（パターン2 は <code>?design=pattern2</code>{" "}
            が付きます）。 動作確認はこの URL を開いてください（上の「サイネージ URL」欄は design
            を含まない素の URL）。{" "}
            {previewHref ? (
              <a
                href={previewHref}
                target="_blank"
                rel="noopener noreferrer"
                style={previewLinkStyle}
              >
                プレビューを開く ↗
              </a>
            ) : (
              <span style={{ color: "#b91c1c" }}>（プレビューは http(s) の URL のみ開けます）</span>
            )}{" "}
            <button
              type="button"
              onClick={() => copyText(composedSignageUrl, "composed")}
              style={inlineBtnStyle}
            >
              {copied === "composed" ? "コピーしました ✓" : "URL をコピー"}
            </button>
          </span>
        </div>
      ) : null}

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
        <div style={weekdayGroupStyle}>
          <span style={labelTextStyle}>表示する曜日</span>
          <div style={weekdayRowStyle}>
            {WEEKDAY_LABELS.map((dayLabel, i) => {
              const checked = schedule.weekdays[i] ?? false;
              return (
                <label
                  key={dayLabel}
                  style={{ ...weekdayItemStyle, ...(checked ? weekdayItemCheckedStyle : {}) }}
                >
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
          <span style={hintStyle}>
            未選択 / 全選択はどちらも「毎日」表示です（特定曜日だけ選ぶと、その曜日のみ表示）。
          </span>
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
const previewLinkStyle: React.CSSProperties = { color: "#2563eb", fontWeight: 600 };
const inlineBtnStyle: React.CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: "0.3rem",
  background: "#fff",
  padding: "0.1rem 0.5rem",
  fontSize: "0.8rem",
  cursor: "pointer",
};
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
const hourRowStyle: React.CSSProperties = { display: "flex", gap: "1rem", flexWrap: "wrap" };
const hourFieldStyle: React.CSSProperties = { display: "grid", gap: "0.3rem", maxWidth: "8rem" };
const weekdayGroupStyle: React.CSSProperties = { display: "grid", gap: "0.4rem" };
const weekdayRowStyle: React.CSSProperties = { display: "flex", gap: "0.4rem", flexWrap: "wrap" };
const weekdayItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.3rem 0.55rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.4rem",
  fontSize: "0.85rem",
  cursor: "pointer",
  userSelect: "none",
};
const weekdayItemCheckedStyle: React.CSSProperties = {
  borderColor: "#1d4ed8",
  background: "#eff6ff",
  color: "#1e3a8a",
  fontWeight: 600,
};
const hintStyle: React.CSSProperties = { fontSize: "0.78rem", color: "#6b7280" };
const copyRowStyle: React.CSSProperties = { display: "flex", gap: "0.5rem", alignItems: "center" };
const codeStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: "monospace",
  fontSize: "0.85rem",
  background: "#f3f4f6",
  padding: "0.35rem 0.5rem",
  borderRadius: "4px",
  userSelect: "all",
  overflowWrap: "anywhere",
};
const copyBtnStyle: React.CSSProperties = {
  padding: "0.35rem 0.7rem",
  borderRadius: "4px",
  border: "1px solid #d1d5db",
  background: "#fff",
  cursor: "pointer",
  fontSize: "0.8rem",
  whiteSpace: "nowrap",
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
