"use client";

import {
  MIN_TEACHER_PASSWORD_LENGTH,
  validateTeacherPasswordPolicy,
} from "@/lib/auth/teacher-password-core";
import {
  clearSchoolTeacherPasswordAction,
  setSchoolTeacherPasswordAction,
  updateSchoolAction,
} from "@/lib/system-admin/schools-actions";
import {
  HIERARCHY_MODES,
  type SchoolFieldErrors,
  collectSchoolFieldErrors,
  hasSchoolFieldErrors,
} from "@/lib/system-admin/schools-core";
import type { SchoolHierarchyMode } from "@kimiterrace/db/schema";
import { FormField } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * #48-L (#123): 学校編集フォーム。**Client Component** — `updateSchoolAction` を呼び、成功時は
 * 一覧へ戻る。認可・検証・監査は Server Action 側 (schools-actions.ts) と RLS が担保するので、
 * ここは入力収集と結果表示に徹する (HierarchyManager と同方針)。
 *
 * **項目別インライン検証 (FormField)**: 送信前に `collectSchoolFieldErrors` で項目別に検証し、エラーは
 * 各項目の下に表示する。検証規則は Server Action と同じ単一ソース。ネイティブ検証バブルと二重化しないよう
 * `noValidate` + FormField の必須印に統一する (SchoolCreateForm と同方針)。
 *
 * db 値は `@kimiterrace/db/schema` サブパスから `import type` のみで引く (#181: barrel は postgres を
 * client bundle に混入させ next build を落とす)。`HIERARCHY_MODES` は web 側 pure module の定数。
 */
type SchoolView = {
  id: string;
  name: string;
  prefecture: string;
  code: string | null;
  hierarchyMode: SchoolHierarchyMode;
  teacherLoginEnabled: boolean;
};

const MODE_LABEL: Record<SchoolHierarchyMode, string> = {
  class: "クラス制 (学年 > クラス)",
  department: "学科制 (学年 > 学科 > クラス)",
};

