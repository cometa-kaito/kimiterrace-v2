"use client";

import {
  SIGNAGE_DESIGN_PATTERN_LABELS,
  type SignageDesignPattern,
  applyDesignPatternToUrl,
} from "@/lib/signage/design-pattern";
import {
  type ClassOption,
  getOrCreateClassSignageUrl,
  listClassesForSchoolAction,
} from "@/lib/tv/class-signage-actions";
import { createTvDeviceAction } from "@/lib/tv/onboarding-actions";
import type { TvSchedule } from "@kimiterrace/db/schema";
import Link from "next/link";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F15 §4.3 (ADR-022 / ADR-042 D6): TV デバイス新規登録フォーム。**Client Component** — 設置先の学校・
 * device_id・設定を収集して `createTvDeviceAction` に渡す。認可（system_admin 限定）・検証（UUID / URL 形式 /
 * SSRF / 長さ）・device_id 自動採番・監査・cross-tenant 登録の安全性は Server Action 側と RLS が担保するので、
 * ここは入力収集と結果表示に徹する（薄い UI、編集フォームと同じ規律）。
 *
 * **ADR-042 D6（クラス選択化）**: サイネージ URL を手貼りする代わりに **学校→クラスを選ぶ**だけで、サーバが
 * 当該クラスの magic-link トークンを自動発行/再利用して signageUrl 欄を充填し、ラベルもクラス名から補完する
 * （`getOrCreateClassSignageUrl` / `listClassesForSchoolAction`）。design は既定 pattern2。手貼り（URL 直接入力）
 * も後方互換で残す（モード切替）。
 *
 * 登録成功時は採番された **device_id を目立つ形で表示**する（オペレーターが TV 側に設定するため。以降は
 * 一覧から参照可）。型は `@kimiterrace/db/schema`（client-safe、postgres 非依存）から import する（barrel は
 * postgres を引き込み next build が落ちる、#148 の罠）。design ヘルパは postgres 非依存の純モジュール。
 */

type SchoolOption = { id: string; name: string; prefecture: string };

type ScheduleForm = { enabled: boolean; onHour: string; offHour: string };

/** signage URL の決め方。"class" = 学校→クラス選択で自動充填、"manual" = URL を手貼り（後方互換）。 */
type SignageMode = "class" | "manual";

/** ADR-042 D6: クラス選択は design 既定 pattern2（pattern2 = 予定/来校者/呼び出し/センサ/天気/鉄道の主盤面）。 */
const DEFAULT_CLASS_DESIGN: SignageDesignPattern = "pattern2";

/**
 * 文字列の hour 入力を 0-23 の数値 or undefined に変換（空欄・非数値は未指定扱い）。範囲検証は Server 側に
 * 委ねる。非数値で `undefined`（=未指定）を返すことで「NaN→シリアライズで null→Server で拒否」の暗黙連鎖に
 * 依存せず、意図（未指定）を明示する（PR #628 Reviewer Low-1）。
 */
