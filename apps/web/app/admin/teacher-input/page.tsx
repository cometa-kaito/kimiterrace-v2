import { requireRole } from "@/lib/auth/guard";
import { TEACHER_INPUT_STAFF_ROLES } from "@/lib/teacher-input/roles";
import { FileUploadForm } from "./_components/FileUploadForm";
import { TeacherInputComposer } from "./_components/TeacherInputComposer";

/**
 * F02 (#38): 教員 音声 / チャット入力 ページ `/admin/teacher-input`。
 *
 * `/admin` 配下 (#48-C layout で認証) + 本ページで `TEACHER_INPUT_STAFF_ROLES` (teacher / school_admin)
 * に限定 (生徒 / 保護者 / system_admin は 403 → /forbidden)。teacher_inputs の RLS は role 境界を
 * 守らない (school 境界のみ) ため、role 拒否は API handler と本ページの二層で行う
 * ([[rls-tenant-not-role-boundary]] / lib/teacher-input/roles.ts と同一集合)。
 *
 * 作成は client component が `POST /api/teacher-inputs` を叩く (ADR-008)。本ページ自体は
 * データ取得を行わない (履歴一覧 FR-08 は別スライス)。nav 導線は composer の到達経路が
 * 固まってから追加する (URL 直打ち先行、#208→#217 と同じ段階適用)。
 */
export default async function TeacherInputPage() {
  await requireRole(TEACHER_INPUT_STAFF_ROLES);

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "0.25rem" }}>音声 / チャット入力</h1>
      <p style={{ color: "#6b7280", margin: "0 0 1rem", fontSize: "0.9rem" }}>
        「明日 10 時から体育館で説明会」のように話しかける、または入力すると、AI
        が日時・場所・対象・本文を整理して
        コンテンツ草稿にします。音声は端末内で文字起こしし、サーバーには文字だけを送ります。
      </p>
      <TeacherInputComposer />
      <div style={{ marginTop: "1.5rem" }}>
        <FileUploadForm />
      </div>
    </div>
  );
}
