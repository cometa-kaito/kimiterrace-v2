"use client";

import { EXPIRES_MAX_DAYS, EXPIRES_MIN_DAYS } from "@/lib/magic-link/request";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

/**
 * F05 (#41) / ADR-042: クラス magic link の発行 / 一覧 / 再表示 / 失効を行う client。
 *
 * - 発行: `POST /api/magic-links` に `{classId, expiresInDays?}` を送る。**ADR-042 D1: 既定は無期限**
 *   （`expiresInDays` 省略）。返ってきた平文 URL を表示する (コピー可 / QR 表示・印刷可)。
 * - 再表示 (ADR-042 D2): 一覧の各リンクは **平文 `token` を保持**するため、後から完全な URL
 *   （生徒 `/s/<token>` / サイネージ `/signage/<token>`）を再表示・コピーできる。token を読めるのは
 *   RLS スコープ済の system_admin（全校）/ school_admin（自校）のみ（API GET 側で保証）。
 * - 旧リンク（PR2 以前発行で token 列が NULL）は再表示不可 → 「発行時のみ」とフォールバック表示する。
 * - QR: 平文 URL を **クライアント側で** SVG にエンコードして掲示用に表示する（外部送信しない）。
 * - 失効: `POST /api/magic-links/{id}/revoke`。生きたリンクを誤って失効しないよう 2 段階確認。
 * - 期限は ISO を locale 表示。NULL（無期限）は「無期限」と表示する。
 */

/** 一覧行 (server から ISO 文字列で受ける)。 */
export type MagicLinkRow = {
  id: string;
  /**
   * ADR-042 D2: 再表示用の平文トークン。これがあれば完全な URL を再構築・コピーできる。
   * PR2 以前に発行された旧リンクは null（再表示不可・「発行時のみ」と表示）。
   */
  token?: string | null;
  /** ADR-042 D1: NULL = 無期限（永続リンク）。有限期限は ISO 文字列。 */
  expiresAt: string | null;
  createdAt: string;
  /** 非 null = 失効済 (失効履歴表示時のみ届く)。既定の一覧では失効済は除外され null。 */
  revokedAt?: string | null;
};

/**
 * 発行直後にだけ手に入る平文 URL の情報。同一トークンが 2 経路で有効:
 * - `signageUrl` (/signage/) … サイネージ表示端末で開く盤面 URL（本ページの主目的）
 * - `studentUrl` (/s/) … 生徒がスマホで開く生徒ショートリンク（→ /student）
 */
