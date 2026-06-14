"use client";

import { enqueueTvCommandAction } from "@/lib/tv/command-actions";
import {
  TV_COMMAND_LABELS,
  TV_COMMAND_ORDER,
  TV_COMMAND_STATUS_LABELS,
} from "@/lib/tv/command-core";
import type { TvCommandType } from "@kimiterrace/db/schema";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F15 §4.2 (ADR-022): TV リモートコマンド送信コントロール。**Client Component**。
 *
 * 「サイネージリロード」等のボタンを押すと `enqueueTvCommandAction` を呼び、pending コマンドを 1 件
 * キューイングする。実際の配信は各 TV が次回ポーリング（最大 60 秒）で pull し、実行後 ack する
 * （ポーリング型 / ADR-022、サーバ → TV へは能動接続しない）。認可・RLS・監査・cross-tenant 防止は
 * Server Action 側と RLS が担保するので、ここは送信トリガと結果表示・履歴表示に徹する（薄い UI）。
 *
 * 直近のコマンド履歴（状態つき）も表示し、送信後は `router.refresh()` で Server Component を再取得する。
 * 型 `TvCommandType` は client-safe な `@kimiterrace/db/schema`（postgres 非依存）から import する。
 */

export type RecentCommand = {
  id: string;
  command: TvCommandType;
  status: "pending" | "delivered" | "failed" | "expired";
  /** ISO 文字列（Server Component で `.toISOString()` 済み。表示は JST に整形）。 */
  issuedAt: string;
  acknowledgedAt: string | null;
};

export function TvCommandControl({
  deviceRowId,
  recent,
}: {
  deviceRowId: string;
  recent: RecentCommand[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyCommand, setBusyCommand] = useState<TvCommandType | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function send(command: TvCommandType) {
    setBusyCommand(command);
    startTransition(async () => {
      const res = await enqueueTvCommandAction(deviceRowId, command);
      if (res.ok) {
        setMsg({
          ok: true,
          text: `「${TV_COMMAND_LABELS[command]}」を送信しました。各 TV が次回ポーリング（最大 60 秒）で受信します。`,
        });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
      setBusyCommand(null);
    });
  }

  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>コマンド送信</h2>
      <p style={descStyle}>
        TV へリモートコマンドを送ります。サーバから直接 TV へは送らず、各 TV が 60
        秒ごとのポーリングで受け取り実行します。
      </p>

      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      <div style={buttonRowStyle}>
        {TV_COMMAND_ORDER.map((command) => (
          <button
            key={command}
            type="button"
            onClick={() => send(command)}
            disabled={pending}
            style={commandButtonStyle}
          >
            {pending && busyCommand === command ? "送信中…" : TV_COMMAND_LABELS[command]}
          </button>
        ))}
      </div>

      <h3 style={subHeadingStyle}>最近のコマンド</h3>
      {recent.length === 0 ? (
        <p style={emptyStyle}>まだコマンドを送信していません。</p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>このデバイスへ送信した直近のコマンド</caption>
          <thead>
            <tr>
              <th scope="col" style={thStyle}>
                コマンド
              </th>
              <th scope="col" style={thStyle}>
                状態
              </th>
              <th scope="col" style={thStyle}>
                送信
              </th>
              <th scope="col" style={thStyle}>
                受信
              </th>
            </tr>
          </thead>
          <tbody>
            {recent.map((c) => (
              <tr key={c.id}>
                <td style={tdStyle}>{TV_COMMAND_LABELS[c.command]}</td>
                <td style={tdStyle}>{TV_COMMAND_STATUS_LABELS[c.status]}</td>
                <td style={tdStyle}>{formatTime(c.issuedAt)}</td>
                <td style={tdStyle}>{c.acknowledgedAt ? formatTime(c.acknowledgedAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** ISO 文字列を JST の "M/D HH:mm" で表示。 */
function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

const sectionStyle: React.CSSProperties = {
  marginTop: "2rem",
  paddingTop: "1.5rem",
  borderTop: "1px solid #e5e7eb",
  display: "grid",
  gap: "0.75rem",
  maxWidth: "560px",
};
const headingStyle: React.CSSProperties = { fontSize: "1.05rem", fontWeight: 700, margin: 0 };
const subHeadingStyle: React.CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 600,
  margin: "0.75rem 0 0",
  color: "#374151",
};
const descStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.85rem", margin: 0 };
const emptyStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.85rem" };
const buttonRowStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.6rem" };
const commandButtonStyle: React.CSSProperties = {
  padding: "0.45rem 0.9rem",
  background: "#fff",
  color: "#1d4ed8",
  border: "1px solid #1d4ed8",
  borderRadius: "0.4rem",
  fontWeight: 600,
  fontSize: "0.85rem",
  cursor: "pointer",
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.82rem",
};
const captionStyle: React.CSSProperties = {
  textAlign: "left",
  color: "#6b7280",
  fontSize: "0.78rem",
  marginBottom: "0.4rem",
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.4rem 0.5rem",
  borderBottom: "2px solid #e5e7eb",
  fontWeight: 600,
};
const tdStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid #f3f4f6",
};