function parseHour(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

type CreatedDevice = { id: string; deviceId: string };

export function TvDeviceCreateForm({ schools }: { schools: SchoolOption[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedDevice | null>(null);

  const [schoolId, setSchoolId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [label, setLabel] = useState("");
  const [signageUrl, setSignageUrl] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [targetMac, setTargetMac] = useState("");
  const [notes, setNotes] = useState("");
  const [monitoringEnabled, setMonitoringEnabled] = useState(true);
  const [schedule, setSchedule] = useState<ScheduleForm>({
    enabled: false,
    onHour: "",
    offHour: "",
  });

  // ADR-042 D6: signage URL の決め方。既定は「クラスから設定」（手往復を消す主導線）。手貼りは後方互換。
  const [signageMode, setSignageMode] = useState<SignageMode>("class");
  // クラス選択モードの状態（選択中クラス・学校に紐づくクラス一覧・連動取得中フラグ）。
  const [classId, setClassId] = useState("");
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classBusy, setClassBusy] = useState(false);

  /**
   * 学校選択時にその学校のクラス一覧を取得する（クラスモードのみ）。学校が変わったら選択中クラス・signageUrl を
   * リセットして取り違えを防ぐ。手貼りモードでは取得しない。
   *
   * `mode` は明示で受ける（既定は現在の `signageMode`）。`onChangeMode` から「クラスへ切替直後」に呼ぶ際は
   * `setSignageMode` の再レンダ前で closure の `signageMode` がまだ旧値のため、新モードを引数で渡して取り違えを防ぐ。
   */
  function onSelectSchool(nextSchoolId: string, mode: SignageMode = signageMode) {
    setSchoolId(nextSchoolId);
    setClassId("");
    setClasses([]);
    if (mode === "class") {
      setSignageUrl("");
    }
    if (mode !== "class" || !nextSchoolId) {
      return;
    }
    setError(null);
    setClassBusy(true);
    startTransition(async () => {
      const res = await listClassesForSchoolAction(nextSchoolId);
      setClassBusy(false);
      if (res.ok) {
        setClasses(res.data.classes);
      } else {
        setError(res.error.message);
      }
    });
  }

  /**
   * クラス選択時に、そのクラスの signage base URL をサーバで get-or-create し、design 既定 pattern2 を合成して
   * signageUrl 欄へ充填する。ラベルが空ならクラス名で補完する（手入力済みのラベルは尊重して上書きしない）。
   */
  function onSelectClass(nextClassId: string) {
    setClassId(nextClassId);
    if (!nextClassId) {
      setSignageUrl("");
      return;
    }
    setError(null);
    setClassBusy(true);
    startTransition(async () => {
      const res = await getOrCreateClassSignageUrl(nextClassId);
      setClassBusy(false);
      if (res.ok) {
        // base URL に design 既定 pattern2 を合成（編集フォーム保存と同じ applyDesignPatternToUrl 規約）。
        setSignageUrl(applyDesignPatternToUrl(res.data.signageUrl, DEFAULT_CLASS_DESIGN));
        const picked = classes.find((c) => c.classId === nextClassId);
        if (picked && label.trim() === "") {
          setLabel(picked.label);
        }
      } else {
        setError(res.error.message);
      }
    });
  }

  /** モード切替（クラス ⇄ 手貼り）。クラスモードへ戻る時は手貼り値の取り違えを避けるため URL をクリアする。 */
  function onChangeMode(mode: SignageMode) {
    setSignageMode(mode);
    setSignageUrl("");
    setClassId("");
    if (mode === "class" && schoolId) {
      // 既に学校選択済みならクラス一覧を取り直す（手貼りから戻った場合）。新モードを明示で渡す
      // （setSignageMode の再レンダ前で closure の signageMode はまだ旧値のため）。
      onSelectSchool(schoolId, mode);
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
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
      const res = await createTvDeviceAction({
        schoolId,
        deviceId,
        label,
        signageUrl,
        webhookUrl,
        targetMac,
        notes,
        monitoringEnabled,
        schedule: scheduleInput,
      });
      if (res.ok) {
        setCreated(res.data);
      } else {
        setError(res.error.message);
      }
    });
  }

  // 登録完了: 採番された device_id を表示し、次の操作（TV 設定 / 続けて登録）へ導く。
  if (created) {
    return (
      <div style={successStyle}>
        <p style={{ fontWeight: 700, margin: "0 0 0.5rem", color: "#166534" }}>
          TV デバイスを登録しました。
        </p>
        <p style={{ margin: "0 0 0.35rem", fontSize: "0.9rem" }}>
          この <strong>device_id</strong> を TV
          端末側に設定してください（以降は一覧から参照できます）:
        </p>
        <code style={deviceIdStyle}>{created.deviceId}</code>
        <div style={{ display: "flex", gap: "1rem", marginTop: "1rem", flexWrap: "wrap" }}>
          <Link href={`/ops/tv-devices/${created.id}/edit`} style={linkBtnStyle}>
            設定を編集
          </Link>
          <Link href="/ops/tv-devices" style={linkBtnStyle}>
            一覧へ戻る
          </Link>
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
          onChange={(e) => onSelectSchool(e.target.value)}
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

      <fieldset style={fieldsetStyle}>
        <legend style={labelTextStyle}>サイネージ URL の設定方法</legend>
        <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
          <label style={checkRowStyle}>
            <input
              type="radio"
              name="signageMode"
              checked={signageMode === "class"}
              onChange={() => onChangeMode("class")}
              disabled={pending}
            />
            <span>クラスから設定（推奨）</span>
          </label>
          <label style={checkRowStyle}>
            <input
              type="radio"
              name="signageMode"
              checked={signageMode === "manual"}
              onChange={() => onChangeMode("manual")}
              disabled={pending}
            />
            <span>または URL を直接入力</span>
          </label>
        </div>

        {signageMode === "class" ? (
          <label style={fieldStyle}>
            <span style={labelTextStyle}>クラス</span>
            <select
              value={classId}
              onChange={(e) => onSelectClass(e.target.value)}
              disabled={pending || !schoolId || classBusy}
              style={inputStyle}
            >
              <option value="">
                {schoolId ? "クラスを選択してください" : "先に学校を選択してください"}
              </option>
              {classes.map((c) => (
                <option key={c.classId} value={c.classId}>
                  {c.label}
                </option>
              ))}
            </select>
            {schoolId && !classBusy && classes.length === 0 ? (
              <span style={hintStyle}>
                この学校にはクラスがありません。先に{" "}
                <Link href={`/ops/schools/${schoolId}`} style={{ color: "#1d4ed8" }}>
                  学校の階層
                </Link>{" "}
                でクラスを作成してください。
              </span>
            ) : (
              <span style={hintStyle}>
                クラスを選ぶと、そのクラスのサイネージ URL（デザイン
                {SIGNAGE_DESIGN_PATTERN_LABELS[DEFAULT_CLASS_DESIGN]}）を自動で発行・充填します。
                既存のリンクがあれば再利用します。
              </span>
            )}
          </label>
        ) : null}
      </fieldset>

      <label style={fieldStyle}>
        <span style={labelTextStyle}>device_id（空欄で自動採番）</span>
        <input
          type="text"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          maxLength={128}
          disabled={pending}
          placeholder="TV 生成の UUID を入力、または空欄"
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
        <span style={labelTextStyle}>サイネージ URL</span>
        <input
          type="url"
          value={signageUrl}
          onChange={(e) => setSignageUrl(e.target.value)}
          // クラスモードでは自動充填の結果を読み取り専用で見せる（URL の手編集は手貼りモードで）。
          readOnly={signageMode === "class"}
          disabled={pending || (signageMode === "class" && classBusy)}
          placeholder={
            signageMode === "class"
              ? "クラスを選ぶと自動で入ります"
              : "https://app.school-signage.net/?..."
          }
          style={signageMode === "class" ? { ...inputStyle, background: "#f9fafb" } : inputStyle}
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
          {pending ? "登録中…" : "登録"}
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
const hintStyle: React.CSSProperties = { fontSize: "0.78rem", color: "#6b7280" };
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
const deviceIdStyle: React.CSSProperties = {
  display: "inline-block",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.95rem",
  background: "#fff",
  border: "1px solid #d1d5db",
  borderRadius: "0.4rem",
  padding: "0.4rem 0.7rem",
  userSelect: "all",
};
const linkBtnStyle: React.CSSProperties = {
  color: "#1d4ed8",
  fontWeight: 600,
  textDecoration: "none",
  fontSize: "0.9rem",
};
