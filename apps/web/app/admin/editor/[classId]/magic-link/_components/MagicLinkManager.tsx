"use client";

import { EXPIRES_MAX_DAYS, EXPIRES_MIN_DAYS } from "@/lib/magic-link/request";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

/**
 * F05 (#41): クラス magic link の発行 / 一覧 / 失効を行う client。
 *
 * - 発行: `POST /api/magic-links` に `{classId, expiresInDays?}` を送り、返ってきた **1 回限りの
 *   平文 URL** を表示する (コピー可 / QR 表示・印刷可)。以降サーバーは hash しか持たず再表示不可 (ルール5)。
 * - QR: 発行直後の平文 URL を **クライアント側で** SVG にエンコードして掲示用に表示する。token は
 *   `issued.url` (既に画面表示済の値) と同一で外部送信しない (ルール4/5、URL コピーと同じ露出範囲)。
 * - 失効: `POST /api/magic-links/{id}/revoke`。生きたリンクを誤って失効しないよう 2 段階確認。
 * - 一覧の token は表示しない (メタのみ)。期限は ISO を locale 表示する。
 */

/** 一覧行 (server から ISO 文字列で受ける、token は含まない)。 */
export type MagicLinkRow = {
  id: string;
  expiresAt: string;
  createdAt: string;
  /** 非 null = 失効済 (失効履歴表示時のみ届く)。既定の一覧では失効済は除外され null。 */
  revokedAt?: string | null;
};

/** 発行直後にだけ手に入る平文 URL の情報。 */
type IssuedToken = { id: string; url: string; expiresAt: string };

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