export function SchoolEditForm({ school }: { school: SchoolView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<SchoolFieldErrors>({});

  // 入力中はその項目のエラーを消す (修正に追従)。
  function clearError(field: keyof SchoolFieldErrors) {
    setFieldErrors((prev) => {
      if (prev[field] === undefined) {
        return prev;
      }
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const raw = { name: fd.get("name"), prefecture: fd.get("prefecture"), code: fd.get("code") };
    // クライアント側の項目別検証。エラーがあれば送信せず項目の下に表示する (Server Action と同じ規則)。
    const errors = collectSchoolFieldErrors(raw);
    if (hasSchoolFieldErrors(errors)) {
      setFieldErrors(errors);
      setMsg(null);
      return;
    }
    setFieldErrors({});
    startTransition(async () => {
      const res = await updateSchoolAction({
        id: school.id,
        ...raw,
        hierarchyMode: fd.get("hierarchyMode"),
      });
      if (res.ok) {
        setMsg({ ok: true, text: "学校情報を更新しました。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <>
      <form onSubmit={onSubmit} noValidate style={{ display: "grid", gap: "0.5rem" }}>
        {msg ? (
          <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
            {msg.text}
          </output>
        ) : null}

        <FormField label="学校名" required error={fieldErrors.name}>
          {/* required は AT に必須状態を露出する。form の noValidate でネイティブバブルは出ない。 */}
          <input
            name="name"
            required
            defaultValue={school.name}
            maxLength={200}
            style={inputStyle}
            onChange={() => clearError("name")}
          />
        </FormField>

        <FormField label="都道府県" required error={fieldErrors.prefecture}>
          <input
            name="prefecture"
            required
            defaultValue={school.prefecture}
            maxLength={32}
            style={inputStyle}
            onChange={() => clearError("prefecture")}
          />
        </FormField>

        <FormField
          label="学校コード"
          hint="任意（学校管理用の識別コード）"
          error={fieldErrors.code}
        >
          <input
            name="code"
            defaultValue={school.code ?? ""}
            maxLength={32}
            style={inputStyle}
            onChange={() => clearError("code")}
          />
        </FormField>

        <FormField label="階層モード" hint="クラス制 = 学年>クラス / 学科制 = 学年>学科>クラス">
          <select name="hierarchyMode" defaultValue={school.hierarchyMode} style={inputStyle}>
            {HIERARCHY_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </FormField>

        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <button type="submit" disabled={pending} style={btnStyle}>
            {pending ? "更新中…" : "更新する"}
          </button>
          <a href="/ops/schools" style={cancelStyle}>
            一覧へ戻る
          </a>
        </div>
      </form>
      <TeacherLoginSection schoolId={school.id} initialEnabled={school.teacherLoginEnabled} />
    </>
  );
}

/**
 * ADR-032: 学校の「教員共通パスワード」設定セクション（system_admin）。学校編集フォームとは独立した
 * mini フォーム（共通PWの設定/再設定で学校基本フィールドを巻き込まない）。設定すると共通教員ログインが
 * 有効化され、ログイン画面の教員モードでこの学校が選択可能になる。パスワードは IdP のみが保管する
 * （本DBには保存しない）。短いパスワードは総当たりに弱いため、長め・数字以外混在を推奨表示する。
 */
function TeacherLoginSection({
  schoolId,
  initialEnabled,
}: {
  schoolId: string;
  initialEnabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function onSet(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const policy = validateTeacherPasswordPolicy(password);
    if (!policy.ok) {
      setMsg({ ok: false, text: policy.message });
      return;
    }
    startTransition(async () => {
      const res = await setSchoolTeacherPasswordAction({ schoolId, password });
      if (res.ok) {
        setEnabled(true);
        setPassword("");
        setMsg({ ok: true, text: "教員共通パスワードを設定しました。教員ログインが有効です。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  function onClear() {
    if (
      !window.confirm(
        "教員共通ログインを無効化します。現在ログイン中の教員も次回からログインできなくなります。よろしいですか？",
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await clearSchoolTeacherPasswordAction({ schoolId });
      if (res.ok) {
        setEnabled(false);
        setMsg({ ok: true, text: "教員共通ログインを無効化しました。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <section style={teacherSectionStyle}>
      <h2 style={teacherHeadStyle}>教員ログイン（学校共通パスワード）</h2>
      <p style={teacherStatusStyle}>
        現在の状態:{" "}
        <strong style={{ color: enabled ? "#166534" : "#6b7280" }}>
          {enabled ? "有効" : "未設定"}
        </strong>
      </p>
      <p style={teacherHintStyle}>
        教員はこの共通パスワードのみでログインします（個別の ID 登録は不要）。 英数字
        {MIN_TEACHER_PASSWORD_LENGTH}{" "}
        文字以上で設定してください（数字のみは避け、安全のためなるべく長く）。
        パスワードは本システムには保存されず、再設定はこの欄から行います。
      </p>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}
      <form onSubmit={onSet} style={{ display: "grid", gap: "0.5rem", maxWidth: "360px" }}>
        <FormField label={enabled ? "新しい共通パスワード" : "共通パスワード"}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={MIN_TEACHER_PASSWORD_LENGTH}
            autoComplete="new-password"
            style={inputStyle}
          />
        </FormField>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
          <button type="submit" disabled={pending} style={btnStyle}>
            {pending ? "保存中…" : enabled ? "パスワードを再設定" : "設定して有効化"}
          </button>
          {enabled ? (
            <button type="button" onClick={onClear} disabled={pending} style={clearBtnStyle}>
              無効化する
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.5rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.95rem",
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
const cancelStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const teacherSectionStyle: React.CSSProperties = {
  marginTop: "2rem",
  paddingTop: "1.25rem",
  borderTop: "1px solid #e5e7eb",
};
const teacherHeadStyle: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  margin: "0 0 0.4rem",
};
const teacherStatusStyle: React.CSSProperties = { margin: "0 0 0.35rem", fontSize: "0.9rem" };
const teacherHintStyle: React.CSSProperties = {
  margin: "0 0 0.75rem",
  fontSize: "0.82rem",
  color: "#6b7280",
  lineHeight: 1.6,
};
const clearBtnStyle: React.CSSProperties = {
  padding: "0.5rem 1.1rem",
  background: "#fff",
  color: "#b91c1c",
  border: "1px solid #fca5a5",
  borderRadius: "6px",
  fontSize: "0.9rem",
  cursor: "pointer",
};
