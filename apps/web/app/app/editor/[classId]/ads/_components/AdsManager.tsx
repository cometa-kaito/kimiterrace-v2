"use client";

import * as adsActions from "@/lib/school-admin/ads-actions";
import {
  type ActionResult,
  type AdMediaType,
  CAPTION_FONT_SCALES,
} from "@/lib/school-admin/ads-core";
import { useRouter } from "next/navigation";
import {
  createContext,
  type FormEvent,
  useContext,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { AdThumbnail } from "@/app/_components/AdThumbnail";
import { AdMediaUpload } from "./AdMediaUpload";

/**
 * クラス広告管理の操作 UI (#48-J)。**Client Component** — Server Actions を呼び、成功時は
 * `router.refresh()` で Server Component を再取得して一覧を更新する。認可・検証・監査・cross-tenant
 * 検証は Server Action 側 (ads-actions.ts) と RLS が担保するので、ここは入力収集と結果表示に徹する。
 *
 * 継承広告 (`inherited`) は親階層由来 (is_inherited) で**編集不可**。一覧に「継承」バッジ付きで
 * read-only 表示し、フォーム・削除ボタンを出さない (V1 の「親階層広告は編集不可」挙動)。
 */

/* ------------------------------------------------------------------ *
 *  対象校スコープ (system_admin が /ops/schools/[id]/ads/[classId] から他校を編集する経路)
 *
 *  school_admin (/app/editor/[classId]/ads) は対象校 = 自校なので **schoolId を渡さない**。その場合
 *  context は undefined となり、各 action の末尾引数 `targetSchoolId` には undefined が渡る (= 自校・
 *  従来動作、回帰なし)。system_admin が `schoolId` を与えたときだけ、対象校を結ぶ (サーバ側
 *  `toAdsActor`/`withSession` が role でゲートし越境を防ぐ。hub #998/#999 と同型)。
 * ------------------------------------------------------------------ */

const TargetSchoolContext = createContext<string | undefined>(undefined);

/** 対象校 (system_admin /ops 経路) を各 Server Action の末尾引数に結んで返す。未指定なら自校 (従来)。 */
function useScopedAdsActions() {
  const schoolId = useContext(TargetSchoolContext);
  return useMemo(
    () => ({
      create: (
        scope: string,
        targetId: string | null,
        raw: Parameters<typeof adsActions.createAdAction>[2],
      ) => adsActions.createAdAction(scope, targetId, raw, schoolId),
      update: (
        scope: string,
        targetId: string | null,
        adId: string,
        raw: Parameters<typeof adsActions.updateAdAction>[3],
      ) => adsActions.updateAdAction(scope, targetId, adId, raw, schoolId),
      remove: (scope: string, targetId: string | null, adId: string) =>
        adsActions.deleteAdAction(scope, targetId, adId, schoolId),
    }),
    [schoolId],
  );
}

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

type AdsManagerProps = {
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
};

/**
 * 対象校 Context を配下へ供給する薄いラッパ。`schoolId` 指定時 (system_admin の /ops 経路) は配下の
 * `useScopedAdsActions` が各 action に対象校を結ぶ。未指定 (school_admin /app 経路) は undefined を
 * 渡すため従来と完全同一 (回帰なし)。本体 (`AdsManagerInner`) は Provider の配下で hook を呼ぶ。
 */
export function AdsManager({
  schoolId,
  ...props
}: AdsManagerProps & {
  /** system_admin が特定校を編集する /ops/schools/[id]/ads/[classId] 経路でのみ指定。未指定なら自校。 */
  schoolId?: string;
}) {
  return (
    <TargetSchoolContext.Provider value={schoolId}>
      <AdsManagerInner {...props} />
    </TargetSchoolContext.Provider>
  );
}

function AdsManagerInner({
  scope,
  targetId,
  ownLabel,
  ownAds,
  inherited,
  showInherited = true,
}: AdsManagerProps) {
  const { create, update, remove: removeAction } = useScopedAdsActions();
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
      () => create(scope, targetId, fieldsFrom(form)),
      "広告を追加しました。",
      () => form.reset(),
    );
  }

  function submitUpdate(e: FormEvent<HTMLFormElement>, adId: string) {
    e.preventDefault();
    const form = e.currentTarget;
    run(
      () => update(scope, targetId, adId, fieldsFrom(form)),
      "広告を更新しました。",
      () => setEditing(null),
    );
  }

  function remove(adId: string) {
    run(() => removeAction(scope, targetId, adId), "広告を削除しました。");
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
                    mediaUrl={ad.mediaUrl}
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
                    mediaUrl={ad.mediaUrl}
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
  mediaUrl,
  mediaType,
  durationSec,
  caption,
  displayOrder,
  scopeBadge,
}: {
  mediaUrl: string;
  mediaType: AdMediaType;
  durationSec: number;
  caption: string | null;
  displayOrder: number;
  scopeBadge?: string;
}) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
      <AdThumbnail mediaUrl={mediaUrl} mediaType={mediaType} caption={caption} size={56} />
      <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        {scopeBadge ? <span style={badgeStyle}>{scopeBadge}継承</span> : null}
        <span style={{ fontWeight: 600 }}>{mediaType === "video" ? "動画" : "画像"}</span>
        <span style={{ color: "#6b7280" }}>表示順 {displayOrder}</span>
        <span style={{ color: "#6b7280" }}>{durationSec}秒</span>
        {caption ? <span style={{ color: "#374151" }}>「{caption}」</span> : null}
      </span>
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
  // アップロード成功時にメディア URL / 種別の欄へ値を反映する（uncontrolled のまま ref で代入することで、
  // 既存の FormData 送信・form.reset() 挙動と整合させる）。
  const mediaUrlRef = useRef<HTMLInputElement>(null);
  const mediaTypeRef = useRef<HTMLSelectElement>(null);
  // 現在の素材を**実物（画像/動画）で見せる**プレビュー。編集時は initial、以降はアップロード / URL 入力 /
  // 種別変更に追従する。入力欄は uncontrolled のまま（FormData 送信・reset 挙動は不変）で、表示用にだけ state を持つ。
  const [previewUrl, setPreviewUrl] = useState(initial?.mediaUrl ?? "");
  const [previewType, setPreviewType] = useState<AdMediaType>(initial?.mediaType ?? "image");
  return (
    <form
      onSubmit={onSubmit}
      // form.reset()（新規追加の成功時に呼ばれる）でプレビューも消す。編集フォームは閉じる際に unmount される。
      onReset={() => {
        setPreviewUrl("");
        setPreviewType("image");
      }}
      style={formStyle}
    >
      <AdMediaUpload
        onUploaded={(url, mediaType) => {
          if (mediaUrlRef.current) {
            mediaUrlRef.current.value = url;
          }
          if (mediaTypeRef.current) {
            mediaTypeRef.current.value = mediaType;
          }
          setPreviewUrl(url);
          setPreviewType(mediaType);
        }}
      />
      {/* 現在の素材プレビュー（URL だけでなく実物で確認できるように）。未入力時は出さない。 */}
      {previewUrl ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flex: "1 1 100%" }}>
          <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>プレビュー</span>
          <AdThumbnail
            mediaUrl={previewUrl}
            mediaType={previewType}
            caption={initial?.caption ?? null}
            size={72}
          />
        </div>
      ) : null}
      {/* アップロードした相対パス（/ad-media/…）も受けるため type="url" にしない（type="url" は絶対 URL のみ許容で
          相対値を constraint validation で弾く・#828 Reviewer C1）。最終検証は Server Action 側 validateAdInput
          （同一オリジン相対 or http(s) 絶対）が担う。 */}
      <input
        name="mediaUrl"
        ref={mediaUrlRef}
        type="text"
        inputMode="url"
        placeholder="メディア URL（上のアップロード or https://… を直接入力）"
        required
        defaultValue={initial?.mediaUrl}
        onChange={(e) => setPreviewUrl(e.target.value)}
        style={wideInputStyle}
        disabled={pending}
      />
      <select
        name="mediaType"
        ref={mediaTypeRef}
        defaultValue={initial?.mediaType ?? "image"}
        onChange={(e) => setPreviewType(e.target.value as AdMediaType)}
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
        defaultValue={initial?.durationSec ?? 30}
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
