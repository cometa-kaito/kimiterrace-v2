import type { ReactNode } from "react";
import styles from "./editor-board.module.css";

/**
 * 掲示エディタの「サイネージ盤面風」レイアウト枠（段B）。
 *
 * ユーザー要望 (2026-06-07):「PC ではサイネージ画面のレイアウトで表示し、そこから作成できる。
 * レスポンシブで、スマホなどはシンプルに分かり易く設定できる」。
 *
 * **表示専用のレイアウト component**（hook なし → "use client" 不要）。各セクションの編集ロジック
 * （action 呼び出し・検証・保存）は既存の ScheduleEditor / NoticeEditor / AssignmentEditor がそのまま
 * 担い、本 component はそれらを盤面風に**並べるだけ**。サイネージ表示専用 component
 * （`(signage)/.../SignageClient.tsx`）は読み取り専用で参考にし、レイアウト（予定=上段／連絡=左下／
 * 提出物=右下／広告=右）を編集画面に寄せている。
 *
 * PC（広い画面）= 盤面風グリッド（予定上段・連絡＋提出物下段・広告/天気プレビューを右）。
 * スマホ（~768px 以下）= 1 列の縦積みフォーム（CSS Module のメディアクエリで出し分け）。
 *
 * 見出し（h1 = 対象名・level など）と「戻る」リンク・対象説明は呼び出し側（page / ScopeEditorView）が
 * `header` に渡す。これにより既存 e2e の見出しセレクタ（クラス名 h1 / 「予定」「連絡」「提出物」）を
 * 壊さずに済む。
 */
export function EditorBoard({
  header,
  schedule,
  notices,
  assignments,
}: {
  header: ReactNode;
  schedule: ReactNode;
  notices: ReactNode;
  assignments: ReactNode;
}) {
  return (
    <div>
      {header}
      <div className={styles.board}>
        <div className={styles.sections}>
          <section className={`${styles.card} ${styles.scheduleCell}`}>
            <h2 className={styles.cardTitle}>予定</h2>
            {schedule}
          </section>
          <section className={`${styles.card} ${styles.noticesCell}`}>
            <h2 className={styles.cardTitle}>連絡</h2>
            {notices}
          </section>
          <section className={`${styles.card} ${styles.assignmentsCell}`}>
            <h2 className={styles.cardTitle}>提出物</h2>
            {assignments}
          </section>
        </div>

        {/* 広告・天気は編集対象外（広告は広告管理、天気は自動取得）。盤面での見え方を伝える read-only
            プレビュー枠として右に置く。PC のみ盤面風に右へ、スマホでは縦積みの末尾に落ちる。 */}
        <aside className={styles.preview} aria-label="サイネージ表示プレビュー（編集対象外）">
          <div className={styles.previewPanel}>
            <h2 className={styles.previewTitle}>広告</h2>
            <p className={styles.previewNote}>
              サイネージ右側に表示されます。ここからは編集できません（広告管理で設定）。
            </p>
            <div className={styles.adPreviewBox}>広告エリア</div>
          </div>
          <div className={styles.previewPanel}>
            <h2 className={styles.previewTitle}>天気</h2>
            <p className={styles.previewNote}>
              サイネージ上部に自動で表示されます（地域の予報。編集不要）。
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
