import { requireRole } from "@/lib/auth/guard";
import { TEACHER_INPUT_STAFF_ROLES } from "@/lib/teacher-input/roles";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { FileUploadForm } from "./_components/FileUploadForm";
import { TeacherInputComposer } from "./_components/TeacherInputComposer";

/**
 * F02 (#38): 教員 音声 / チャット入力 ページ `/app/teacher-input`。
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
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
        <h1 style={{ fontSize: "1.4rem", margin: "0 0 0.25rem" }}>音声 / チャット入力</h1>
        {/* 入力履歴への導線（ナビ未掲載のため発見性を確保。送信後の状況確認の受け皿）。 */}
        <Link
          href="/app/teacher-input/history"
          style={{ marginLeft: "auto", fontSize: "0.9rem", color: tokens.color.blueStrong }}
        >
          入力履歴を見る →
        </Link>
      </div>
      <p style={{ color: tokens.color.muted, margin: "0 0 1rem", fontSize: "0.9rem" }}>
        「明日 10 時から体育館で説明会」のように話しかける、または入力すると、その内容から
        編集できる掲示の草稿を作成します。草稿はエディタで確認・修正してから公開できます。
        音声は端末内で文字起こしし、サーバーには文字だけを送ります。
      </p>
      {/* UIUX-02 導線整理: サイネージに出す内容（予定/連絡/提出物）はクラスエディタの「おまかせ」が最短。
          本ページの入力は contents → RAG（生徒/教員 Q&A ボットの知識）系統であることを明示し、迷いを防ぐ。 */}
      <p
        style={{
          border: `1px solid ${tokens.color.infoBorder}`,
          background: tokens.color.infoBg,
          borderRadius: "10px",
          padding: "0.6rem 0.9rem",
          margin: "0 0 1rem",
          fontSize: "0.9rem",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="1.05em"
          height="1.05em"
          fill="none"
          stroke={tokens.color.infoFg}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ verticalAlign: "-0.2em", marginRight: "0.35rem" }}
        >
          <path d="M9 18h6M10 21h4" />
          <path d="M12 3a6 6 0 0 0-3.5 10.9c.5.4.8 1 .9 1.6h5.2c.1-.6.4-1.2.9-1.6A6 6 0 0 0 12 3z" />
        </svg>
        教室のサイネージに出す<strong>予定・連絡・提出物</strong>は、
        <Link href="/app/editor" style={{ color: tokens.color.blueStrong, fontWeight: 600 }}>
          エディタの「AI におまかせ」
        </Link>
        からまとめて作るのが最短です。このページの入力は、掲示物 Q&A
        チャットの知識（掲示コンテンツ）になります。
      </p>
      <TeacherInputComposer />
      <div style={{ marginTop: "1.5rem" }}>
        <FileUploadForm />
      </div>
    </div>
  );
}
