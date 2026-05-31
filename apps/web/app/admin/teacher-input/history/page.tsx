import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { TEACHER_INPUT_STAFF_ROLES } from "@/lib/teacher-input/roles";
import { listTeacherInputs } from "@kimiterrace/db";
import Link from "next/link";
import { TeacherInputHistory } from "./_components/TeacherInputHistory";

/**
 * F02 (#38, FR-08): 教員入力の履歴一覧 `/admin/teacher-input/history`。**Server Component**。
 *
 * **認可 (ルール2 多層防御)**: `/admin` layout 認証 + 本ページで `TEACHER_INPUT_STAFF_ROLES`
 * (teacher / school_admin) に限定 (生徒 / 保護者 / system_admin は 403 → /forbidden)。
 * teacher_inputs の RLS は school 境界のみで role 境界を守らないため、role 拒否は本ページで行う
 * ([[rls-tenant-not-role-boundary]] / 作成 API・composer と同一集合)。
 *
 * **横断防止 (ルール2)**: `listTeacherInputs` は `WHERE school_id` を**書かず** RLS の tenant_isolation
 * に委ね、`withSession` の自校コンテキストで自校分のみ返す。万一 role gate を越えても RLS が 0 件化。
 *
 * **PII (ルール4)**: transcript は氏名等を含みうるが、閲覧者は自校 staff のみ。一覧では抜粋のみ表示し、
 * LLM には渡さない (表示専用)。audioPath / teacherId 等は client 表示に渡さない (最小化)。
 */
const PREVIEW_MAX = 80;

export default async function TeacherInputHistoryPage() {
  await requireRole(TEACHER_INPUT_STAFF_ROLES);

  const inputs = await withSession((tx) => listTeacherInputs(tx));
  const rows = inputs.map((input) => {
    const transcript = input.transcript ?? "";
    return {
      id: input.id,
      inputType: input.inputType,
      status: input.status,
      transcriptPreview:
        transcript.length > PREVIEW_MAX ? `${transcript.slice(0, PREVIEW_MAX)}…` : transcript,
      submitted: input.submittedAt !== null,
      createdAt: input.createdAt.toISOString(),
    };
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
        <h1 style={{ fontSize: "1.4rem", margin: "0 0 0.25rem" }}>入力履歴</h1>
        <span style={{ color: "#6b7280", fontSize: "0.9rem" }}>{rows.length} 件</span>
        <Link
          href="/admin/teacher-input"
          style={{ marginLeft: "auto", fontSize: "0.9rem", color: "#2563eb" }}
        >
          ＋新規入力
        </Link>
      </div>
      <p style={{ color: "#6b7280", margin: "0 0 1rem", fontSize: "0.9rem" }}>
        これまでに入力した連絡の一覧です（自校分のみ）。AI 整理の進捗状況を確認できます。
      </p>
      <TeacherInputHistory rows={rows} />
    </div>
  );
}