type IssuedToken = {
  id: string;
  signageUrl: string;
  studentUrl: string;
  expiresAt: string | null;
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

/** ADR-042 D1: 期限の表示。NULL（無期限）は「無期限」、有限期限は日時表示。 */
function formatExpiry(iso: string | null): string {
  return iso ? `期限 ${formatDate(iso)}` : "無期限";
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
  const [copiedWhich, setCopiedWhich] = useState<"signage" | "student" | null>(null);
  // ADR-042 D2: 一覧の各リンク行で「どの URL をコピーしたか」を `${id}:${which}` で保持し、行ごとに
  // 「コピーしました」を表示する（発行直後ブロックの copiedWhich とは独立）。
  const [copiedRow, setCopiedRow] = useState<string | null>(null);
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
    setCopiedWhich(null);

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
      const data: {
        id: string;
        path: string;
        signagePath?: string;
        token?: string;
        expiresAt: string;
      } = await res.json();
      const origin = window.location.origin;
      // サイネージ用パスは API の signagePath を優先。無ければ token / 生徒パスから導出（後方互換）。
      const signagePath =
        data.signagePath ??
        (data.token ? `/signage/${data.token}` : data.path.replace(/^\/s\//, "/signage/"));
      setIssued({
        id: data.id,
        signageUrl: `${origin}${signagePath}`,
        studentUrl: `${origin}${data.path}`,
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

  async function copyUrl(url: string, which: "signage" | "student") {
    try {
      await navigator.clipboard?.writeText(url);
      setCopiedWhich(which);
    } catch {
      setCopiedWhich(null);
    }
  }

  // ADR-042 D2: 一覧の各リンク行から完全な URL を再表示・コピーする。`key` は `${id}:${which}`。
  async function copyRowUrl(url: string, key: string) {
    try {
      await navigator.clipboard?.writeText(url);
      setCopiedRow(key);
    } catch {
      setCopiedRow(null);
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
  const copyBtnStyle = {
    marginTop: "0.4rem",
    padding: "0.3rem 0.8rem",
    borderRadius: "0.3rem",
    border: "1px solid #93c5fd",
    background: "#fff",
    cursor: "pointer",
  };
  const qrBoxStyle = {
    display: "inline-block",
    padding: "0.5rem",
    background: "#fff",
    border: "1px solid #bfdbfe",
    borderRadius: "0.3rem",
  };
  const sectionLabelStyle = {
    margin: "0 0 0.3rem",
    fontSize: "0.9rem",
    fontWeight: 600,
    color: "#1e3a8a",
  };
  const urlCodeStyle = {
    display: "block",
    wordBreak: "break-all" as const,
    fontSize: "0.9rem",
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: "0.9rem" }}>
          有効期限(日、未指定で無期限):{" "}
          <input
            type="number"
            inputMode="numeric"
            min={EXPIRES_MIN_DAYS}
            max={EXPIRES_MAX_DAYS}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            placeholder="無期限"
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
          <p style={{ margin: "0 0 0.6rem", fontWeight: 600, color: "#1e3a8a" }}>
            発行しました。以下の URL / QR は、下の「発行済みリンク」一覧から
            <strong>いつでも再表示・コピー</strong>できます。
          </p>

          {/* サイネージ端末用（本ページの主目的）。教室の表示端末のブラウザでこの URL を開く。 */}
          <section style={{ marginBottom: "1rem" }}>
            <p style={sectionLabelStyle}>
              📺 サイネージ表示用 URL（教室の表示端末でこの URL を開く）
            </p>
            <code data-testid="signage-url" style={urlCodeStyle}>
              {issued.signageUrl}
            </code>
            <button
              type="button"
              onClick={() => copyUrl(issued.signageUrl, "signage")}
              style={copyBtnStyle}
            >
              {copiedWhich === "signage" ? "コピーしました" : "サイネージURLをコピー"}
            </button>
            <div data-testid="signage-qr" style={{ marginTop: "0.5rem" }}>
              <div style={qrBoxStyle}>
                <QRCodeSVG
                  value={issued.signageUrl}
                  size={160}
                  level="M"
                  title="サイネージ表示用 URL の QR コード"
                />
              </div>
            </div>
          </section>

          {/* 生徒用。QR を掲示・配布 → 生徒のスマホで開くと掲示物 Q&A（/student）へ。 */}
          <section>
            <p style={sectionLabelStyle}>📱 生徒用リンク（QR を掲示・配布 → 生徒のスマホで開く）</p>
            <code data-testid="issued-url" style={urlCodeStyle}>
              {issued.studentUrl}
            </code>
            <button
              type="button"
              onClick={() => copyUrl(issued.studentUrl, "student")}
              style={copyBtnStyle}
            >
              {copiedWhich === "student" ? "コピーしました" : "生徒URLをコピー"}
            </button>
            <div data-testid="magic-link-qr" style={{ marginTop: "0.5rem" }}>
              <div style={qrBoxStyle}>
                <QRCodeSVG
                  value={issued.studentUrl}
                  size={160}
                  level="M"
                  title="クラス magic link の QR コード"
                />
              </div>
            </div>
          </section>

          <div style={{ marginTop: "0.75rem" }}>
            <button type="button" onClick={() => window.print()} style={copyBtnStyle}>
              QR を印刷
            </button>
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
                flexDirection: "column",
                gap: "0.5rem",
                padding: "0.6rem 0",
                borderTop: "1px solid #e5e7eb",
                fontSize: "0.9rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ color: link.revokedAt ? "#9ca3af" : "#374151" }}>
                  発行 {formatDate(link.createdAt)} /{" "}
                  {link.revokedAt
                    ? `失効 ${formatDate(link.revokedAt)}`
                    : formatExpiry(link.expiresAt)}
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
              </div>

              {/* ADR-042 D2: 再表示。token があれば完全な URL を表示・コピーできる。旧リンク(token=null)は
                  発行時のみの取得だった旨をフォールバック表示する。失効済みは URL を出さない。 */}
              {!link.revokedAt &&
                (link.token ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.4rem",
                      padding: "0.4rem 0.6rem",
                      background: "#f8fafc",
                      border: "1px solid #e2e8f0",
                      borderRadius: "0.4rem",
                    }}
                  >
                    {(
                      [
                        {
                          which: "signage",
                          label: "📺 サイネージ表示用",
                          path: `/signage/${link.token}`,
                        },
                        { which: "student", label: "📱 生徒用", path: `/s/${link.token}` },
                      ] as const
                    ).map(({ which, label, path }) => {
                      const url = `${typeof window !== "undefined" ? window.location.origin : ""}${path}`;
                      const key = `${link.id}:${which}`;
                      return (
                        <div
                          key={key}
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            style={{ fontSize: "0.8rem", color: "#475569", minWidth: "7.5rem" }}
                          >
                            {label}
                          </span>
                          <code
                            style={{
                              flex: "1 1 14rem",
                              wordBreak: "break-all",
                              fontSize: "0.8rem",
                            }}
                          >
                            {url}
                          </code>
                          <button
                            type="button"
                            onClick={() => copyRowUrl(url, key)}
                            style={{
                              padding: "0.25rem 0.6rem",
                              borderRadius: "0.3rem",
                              border: "1px solid #93c5fd",
                              background: "#fff",
                              color: "#1d4ed8",
                              cursor: "pointer",
                              fontSize: "0.8rem",
                            }}
                          >
                            {copiedRow === key ? "コピーしました" : "コピー"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: "0.8rem", color: "#9ca3af" }}>
                    このリンクは発行時のみ URL を表示できました（再発行すると再表示できます）。
                  </p>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
