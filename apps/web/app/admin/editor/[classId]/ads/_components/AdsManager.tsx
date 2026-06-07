"use client";

import { createAdAction, deleteAdAction, updateAdAction } from "@/lib/school-admin/ads-actions";
import {
  type ActionResult,
  type AdMediaType,
  CAPTION_FONT_SCALES,
} from "@/lib/school-admin/ads-core";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * クラス広告管理の操作 UI (#48-J)。**Client Component** — Server Actions を呼び、成功時は
 * `router.refresh()` で Server Component を再取得して一覧を更新する。認可・検証・監査・cross-tenant
 * 検証は Server Action 側 (ads-actions.ts) と RLS が担保するので、ここは入力収集と結果表示に徹する。
 *
 * 継承広告 (`inherited`) は親階層由来 (is_inherited) で**編集不可**。一覧に「継承」バッジ付きで
 * read-only 表示し、フォーム・削除ボタンを出さない (V1 の「親階層広告は編集不可」挙動)。
 */

/** 自クラス広告 1 件 (編集可能)。listClassOwnAds の戻り値と同形。 */
export type OwnAd = {
  id: string;
  mediaUrl: string;
  mediaType: AdMediaType;
  durationSec: number;
  linkUrl: string | null;
  caption: string | null;
  captionFontScale: number;
  displayOrder: number;
};

/** 継承広告 1 件 (read-only)。effective_ads_per_class の is_inherited 行から抜粋。 */
export type InheritedAd = {
  adId: string;
  sourceScope: string;
  mediaUrl: string;
  mediaType: AdMediaType;
  durationSec: number;
  caption: string | null;
  displayOrder: number;
};

const SCOPE_LABEL: Record<string, string> = {
  school: "学校",
  department: "学科",
  grade: "学年",
  class: "クラス",
};

export function AdsManager({
  scope,
  targetId,
  ownLabel,
  ownAds,
  inherited,
  showInherited = true,
}: {
  /** 編集対象のスコープ ("school"|"department"|"grade"|"class")。Server Action に渡す。 */
  scope: string;
  /** 対象 id (school は null)。Server Action に渡す。 */
  targetId: string | null;
  /** 自スコープ見出しの語 (例: "このクラス" / "この学年" / "この学科" / "学校全体")。 */
  ownLabel: string;
  ownAds: OwnAd[];
  inherited: InheritedAd[];
  /** 継承広告セクションを表示するか。クラス画面のみ true (per-class 実効ビューがあるため)。既定 true。 */
  showInherited?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 編集中の広告 id (null = 新規追加フォーム)。
  const [editing, setEditing] = useState<string | null>(null);

  function run(
    action: () => Promise<ActionResult<{ id: string }>>,
    okText: string,
    onOk?: () => void,
  ) {
    startTransition(async () => {
      const res = await action();
      if (res.ok) {
        setMsg({ ok: true, text: okText });
        onOk?.();
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  function fieldsFrom(form: HTMLFormElement) {
    const fd = new FormData(form);
    return {
      mediaUrl: fd.get("mediaUrl"),
      mediaType: fd.get("mediaType"),
      durationSec: fd.get("durationSec"),
      linkUrl: fd.get("linkUrl") || undefined,
      caption: fd.get("caption") || undefined,
      captionFontScale: fd.get("captionFontScale"),
      displayOrder: fd.get("displayOrder"),
    };
  }

  function submitCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    run(
      () => createAdAction(scope, targetId, fieldsFrom(form)),
      "広告を追加しました。",
      () => form.reset(),
    );
  }

  function submitUpdate(e: FormEvent<HTMLFormElement>, adId: string) {
    e.preventDefault();
    const form = e.currentTarget;
    run(
      () => updateAdAction(scope, targetId, adId, fieldsFrom(form)),
      "広告を更新しました。",
      () => setEditing(null),
    );
  }

  function remove(adId: string) {
    run(() => deleteAdAction(scope, targetId, adId), "広告を削除しました。");
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "720px" }}>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      {/* このクラス固有の広告 (編集可能) */}
      <section style={cardStyle}>
        <h2 style={h2Style}>
          {ownLabel}の広告 ({ownAds.length})
        </h2>
        {ownAds.length === 0 ? (
          <p style={{ color: "#6b7280", margin: "0 0 0.75rem" }}>まだ広告がありません。</p>
        ) : (
          <ul style={listStyle}>
            {ownAds.map((ad) =>
              editing === ad.id ? (
                <li key={ad.id} style={editingItemStyle}>
                  <AdForm initial={ad} pending={pending} onSubmit={(e) => submitUpdate(e, ad.id)}>
                    <button type="submit" disabled={pending} style={btnStyle}>
                      保存
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      style={ghostBtnStyle}
                      onClick={() => setEditing(null)}
                    >
                      キャンセル
                    </button>
                  </AdForm>
                </li>
              ) : (
                <li key={ad.id} style={adItemStyle}>
                  <AdSummary
                    mediaType={ad.mediaType}
                    durationSec={ad.durationSec}
                    caption={ad.caption}
                    displayOrder={ad.displayOrder}
                  />
                  <span style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      disabled={pending}
                      style={ghostBtnStyle}
                      onClick={() => setEditing(ad.id)}
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      style={dangerBtnStyle}
                      onClick={() => remove(ad.id)}
                    >
                      削除
                    </button>
                  </span>
                </li>
              ),
            )}
          </ul>
        )}

        {editing === null ? (
          <details>
            <summary style={{ cursor: "pointer", marginTop: "0.5rem" }}>広告を追加</summary>
            <AdForm pending={pending} onSubmit={submitCreate}>
              <button type="submit" disabled={pending} style={btnStyle}>
                追加
              </button>
            </AdForm>
          </details>
        ) : null}
      </section>

      {/* 上位階層から継承された広告 (read-only)。per-class 実効ビューがあるクラス画面のみ表示。 */}
      {showInherited ? (
        <section style={cardStyle}>
          <h2 style={h2Style}>継承された広告 ({inherited.length})</h2>
          <p style={{ color: "#6b7280", margin: "0 0 0.75rem", fontSize: "0.85rem" }}>
            学校 / 学科 / 学年で設定された広告です。ここでは編集できません。
          </p>
          {inherited.length === 0 ? (
            <p style={{ color: "#6b7280", margin: 0 }}>継承された広告はありません。</p>
          ) : (
            <ul style={listStyle}>
              {inherited.map((ad) => (
                <li key={ad.adId} style={adItemStyle}>
                  <AdSummary
                    mediaType={ad.mediaType}
                    durationSec={ad.durationSec}
                    caption={ad.caption}
                    displayOrder={ad.displayOrder}
                    scopeBadge={SCOPE_LABEL[ad.sourceScope] ?? ad.sourceScope}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

/** 広告 1 件の概要表示 (一覧の行)。継承分は scopeBadge を渡す。 */
function AdSummary({
  mediaType,
  durationSec,
  caption,
  displayOrder,
  scopeBadge,
}: {
  mediaType: AdMediaType;
  durationSec: number;
  caption: string | null;
  displayOrder: number;
  scopeBadge?: string;
}) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
      {scopeBadge ? <span style={badgeStyle}>{scopeBadge}継承</span> : null}
      <span style={{ fontWeight: 600 }}>{mediaType === "video" ? "動画" : "画像"}</span>
      <span style={{ color: "#6b7280" }}>表示順 {displayOrder}</span>
      <span style={{ color: "#6b7280" }}>{durationSec}秒</span>
      {caption ? <span style={{ color: "#374151" }}>「{caption}」</span> : null}
    </span>
  );
}

/** create / update 共用の広告入力フォーム。children に送信/取消ボタンを差し込む。 */
function AdForm({
  initial,
  pending,
  onSubmit,
  children,
}: {
  initial?: OwnAd;
  pending: boolean;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} style={formStyle}>
      <input
        name="mediaUrl"
        type="url"
        placeholder="メディア URL (https://...)"
        required
        defaultValue={initial?.mediaUrl}
        style={wideInputStyle}
        disabled={pending}
      />
      <select
        name="mediaType"
        defaultValue={initial?.mediaType ?? "image"}
        style={inputStyle}
        disabled={pending}
      >
        <option value="image">画像</option>
        <option value="video">動画</option>
      </select>
      <input
        name="durationSec"
        type="number"
        min={1}
        max={300}
        placeholder="表示秒数"
        defaultValue={initial?.durationSec ?? 5}
        style={narrowInputStyle}
        disabled={pending}
      />
      <select
        name="captionFontScale"
        defaultValue={String(initial?.captionFontScale ?? 1)}
        style={inputStyle}
        disabled={pending}
      >
        {CAPTION_FONT_SCALES.map((s) => (
          <option key={s} value={s}>
            文字 {s}x
          </option>
        ))}
      </select>
      <input
        name="displayOrder"
        type="number"
        min={0}
        placeholder="表示順"
        defaultValue={initial?.displayOrder ?? 0}
        style={narrowInputStyle}
        disabled={pending}
      />
      <input
        name="caption"
        placeholder="キャプション (任意, 60 文字以内)"
        maxLength={60}
        defaultValue={initial?.caption ?? ""}
        style={wideInputStyle}
        disabled={pending}
      />
      <input
        name="linkUrl"
        type="url"
        placeholder="リンク URL (任意)"
        defaultValue={initial?.linkUrl ?? ""}
        style={wideInputStyle}
        disabled={pending}
      />
      <span style={{ display: "flex", gap: "0.5rem" }}>{children}</span>
    </form>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "1rem",
};
const h2Style: React.CSSProperties = { fontSize: "1.1rem", margin: "0 0 0.5rem" };
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "0 0 0.5rem",
  padding: 0,
  display: "grid",
  gap: "0.5rem",
};
const adItemStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.5rem 0.6rem",
  border: "1px solid #f3f4f6",
  borderRadius: "6px",
};
const editingItemStyle: React.CSSProperties = {
  padding: "0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
};
const formStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
  marginTop: "0.5rem",
};
const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
};
const wideInputStyle: React.CSSProperties = { ...inputStyle, flex: "1 1 100%" };
const narrowInputStyle: React.CSSProperties = { ...inputStyle, width: "6rem" };
const btnStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  background: "#1f2937",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};
const ghostBtnStyle: React.CSSProperties = {
  padding: "0.4rem 0.8rem",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  cursor: "pointer",
};
const dangerBtnStyle: React.CSSProperties = {
  ...ghostBtnStyle,
  color: "#b91c1c",
  borderColor: "#fecaca",
};
const badgeStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  background: "#eef2ff",
  color: "#4338ca",
  padding: "0.1rem 0.4rem",
  borderRadius: "4px",
};