export function MagicLinkManager({
  classId,
  initialLinks,
}: {
  classId: string;
  initialLinks: MagicLinkRow[];
}) {
  const [links, setLinks] = useState<MagicLinkRow[]>(initialLinks);
  const [expiresInDays, setExpiresInDays] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [extendingId, setExtendingId] = useState<string | null>(null);
  const [extendDays, setExtendDays] = useState("");
  const [showRevoked, setShowRevoked] = useState(false);

  async function refreshLinks(includeRevoked = showRevoked) {
    const url = `/api/magic-links?classId=${encodeURIComponent(classId)}${
      includeRevoked ? "&includeRevoked=true" : ""
    }`;
    const res = await fetch(url);
    if (!res.ok) {
      return;
    }
    const data: { links: MagicLinkRow[] } = await res.json();
    setLinks(data.links);
  }

  async function toggleRevoked() {
    const next = !showRevoked;
    setShowRevoked(next);
    await refreshLinks(next);
  }

  async function issue() {
    setError(null);
    setIssued(null);
    setCopied(false);

    const body: { classId: string; expiresInDays?: number } = { classId };
    const raw = expiresInDays.trim();
    if (raw !== "") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < EXPIRES_MIN_DAYS || n > EXPIRES_MAX_DAYS) {
        setError(
          `有効期限は ${EXPIRES_MIN_DAYS}〜${EXPIRES_MAX_DAYS} 日の整数で指定してください。`,
        );
        return;
      }
      body.expiresInDays = n;
    }

    setIssuing(true);
    try {
      const res = await fetch("/api/magic-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(`発行に失敗しました (${res.status})。`);
        return;
      }
      const data: { id: string; path: string; expiresAt: string } = await res.json();
      setIssued({
        id: data.id,
        url: `${window.location.origin}${data.path}`,
        expiresAt: data.expiresAt,
      });
      setExpiresInDays("");
      await refreshLinks();
    } catch {
      setError("ネットワークエラーが発生しました。");
    } finally {
      setIssuing(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/magic-links/${id}/revoke`, { method: "POST" });
      if (!res.ok && res.status !== 404) {
        setError(`失効に失敗しました (${res.status})。`);
        return;
      }
      // 404 は「既に失効済 / 不存在」で冪等成功扱い。いずれも一覧から除く。
      setLinks((prev) => prev.filter((l) => l.id !== id));
      if (issued?.id === id) {
        setIssued(null);
      }
    } catch {
      setError("ネットワークエラーが発生しました。");
    } finally {
      setConfirmingId(null);
    }
  }

  async function extend(id: string) {
    setError(null);
    const n = Number(extendDays.trim());
    if (
      extendDays.trim() === "" ||
      !Number.isInteger(n) ||
      n < EXPIRES_MIN_DAYS ||
      n > EXPIRES_MAX_DAYS
    ) {
      setError(`有効期限は ${EXPIRES_MIN_DAYS}〜${EXPIRES_MAX_DAYS} 日の整数で指定してください。`);
      return;
    }
    try {
      const res = await fetch(`/api/magic-links/${id}/extend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiresInDays: n }),
      });
      if (!res.ok) {
        setError(`期限の更新に失敗しました (${res.status})。`);
        return;
      }
      // サーバが返す新しい期限 (今から N 日) で該当行を差し替える。
      const data: { id: string; expiresAt: string } = await res.json();
      setLinks((prev) => prev.map((l) => (l.id === id ? { ...l, expiresAt: data.expiresAt } : l)));
      setExtendingId(null);
      setExtendDays("");
    } catch {
      setError("ネットワークエラーが発生しました。");
    }
  }

  const inputStyle = {
    width: "5rem",
    padding: "0.3rem 0.4rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.3rem",
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: "0.9rem" }}>
          有効期限(日、未指定で既定):{" "}
          <input
            type="number"
            inputMode="numeric"
            min={EXPIRES_MIN_DAYS}
            max={EXPIRES_MAX_DAYS}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            placeholder="90"
            style={inputStyle}
          />
        </label>
        <button
          type="button"
          onClick={issue}
          disabled={issuing}
          style={{
            padding: "0.5rem 1.1rem",
            borderRadius: "0.4rem",
            border: "none",
            background: issuing ? "#93c5fd" : "#2563eb",
            color: "#fff",
            cursor: issuing ? "default" : "pointer",
          }}
        >
          {issuing ? "発行中…" : "新しいリンクを発行"}
        </button>
      </div>

      {error ? (
        <p role="alert" style={{ color: "#b91c1c", fontSize: "0.9rem", marginTop: "0.5rem" }}>
          {error}
        </p>
      ) : null}

      {issued ? (
        <div
          style={{
            marginTop: "0.75rem",
            padding: "0.75rem",
            border: "1px solid #bfdbfe",
            background: "#eff6ff",
            borderRadius: "0.4rem",
          }}
        >
          <p style={{ margin: "0 0 0.4rem", fontWeight: 600, color: "#1e3a8a" }}>
            発行しました。この URL は今だけ表示されます。
          </p>
          <code
            data-testid="issued-url"
            style={{ display: "block", wordBreak: "break-all", fontSize: "0.9rem" }}
          >
            {issued.url}
          </code>
          <button
            type="button"
            onClick={() => copyUrl(issued.url)}
            style={{
              marginTop: "0.4rem",
              padding: "0.3rem 0.8rem",
              borderRadius: "0.3rem",
              border: "1px solid #93c5fd",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            {copied ? "コピーしました" : "URL をコピー"}
          </button>

          <div data-testid="magic-link-qr" style={{ marginTop: "0.75rem" }}>
            <p style={{ margin: "0 0 0.4rem", fontSize: "0.85rem", color: "#1e3a8a" }}>
              QR コード（印刷して教室に掲示できます）
            </p>
            <div
              style={{
                display: "inline-block",
                padding: "0.5rem",
                background: "#fff",
                border: "1px solid #bfdbfe",
                borderRadius: "0.3rem",
              }}
            >
              <QRCodeSVG
                value={issued.url}
                size={160}
                level="M"
                title="クラス magic link の QR コード"
              />
            </div>
            <div>
              <button
                type="button"
                onClick={() => window.print()}
                style={{
                  marginTop: "0.4rem",
                  padding: "0.3rem 0.8rem",
                  borderRadius: "0.3rem",
                  border: "1px solid #93c5fd",
                  background: "#fff",
                  cursor: "pointer",
                }}
              >
                QR を印刷
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          flexWrap: "wrap",
          margin: "1.25rem 0 0.5rem",
        }}
      >
        <h2 style={{ fontSize: "1.05rem", margin: 0 }}>発行済みリンク</h2>
        <label
          style={{
            fontSize: "0.85rem",
            color: "#374151",
            display: "flex",
            alignItems: "center",
            gap: "0.3rem",
          }}
        >
          <input type="checkbox" checked={showRevoked} onChange={toggleRevoked} />
          失効済みも表示
        </label>
      </div>
      {links.length === 0 ? (
        <p style={{ color: "#6b7280", fontSize: "0.9rem" }}>
          {showRevoked ? "リンクはありません。" : "有効なリンクはありません。"}
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {links.map((link) => (
            <li
              key={link.id}
              style={{
                display: "flex",
                gap: "0.75rem",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.5rem 0",
                borderTop: "1px solid #e5e7eb",
                fontSize: "0.9rem",
              }}
            >
              <span style={{ color: link.revokedAt ? "#9ca3af" : "#374151" }}>
                発行 {formatDate(link.createdAt)} /{" "}
                {link.revokedAt
                  ? `失効 ${formatDate(link.revokedAt)}`
                  : `期限 ${formatDate(link.expiresAt)}`}
              </span>
              {link.revokedAt ? (
                <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>失効済み</span>
              ) : extendingId === link.id ? (
                <span style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={EXPIRES_MIN_DAYS}
                    max={EXPIRES_MAX_DAYS}
                    value={extendDays}
                    onChange={(e) => setExtendDays(e.target.value)}
                    aria-label="新しい有効日数（今日から）"
                    placeholder="90"
                    style={{
                      width: "4.5rem",
                      padding: "0.3rem 0.4rem",
                      border: "1px solid #d1d5db",
                      borderRadius: "0.3rem",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => extend(link.id)}
                    style={{
                      padding: "0.3rem 0.7rem",
                      borderRadius: "0.3rem",
                      border: "none",
                      background: "#2563eb",
                      color: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    更新
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExtendingId(null);
                      setExtendDays("");
                    }}
                    style={{
                      padding: "0.3rem 0.7rem",
                      borderRadius: "0.3rem",
                      border: "1px solid #d1d5db",
                      background: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    やめる
                  </button>
                </span>
              ) : confirmingId === link.id ? (
                <span style={{ display: "flex", gap: "0.4rem" }}>
                  <button
                    type="button"
                    onClick={() => revoke(link.id)}
                    style={{
                      padding: "0.3rem 0.7rem",
                      borderRadius: "0.3rem",
                      border: "none",
                      background: "#dc2626",
                      color: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    失効する
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingId(null)}
                    style={{
                      padding: "0.3rem 0.7rem",
                      borderRadius: "0.3rem",
                      border: "1px solid #d1d5db",
                      background: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    やめる
                  </button>
                </span>
              ) : (
                <span style={{ display: "flex", gap: "0.4rem" }}>
                  <button
                    type="button"
                    onClick={() => {
                      setExtendingId(link.id);
                      setExtendDays("");
                    }}
                    style={{
                      padding: "0.3rem 0.7rem",
                      borderRadius: "0.3rem",
                      border: "1px solid #93c5fd",
                      background: "#fff",
                      color: "#1d4ed8",
                      cursor: "pointer",
                    }}
                  >
                    期限更新
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingId(link.id)}
                    style={{
                      padding: "0.3rem 0.7rem",
                      borderRadius: "0.3rem",
                      border: "1px solid #fca5a5",
                      background: "#fff",
                      color: "#b91c1c",
                      cursor: "pointer",
                    }}
                  >
                    失効
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
