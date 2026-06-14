"use client";

import {
  createSensorDeviceAction,
  updateSensorDeviceAction,
} from "@/lib/sensors/mutations-actions";
import type { ActionResult } from "@/lib/sensors/mutations-core";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F13 (#391, ADR-020): 来場検知センサーの **登録 / 編集**フォーム。**Client Component**。
 *
 * Server Actions (`createSensorDeviceAction` / `updateSensorDeviceAction`) を呼び、成功時は一覧
 * `/app/sensors` へ戻る。認可 (school_admin のみ) / 検証 / 監査 / cross-tenant / device_mac 一意衝突は
 * Server Action 側 + RLS が担保するので、ここは入力収集と結果表示に徹する (AdsManager と同方針)。
 *
 * **登録時のみ MAC を入力**できる (編集では MAC を変えない = webhook 解決キーの不変性)。設置場所ラベルは
 * **PII を入れない**旨を注記する (ADR-020 透明性要件、生徒名等を書かない)。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 各入力に `<label htmlFor>`、必須は `required`、結果メッセージは
 * `role="status"` / `role="alert"` で読み上げる。色だけに依存しない (テキストで成否を示す)。
 */

export type SensorClassOption = { id: string; name: string };

/** 編集モードの初期値 (登録モードでは undefined)。 */
export type SensorFormInitial = {
  id: string;
  /** マスク済み MAC (末尾 4 桁のみ、`maskDeviceMac` の出力)。編集では read-only 表示で MAC は変更しない。 */
  maskedMac: string;
  locationLabel: string | null;
  classId: string | null;
};

export function SensorForm({
  classes,
  initial,
}: {
  classes: SensorClassOption[];
  initial?: SensorFormInitial;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const isEdit = initial !== undefined;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const locationLabel = (fd.get("locationLabel") as string) || undefined;
    const classId = (fd.get("classId") as string) || undefined;

    startTransition(async () => {
      let res: ActionResult<{ id: string }>;
      if (isEdit) {
        res = await updateSensorDeviceAction(initial.id, { locationLabel, classId });
      } else {
        const deviceMac = (fd.get("deviceMac") as string) || undefined;
        res = await createSensorDeviceAction({ deviceMac, locationLabel, classId });
      }
      if (res.ok) {
        setMsg({ ok: true, text: isEdit ? "更新しました。" : "登録しました。" });
        // 一覧へ戻り、Server Component を再取得する。
        router.push("/app/sensors");
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} style={formStyle}>
      {isEdit ? (
        <div style={fieldStyle}>
          <span style={labelStyle}>MAC アドレス</span>
          <span style={readonlyMacStyle} title="末尾 4 桁のみ表示（擬似識別子）">
            {initial.maskedMac}
          </span>
          <span style={hintStyle}>
            MAC は webhook
            の解決キーのため変更できません。誤りがある場合は撤去のうえ再登録してください。
          </span>
        </div>
      ) : (
        <div style={fieldStyle}>
          <label htmlFor="deviceMac" style={labelStyle}>
            MAC アドレス（必須）
          </label>
          <input
            id="deviceMac"
            name="deviceMac"
            type="text"
            required
            placeholder="AA:BB:CC:DD:EE:FF"
            autoComplete="off"
            style={inputStyle}
          />
          <span style={hintStyle}>
            SwitchBot 開発者画面の
            MAC（コロン区切り・区切り無しのどちらでも可）。内部で正規化して保存します。
          </span>
        </div>
      )}

      <div style={fieldStyle}>
        <label htmlFor="locationLabel" style={labelStyle}>
          設置場所ラベル
        </label>
        <input
          id="locationLabel"
          name="locationLabel"
          type="text"
          maxLength={120}
          defaultValue={initial?.locationLabel ?? ""}
          placeholder="例: 1-A 教室前"
          style={inputStyle}
        />
        <span style={hintStyle}>
          教室名など設置場所がわかる短い名称。生徒名・保護者名などの個人を識別する情報は入力しないでください。
        </span>
      </div>

      <div style={fieldStyle}>
        <label htmlFor="classId" style={labelStyle}>
          紐づくクラス（任意）
        </label>
        <select
          id="classId"
          name="classId"
          defaultValue={initial?.classId ?? ""}
          style={inputStyle}
        >
          <option value="">（紐づけない）</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span style={hintStyle}>
          集計（クラス別ヒートマップ）でクラスに紐づけたい場合に選択します。
        </span>
      </div>

      <div style={actionsStyle}>
        <button type="submit" disabled={pending} style={submitStyle}>
          {pending ? "送信中…" : isEdit ? "更新する" : "登録する"}
        </button>
        <a href="/app/sensors" style={cancelStyle}>
          一覧へ戻る
        </a>
      </div>

      {msg ? (
        <p role={msg.ok ? "status" : "alert"} style={msg.ok ? okMsgStyle : errMsgStyle}>
          {msg.text}
        </p>
      ) : null}
    </form>
  );
}

const formStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1.1rem",
  maxWidth: "32rem",
};
const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "0.3rem" };
const labelStyle: React.CSSProperties = { fontWeight: 600, fontSize: "0.9rem" };
const inputStyle: React.CSSProperties = {
  padding: "0.45rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.4rem",
  fontSize: "0.95rem",
};
const readonlyMacStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#374151",
  padding: "0.2rem 0",
};
const hintStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.8rem", lineHeight: 1.5 };
const actionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  marginTop: "0.4rem",
};
const submitStyle: React.CSSProperties = {
  padding: "0.5rem 1.2rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "0.4rem",
  fontWeight: 600,
  cursor: "pointer",
};
const cancelStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.9rem" };
const okMsgStyle: React.CSSProperties = { color: "#065f46", fontWeight: 600 };
const errMsgStyle: React.CSSProperties = { color: "#b91c1c", fontWeight: 600 };
