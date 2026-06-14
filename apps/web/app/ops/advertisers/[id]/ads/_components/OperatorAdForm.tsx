"use client";

import { validateAdInput } from "@/lib/school-admin/ads-core";
import { createOperatorAdAction } from "@/lib/system-admin/operator-ads-actions";
import { adMediaType } from "@kimiterrace/db/schema";
import { FormField, useToast } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F10 / #46: 運営側広告 CRM の入稿フォーム。**Client Component** — `createOperatorAdAction` を呼ぶ。
 *
 * 対象校（scope='school'＝その校の全クラスに表示）+ 素材（メディア URL）+ 種別 + 表示秒数 + タップリンク
 * + キャプションを入力。検証は送信前に `validateAdInput`（school-admin/ads-core の単一ソース）で行い、認可・
 * 実在確認・RLS・監査は Server Action が担保する。成功で成功トースト + フォームリセット + 一覧再取得。
 */
type SchoolOption = { id: string; name: string; prefecture: string };

const MEDIA_TYPE_LABEL: Record<string, string> = { image: "画像", video: "動画" };

export function OperatorAdForm({
  advertiserId,
  schools,
}: {
  advertiserId: string;
  schools: SchoolOption[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const schoolId = fd.get("schoolId");
    if (typeof schoolId !== "string" || schoolId === "") {
      setError("表示する学校を選択してください。");
      return;
    }
    // 素材まわりの検証は Server Action と同じ単一ソース (validateAdInput) で送信前に弾く。
    const v = validateAdInput({
      mediaUrl: fd.get("mediaUrl"),
      mediaType: fd.get("mediaType"),
      durationSec: fd.get("durationSec"),
      linkUrl: fd.get("linkUrl"),
      caption: fd.get("caption"),
    });
    if (!v.ok) {
      setError(v.message);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await createOperatorAdAction({
        advertiserId,
        schoolId,
        mediaUrl: fd.get("mediaUrl"),
        mediaType: fd.get("mediaType"),
        durationSec: fd.get("durationSec"),
        linkUrl: fd.get("linkUrl"),
        caption: fd.get("caption"),
      });
      if (res.ok) {
        toast("広告を入稿しました", { tone: "success" });
        form.reset();
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate style={{ display: "grid", gap: "0.5rem" }}>
      <h2 style={headingStyle}>広告を入稿</h2>
      {error ? (
        <output role="alert" style={errorStyle}>
          {error}
        </output>
      ) : null}

      <FormField
        label="表示する学校"
        required
        hint="選んだ学校の全クラスのサイネージに表示されます"
      >
        <select name="schoolId" required defaultValue="" style={inputStyle}>
          <option value="" disabled>
            学校を選択
          </option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>
              {s.prefecture} / {s.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="メディア URL（入稿素材）" required hint="画像/動画ファイルの http(s) URL">
        <input name="mediaUrl" type="url" required placeholder="https://..." style={inputStyle} />
      </FormField>

      <FormField label="メディア種別" required>
        <select name="mediaType" defaultValue="image" style={inputStyle}>
          {adMediaType.enumValues.map((t) => (
            <option key={t} value={t}>
              {MEDIA_TYPE_LABEL[t] ?? t}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="表示秒数" required hint="1〜300 秒（動画は再生完了で次へ）">
        <input
          name="durationSec"
          type="number"
          min={1}
          max={300}
          defaultValue={30}
          style={inputStyle}
        />
      </FormField>

      <FormField label="タップ時のリンク" hint="任意。タップで開く http(s) URL">
        <input name="linkUrl" type="url" placeholder="https://..." style={inputStyle} />
      </FormField>

      <FormField label="キャプション" hint="任意。最大 60 文字">
        <input name="caption" maxLength={60} style={inputStyle} />
      </FormField>

      <div>
        <button type="submit" disabled={pending} style={btnStyle}>
          {pending ? "入稿中…" : "入稿する"}
        </button>
      </div>
    </form>
  );
}

const headingStyle: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  margin: "0 0 0.25rem",
};
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.5rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.95rem",
  fontFamily: "inherit",
};
const btnStyle: React.CSSProperties = {
  padding: "0.5rem 1.1rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  fontSize: "0.9rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = { display: "block", color: "#b91c1c", fontSize: "0.85rem" };
