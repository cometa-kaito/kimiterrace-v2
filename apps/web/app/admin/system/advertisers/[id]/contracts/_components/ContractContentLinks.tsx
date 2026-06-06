"use client";

import {
  linkContentToContractAction,
  unlinkContentFromContractAction,
} from "@/lib/system-admin/contract-contents-actions";
import { ConfirmDialog, useToast } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F10 (#46): 1 契約に紐付いた出稿コンテンツの一覧 + 追加 (link) + 解除 (unlink)。**Client Component**。
 *
 * **system_admin 限定**: 表示するページ自体が `requireRole(SYSTEM_ADMIN_ROLES)` 配下なので本コンポーネントは
 * system_admin にしか描画されない。認可・検証・重複 (conflict)・監査・RLS WITH CHECK は Server Action が
 * 担保するので、ここは入力収集と結果表示・refresh に徹する (ContractCreateForm と同方針)。
 *
 * **アクセシビリティ (NFR05 色非依存)**: 解除ボタンはテキスト「解除」+ aria-label を持ち、状態は色だけで
 * 表さない。エラーは `output` でテキスト表示する。
 *
 * **コンテンツ指定**: MVP ではコンテンツ ID (UUID) 直接入力。実在 / 可視性は Server Action 側で
 * FK / RLS が検証する (検索ピッカー UI は後続スライス)。
 */

/** 親 (page.tsx server component) が RLS 経由で取得した紐付け 1 行 (LinkedContent と同型のプレーン)。 */
export type LinkedContentItem = {
  linkId: string;
  contentId: string;
  title: string;
  schoolId: string;
};

export function ContractContentLinks({
  contractId,
  advertiserId,
  links,
}: {
  contractId: string;
  advertiserId: string;
  links: readonly LinkedContentItem[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // 解除対象の紐付け (確認ダイアログ用)。null で未表示。
  const [confirmUnlink, setConfirmUnlink] = useState<{ linkId: string; title: string } | null>(
    null,
  );

  function onLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setError(null);
    startTransition(async () => {
      const res = await linkContentToContractAction({
        contractId,
        contentId: fd.get("contentId"),
        advertiserId,
      });
      if (res.ok) {
        form.reset();
        toast("出稿コンテンツを紐付けました", { tone: "success" });
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  function runUnlink(linkId: string, title: string) {
    setError(null);
    startTransition(async () => {
      const res = await unlinkContentFromContractAction({ linkId, advertiserId });
      // 成否いずれもダイアログは閉じる (失敗はインラインの error 表示に集約)。
      setConfirmUnlink(null);
      if (res.ok) {
        toast(`「${title}」の紐付けを解除しました`, { tone: "success" });
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  return (
    <div style={wrapStyle}>
      <h3 style={headingStyle}>出稿コンテンツ</h3>
      {error ? <output style={errorStyle}>{error}</output> : null}

      {links.length === 0 ? (
        <p style={mutedStyle}>紐付いた出稿コンテンツはありません。</p>
      ) : (
        <ul style={listStyle}>
          {links.map((l) => (
            <li key={l.linkId} style={itemStyle}>
              <span style={{ flex: 1 }}>{l.title}</span>
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmUnlink({ linkId: l.linkId, title: l.title })}
                aria-label={`${l.title} の紐付けを解除`}
                style={unlinkBtnStyle}
              >
                解除
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onLink} style={formStyle}>
        <label style={labelStyle}>
          コンテンツ ID（UUID）を入力して紐付け
          <input
            name="contentId"
            type="text"
            required
            placeholder="00000000-0000-0000-0000-000000000000"
            style={inputStyle}
          />
        </label>
        <button type="submit" disabled={pending} style={linkBtnStyle}>
          {pending ? "処理中…" : "紐付ける"}
        </button>
      </form>

      <ConfirmDialog
        open={confirmUnlink !== null}
        tone="danger"
        title={confirmUnlink ? `「${confirmUnlink.title}」の紐付けを解除しますか？` : ""}
        confirmLabel="解除する"
        pending={pending}
        onConfirm={() => {
          if (confirmUnlink) {
            runUnlink(confirmUnlink.linkId, confirmUnlink.title);
          }
        }}
        onCancel={() => setConfirmUnlink(null)}
      />
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  padding: "0.75rem",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  background: "#fafafa",
};
const headingStyle: React.CSSProperties = { fontSize: "0.95rem", fontWeight: 600, margin: 0 };
const mutedStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.85rem", margin: 0 };
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};
const itemStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.6rem",
  alignItems: "center",
  fontSize: "0.88rem",
  color: "#111827",
};
const formStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.6rem",
  alignItems: "flex-end",
  flexWrap: "wrap",
};
const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.3rem",
  fontSize: "0.8rem",
  color: "#374151",
  flex: 1,
  minWidth: "16rem",
};
const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.55rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.9rem",
  fontFamily: "inherit",
};
const linkBtnStyle: React.CSSProperties = {
  padding: "0.45rem 1rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  fontSize: "0.85rem",
  cursor: "pointer",
};
const unlinkBtnStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  background: "#fff",
  color: "#b91c1c",
  border: "1px solid #fecaca",
  borderRadius: "6px",
  fontSize: "0.8rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = { display: "block", color: "#b91c1c", fontSize: "0.8rem" };
