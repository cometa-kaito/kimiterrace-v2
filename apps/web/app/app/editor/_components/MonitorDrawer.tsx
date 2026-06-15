"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "./MonitorDrawer.module.css";

/**
 * スマホ用ハンバーガー → 横リスト（ドロワー）— エディタ着地「実画面モニタの壁」の操作集約（PR・A）。
 *
 * 承認済みプレビュー準拠: 本体ページ（モニタの壁）はモニタのみを出し、クイック行・サマリは出さない。操作
 * （前回再開 / 全クラス一斉 / 学科まとめ出し / 各クラスへ）は本ドロワーに集約する。ドロワーは**開閉 state を
 * 持つ唯一の client island**で、本体ページは Server Component のまま（CLAUDE.md: 1 ページで PC=複数列 /
 * スマホ=3 列＋ドロワー）。
 *
 * 受け取るのはすべて **serializable** な値（Server から素通し）。クラスリンク href は親（Server）が RLS
 * スコープ済み自校階層から組み立て済みのものを渡す。前回再開は親が cookie を RLS スコープ済み階層と `===`
 * 突合してからのみ `resume` を埋める（IDOR 防止は Server 側・本 island は表示のみ）。
 */

/** ドロワーに出すクラス 1 行（学年ラベル + 本日掲示状態 + 遷移先）。 */
export type DrawerClass = {
  id: string;
  /** 「1年 1年A組」等の学年込みラベル（年度は出さない）。 */
  label: string;
  /** 本日サイネージに掲示中の中身を持つか（緑ドット / 琥珀リング）。 */
  active: boolean;
};

/** ドロワーに出す学科 1 グループ（学科名 + まとめ出し導線 + 配下クラス）。学科未割当は name=null。 */
export type DrawerDept = {
  id: string | null;
  name: string | null;
  /** この学科にまとめて出す（`/app/editor/scope/department/[id]`）。学科未割当は null（チップ非表示）。 */
  broadcastHref: string | null;
  classes: DrawerClass[];
};

export function MonitorDrawer({
  depts,
  resumeHref,
  resumeLabel,
  broadcastAllHref,
}: {
  depts: DrawerDept[];
  /** 「前回のモニタを再開」リンク先。cookie 突合に通らなければ null（行を出さない）。 */
  resumeHref: string | null;
  /** 再開ボタンに添える「学年 クラス名」（resumeHref があるときのみ）。 */
  resumeLabel: string | null;
  /** 「全クラスに一斉表示」リンク先（`/app/editor/scope/school`）。 */
  broadcastAllHref: string;
}) {
  const [open, setOpen] = useState(false);

  // 開いている間は Esc で閉じる + 背面スクロールを止める（モバイルのドロワー慣習）。
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <div className={styles.drawerScope}>
      <button
        type="button"
        className={styles.hamburger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" className={styles.hamburgerGlyph}>
          ☰
        </span>
        メニュー
      </button>

      {open ? (
        <>
          {/* 暗幕は補助の閉じ手段（aria-hidden）。閉じる主手段は閉じるボタン(button)と Esc キー。 */}
          <div className={styles.overlay} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.panel} role="dialog" aria-label="モニタ一覧メニュー">
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>モニタ一覧</h2>
              <button
                type="button"
                className={styles.closeBtn}
                aria-label="メニューを閉じる"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            <div className={styles.panelBody}>
              {resumeHref && resumeLabel ? (
                <Link
                  href={resumeHref}
                  className={styles.quickResume}
                  onClick={() => setOpen(false)}
                >
                  <span aria-hidden="true">▶</span> 前回のモニタを再開 — {resumeLabel}
                </Link>
              ) : null}
              <Link
                href={broadcastAllHref}
                className={styles.quickBroadcast}
                onClick={() => setOpen(false)}
              >
                <span aria-hidden="true">▦</span> 全クラスに一斉表示
              </Link>

              {depts.map((d) => (
                <div key={d.id ?? "__orphan__"}>
                  <div className={styles.divider} />
                  <p className={styles.deptName}>{d.name ?? "学科未割当"}</p>
                  {d.broadcastHref ? (
                    <Link
                      href={d.broadcastHref}
                      className={styles.deptBroadcast}
                      onClick={() => setOpen(false)}
                    >
                      この学科にまとめて出す →
                    </Link>
                  ) : null}
                  {d.classes.length === 0 ? (
                    <p className={styles.muted}>クラスがありません</p>
                  ) : (
                    d.classes.map((c) => (
                      <Link
                        key={c.id}
                        href={`/app/editor/${c.id}`}
                        className={styles.classRow}
                        onClick={() => setOpen(false)}
                      >
                        <span
                          className={`${styles.classRowDot} ${c.active ? styles.dotActive : styles.dotEmpty}`}
                          aria-label={c.active ? "本日表示中" : "未入力"}
                        />
                        <span className={styles.classRowLabel}>{c.label}</span>
                      </Link>
                    ))
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
