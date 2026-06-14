"use client";

import {
  createClassAction,
  createDepartmentAction,
  createGradeAction,
  deleteClassAction,
  deleteDepartmentAction,
  deleteGradeAction,
  duplicateClassesToNextYearAction,
  reorderHierarchyAction,
  updateClassAction,
  updateDepartmentAction,
  updateGradeAction,
} from "@/lib/school-admin/hub-actions";
import type { ActionResult } from "@/lib/school-admin/hub-core";
import type { SchoolHierarchy } from "@/lib/school-admin/hub-queries";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import styles from "./hierarchy-manager.module.css";

/**
 * 学校管理者ハブの階層 CRUD UI (#48-K / #48-K2 / #48-K3 UI再設計)。**Client Component**・**ツリー表示**。
 *
 * 「学科 → 学年 → クラス」を入れ子で管理する。各ノードの操作 (名称編集 / モード切替 / 削除) は
 * 行末の `⋯` メニューに集約し、平常時の視覚ノイズを抑える。削除は **restrict**（配下があれば不可・
 * ガード表示／配下が空のときだけ確認のうえ削除）。要整理（学科未所属の学年）は `学科へ移動` セレクトで
 * 解消できる。一括追加は `一括操作` に畳む。
 *
 * 学年は `hasClasses` で 2 通り:
 * - **クラス単位** (`hasClasses=true`): 1組・2組… を持つ。
 * - **学年単位** (`hasClasses=false`): 組に分けず学年そのものが 1 表示単位。エディタ/サイネージ/QR は
 *   クラス基準のため、学年単位でも学年名と同名の「裏方クラス」を 1 つ持つ。
 *
 * 認可・検証・cross-tenant・監査・RLS は Server Action 側 + RLS が担保し、本コンポーネントは入力収集と
 * `router.refresh()` に徹する。配色は 3 色（ウォームグレー基調 + ブランドのオレンジ + 削除の赤）。
 */

type Result = ActionResult<{ id: string }>;
type Reporter = (res: Result, okMsg: string) => void;
type Dept = SchoolHierarchy["departments"][number];
type Grade = SchoolHierarchy["grades"][number];
type Cls = Grade["classes"][number];

/**
 * 学年名から学年数（1-12）を推定する（例:「電子工学科3年」→ 3 / 「1年」→ 1）。クラスの `grade` 列は
 * 並び替え用で、ツリーの親（学年）と情報が重複するため UI では入力させず親の学年名から導出する。
 * 推定不可（数字なし等）は 1 にフォールバック。
 */
function deriveGradeNumber(gradeName: string): number {
  const m = gradeName.match(/(\d+)\s*年/) ?? gradeName.match(/\d+/);
  const n = m ? Number(m[0].replace(/\D/g, "")) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
}

export function HierarchyManager({
  hierarchy,
  statusByClass = {},
}: {
  hierarchy: SchoolHierarchy;
  statusByClass?: Record<string, boolean>;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const { departments, grades } = hierarchy;
  const hasDepartments = departments.length > 0;

  const notify = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    if (ok) {
      router.refresh();
    }
  };
  const report: Reporter = (res, okMsg) =>
    res.ok ? notify(true, okMsg) : notify(false, res.error.message);

  // 表示順の並べ替え。学科（トップレベル）と、学科なし校のトップレベル学年。永続化は単一の原子的アクション。
  const deptRowProps = useSiblingReorder(
    departments,
    (orderedIds) => reorderHierarchyAction({ entity: "department", orderedIds }),
    "学科",
    report,
  );
  const topGradeRowProps = useSiblingReorder(
    grades,
    (orderedIds) => reorderHierarchyAction({ entity: "grade", orderedIds }),
    "学年",
    report,
  );

  const gradesOf = (deptId: string | null) => grades.filter((g) => g.departmentId === deptId);
  const orphanGrades = grades.filter((g) => !g.departmentId);
  const isEmpty = !hasDepartments && grades.length === 0;
  const allYears = grades.flatMap((g) => g.classes.map((c) => c.academicYear));
  const currentYear = allYears.length > 0 ? Math.max(...allYears) : null;

  return (
    <div style={pageStyle}>
      <div style={headerRowStyle}>
        <h1 style={h1Style}>学校管理</h1>
        {!isEmpty ? (
          <button type="button" style={toolbarBtnStyle} onClick={() => setBulkOpen((v) => !v)}>
            一括操作 <span aria-hidden>{bulkOpen ? "▴" : "▾"}</span>
          </button>
        ) : null}
      </div>

      {msg ? (
        <output style={{ ...msgStyle, color: msg.ok ? C.teal : C.danger }}>{msg.text}</output>
      ) : null}

      <p style={hintStyle}>
        「学科 → 学年 →
        クラス」で校内の構成を管理します。学年は組に分けても、学年そのものを掲示単位に
        してもかまいません。
      </p>

      {bulkOpen ? (
        <div style={bulkPanelStyle}>
          {hasDepartments ? <BulkAddYears departments={departments} report={report} /> : null}
          <NextYearCopy currentYear={currentYear} notify={notify} />
        </div>
      ) : null}

      {isEmpty ? (
        <EmptyState report={report} />
      ) : hasDepartments ? (
        <>
          <div style={treeRootStyle}>
            {departments.map((d, i) => (
              <DepartmentNode
                key={d.id}
                dept={d}
                grades={gradesOf(d.id)}
                statusByClass={statusByClass}
                reorder={deptRowProps(i)}
                report={report}
              />
            ))}
          </div>
          {orphanGrades.length > 0 ? (
            <OrphanBox orphans={orphanGrades} departments={departments} report={report} />
          ) : null}
          <AddDepartmentForm report={report} />
        </>
      ) : (
        <>
          <div style={treeRootStyle}>
            {grades.map((g, i) => (
              <GradeNode
                key={g.id}
                grade={g}
                statusByClass={statusByClass}
                reorder={topGradeRowProps(i)}
                report={report}
              />
            ))}
          </div>
          <AddGradeForm report={report} />
          <p style={hintStyle}>学科制にすると「学科 → 学年 → クラス」の3階層で管理できます。</p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  行末メニュー（⋯）— 名称編集 / モード切替 / 削除 を集約
 * ------------------------------------------------------------------ */

type MenuItem = { label: string; danger?: boolean; onSelect: () => void };

/* ------------------------------------------------------------------ *
 *  表示順の並べ替え（学科 / 学年）— ドラッグ&ドロップ + ⋯メニューの「上へ/下へ移動」
 *
 *  クラスは並べ替え列（displayOrder）を持たないため対象外（schema 凍結）。並べ替えは兄弟集合
 *  （同一学科配下の学年 / 学科 / 学科なし校の学年）を 0..n-1 に**正規化**して該当ノードだけ
 *  updateDepartmentAction / updateGradeAction で永続化する（既存の displayOrder の重複/抜けも自己修復）。
 *  キーボード経路は ⋯メニューの「上へ/下へ移動」（D&D は HTML5 dragging、タッチ/キーボードはメニュー）。
 * ------------------------------------------------------------------ */

/** 1 行ぶんの並べ替えハンドル（グリップの drag props・ドロップ先 props・上下移動・現在のドラッグ状態）。 */
type RowReorder = {
  canUp: boolean;
  canDown: boolean;
  isDragging: boolean;
  isOver: boolean;
  onMove: (dir: -1 | 1) => void;
  handleProps: {
    draggable: boolean;
    onDragStart: () => void;
    onDragEnd: () => void;
  };
  dropProps: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
};

/**
 * 兄弟ノードの表示順並べ替えを司るフック。`rowProps(index)` を各行へ渡す。`move` は配列を組み替え、
 * 並び替え後の **id 列を 1 アクション (`reorder`) に渡して単一 tx で原子的に**反映する（途中失敗で
 * 半端な並びにならない・往復/refresh は 1 回）。並べ替え中（pending）は二重操作を防ぐためドラッグ/移動を
 * 無効化する。`reorder` の戻りは ActionResult<{count}> で、UI 表示には ok/エラーのみ使う。
 */
function useSiblingReorder<T extends { id: string; displayOrder: number }>(
  siblings: T[],
  reorder: (orderedIds: string[]) => Promise<ActionResult<{ count: number }>>,
  noun: string,
  report: Reporter,
): (index: number) => RowReorder {
  const [pending, start] = useTransition();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const move = (from: number, to: number) => {
    if (pending || from === to || to < 0 || to >= siblings.length) {
      return;
    }
    const next = siblings.slice();
    const [moved] = next.splice(from, 1);
    if (!moved) {
      return;
    }
    next.splice(to, 0, moved);
    start(async () => {
      const res = await reorder(next.map((s) => s.id));
      // report は Result（{id}）形を取るため、成功時はダミー id に畳んで写像する（data は UI 未使用）。
      report(res.ok ? { ok: true, data: { id: "" } } : res, `${noun}の表示順を更新しました。`);
    });
  };

  return (index: number): RowReorder => ({
    canUp: index > 0,
    canDown: index < siblings.length - 1,
    isDragging: dragIndex === index,
    isOver: overIndex === index && dragIndex !== null && dragIndex !== index,
    onMove: (dir) => move(index, index + dir),
    handleProps: {
      draggable: !pending,
      onDragStart: () => setDragIndex(index),
      onDragEnd: () => {
        setDragIndex(null);
        setOverIndex(null);
      },
    },
    dropProps: {
      onDragOver: (e) => {
        if (dragIndex !== null) {
          e.preventDefault();
          setOverIndex(index);
        }
      },
      onDragLeave: () => setOverIndex((cur) => (cur === index ? null : cur)),
      onDrop: (e) => {
        e.preventDefault();
        if (dragIndex !== null) {
          move(dragIndex, index);
        }
        setDragIndex(null);
        setOverIndex(null);
      },
    },
  });
}

/** ドラッグ中ノードは半透明・ドロップ先候補は上辺にオレンジの差し込み線でヒントする。 */
function nodeDragStyle(r?: RowReorder): React.CSSProperties {
  if (!r) {
    return {};
  }
  if (r.isDragging) {
    return draggingNodeStyle;
  }
  if (r.isOver) {
    return dropOverStyle;
  }
  return {};
}

/**
 * 行末の操作メニュー（WAI-ARIA menu button パターン）。Tab だけでなく**矢印キーで項目移動**できる:
 * 開くと先頭項目へフォーカス → ↑↓ で巡回（端で巻き戻し）/ Home・End で先頭末尾 / Esc で閉じてトリガへ
 * フォーカスを戻す / Tab はメニューを閉じて自然なフォーカス移動に委ねる。トリガは ↓ / Enter / Space で開く。
 */
function RowMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 開いたら先頭項目へフォーカスを移す（マウスでもキーボードでも一貫させる）。
  useEffect(() => {
    if (open) {
      itemRefs.current[0]?.focus();
    }
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  };

  // menuitem 上でのキー操作。フォーカス中の項目を基点に巡回する。
  function onItemKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const count = items.length;
    if (count === 0) {
      return;
    }
    // currentTarget = キーを受けた menuitem 自身（フォーカス中の項目）。これを基点に巡回する。
    const current = itemRefs.current.indexOf(e.currentTarget);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      itemRefs.current[(current + 1 + count) % count]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      itemRefs.current[(current - 1 + count) % count]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      itemRefs.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      itemRefs.current[count - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      // 自然なフォーカス移動に任せる（トリガには戻さない）。
      close(false);
    }
  }

  // トリガ上で ↓ / Enter / Space は開いて先頭項目へ（クリックと同じ入口をキーボードにも用意）。
  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  }

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        style={iconBtnStyle}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        <span aria-hidden style={{ fontSize: "1.05rem", lineHeight: 1 }}>
          ⋯
        </span>
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            style={overlayStyle}
            onClick={() => close(false)}
          />
          <span role="menu" aria-label={label} style={menuStyle}>
            {items.map((it, i) => (
              <button
                type="button"
                role="menuitem"
                key={it.label}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                style={{ ...menuItemStyle, color: it.danger ? C.danger : C.inkSecondary }}
                onClick={() => {
                  close(true);
                  it.onSelect();
                }}
                onKeyDown={onItemKeyDown}
              >
                {it.label}
              </button>
            ))}
          </span>
        </>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 *  葉（クラス / 学年単位）の本日状態 + エディタ導線 (#48-K3 PR2)
 * ------------------------------------------------------------------ */

/**
 * 本日(JST)サイネージに掲示中かの状態。active=今日サイネージに出る予定/連絡/提出物あり (昨日以前に入れた
 * 複数日連絡・期限内の提出物も含む、hub-queries の遡及窓判定に整合) → ティールの「公開中」。なければ
 * 「本日 掲示なし」(入力が無い、または表示期間が過ぎて今日は何も出ていない)。
 */
function StatusDot({ active }: { active: boolean }) {
  if (active) {
    return (
      <span style={statusActiveStyle}>
        <span style={dotFilledStyle} aria-hidden />
        公開中
      </span>
    );
  }
  return (
    <span style={statusEmptyStyle}>
      <span style={dotRingStyle} aria-hidden />
      本日 掲示なし
    </span>
  );
}

/** このクラスのエディタ（予定/連絡/提出物の入力）へ。 */
function EditorLink({ classId }: { classId: string }) {
  return (
    <Link href={`/admin/editor/${classId}`} style={editorLinkStyle}>
      エディタ
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 *  共通ノード見出し（学科 / 学年）: 名称・表示順編集 + restrict 削除 + 任意の追加メニュー項目
 * ------------------------------------------------------------------ */

function NodeHeader({
  name,
  defaultOrder,
  entity,
  badge,
  childCount,
  childLabel,
  deleteGuardMessage,
  extraItems,
  reorder,
  leading,
  trailing,
  onSave,
  onDelete,
  report,
}: {
  name: string;
  defaultOrder: number;
  entity: string;
  badge: string;
  childCount: number;
  childLabel: string;
  deleteGuardMessage?: string;
  extraItems?: MenuItem[];
  reorder?: RowReorder;
  leading?: ReactNode;
  trailing?: ReactNode;
  onSave: (v: {
    name: FormDataEntryValue | null;
    displayOrder: FormDataEntryValue | null;
  }) => Promise<Result>;
  onDelete: () => Promise<Result>;
  report: Reporter;
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [blocked, setBlocked] = useState(false);

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const res = await onSave({ name: fd.get("name"), displayOrder: fd.get("displayOrder") });
      report(res, `${entity}を更新しました。`);
      if (res.ok) setEditing(false);
    });
  }

  if (editing) {
    return (
      <form onSubmit={save} style={editFormStyle}>
        <input
          name="name"
          defaultValue={name}
          required
          style={inputStyle}
          aria-label={`${entity}名`}
        />
        <input
          name="displayOrder"
          type="number"
          defaultValue={defaultOrder}
          style={orderInputStyle}
          aria-label="表示順"
        />
        <button type="submit" disabled={pending} style={primaryBtnStyle}>
          {pending ? "保存中…" : "保存"}
        </button>
        <button type="button" onClick={() => setEditing(false)} style={ghostBtnStyle}>
          やめる
        </button>
      </form>
    );
  }

  const items: MenuItem[] = [
    { label: "名称・表示順を編集", onSelect: () => setEditing(true) },
    ...(reorder?.canUp ? [{ label: "上へ移動", onSelect: () => reorder.onMove(-1) }] : []),
    ...(reorder?.canDown ? [{ label: "下へ移動", onSelect: () => reorder.onMove(1) }] : []),
    ...(extraItems ?? []),
    {
      label: "削除",
      danger: true,
      onSelect: () => (childCount > 0 ? setBlocked(true) : setConfirming(true)),
    },
  ];

  return (
    <div>
      <div style={nodeHeaderRowStyle} className={styles.row}>
        {reorder && (reorder.canUp || reorder.canDown) ? (
          <span
            className={styles.actions}
            {...reorder.handleProps}
            aria-hidden
            title="ドラッグして並べ替え（または ⋯ から上へ/下へ移動）"
            style={gripStyle}
          >
            ⠿
          </span>
        ) : null}
        {leading}
        <span style={badgeStyle}>{badge}</span>
        <span style={nodeNameStyle}>{name}</span>
        {trailing}
        <span
          className={styles.actions}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
          }}
        >
          <RowMenu items={items} label={`${entity}の操作`} />
        </span>
      </div>

      {confirming ? (
        <div style={confirmBoxStyle}>
          <span style={{ fontSize: "0.82rem", color: C.danger }}>
            「{name}」を削除しますか？この操作は取り消せません。
          </span>
          <span style={{ display: "inline-flex", gap: "0.4rem" }}>
            <button
              type="button"
              disabled={pending}
              style={dangerBtnStyle}
              onClick={() =>
                start(async () => {
                  const res = await onDelete();
                  report(res, `${entity}を削除しました。`);
                })
              }
            >
              {pending ? "削除中…" : "削除する"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} style={ghostBtnStyle}>
              やめる
            </button>
          </span>
        </div>
      ) : null}

      {blocked ? (
        <div style={guardBoxStyle}>
          <span style={{ fontSize: "0.82rem", color: C.danger }}>
            {deleteGuardMessage ??
              `配下に${childLabel}があるため削除できません。先に${childLabel}を移動または削除してください。`}
          </span>
          <button type="button" onClick={() => setBlocked(false)} style={ghostBtnStyle}>
            閉じる
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  学科ノード（アコーディオン・配下: 学年）
 * ------------------------------------------------------------------ */

function DepartmentNode({
  dept,
  grades,
  statusByClass,
  reorder,
  report,
}: {
  dept: Dept;
  grades: Grade[];
  statusByClass: Record<string, boolean>;
  reorder?: RowReorder;
  report: Reporter;
}) {
  const [open, setOpen] = useState(true);
  // 配下の学年（この学科の兄弟集合）の並べ替え。永続化は単一の原子的アクション。
  const gradeRowProps = useSiblingReorder(
    grades,
    (orderedIds) => reorderHierarchyAction({ entity: "grade", orderedIds }),
    "学年",
    report,
  );
  return (
    <section
      style={{ ...deptNodeStyle, ...nodeDragStyle(reorder) }}
      {...(reorder?.dropProps ?? {})}
    >
      <NodeHeader
        name={dept.name}
        defaultOrder={dept.displayOrder}
        entity="学科"
        badge="学科"
        childCount={grades.length}
        childLabel="学年"
        reorder={reorder}
        leading={
          <button
            type="button"
            aria-label={open ? "折りたたむ" : "展開する"}
            aria-expanded={open}
            style={chevronBtnStyle}
            onClick={() => setOpen((v) => !v)}
          >
            <span aria-hidden>{open ? "▾" : "▸"}</span>
          </button>
        }
        trailing={<span style={summaryStyle}>{grades.length}学年</span>}
        onSave={(v) =>
          updateDepartmentAction({ id: dept.id, name: v.name, displayOrder: v.displayOrder })
        }
        onDelete={() => deleteDepartmentAction(dept.id)}
        report={report}
      />
      {open ? (
        <div style={childListStyle}>
          {grades.map((g, i) => (
            <GradeNode
              key={g.id}
              grade={g}
              statusByClass={statusByClass}
              reorder={gradeRowProps(i)}
              report={report}
            />
          ))}
          <AddGradeForm department={dept} report={report} />
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 *  学年ノード（配下: クラス、または学年単位）
 * ------------------------------------------------------------------ */

function GradeNode({
  grade,
  statusByClass,
  reorder,
  report,
}: {
  grade: Grade;
  statusByClass: Record<string, boolean>;
  reorder?: RowReorder;
  report: Reporter;
}) {
  const [pending, start] = useTransition();
  const modeLabel = grade.hasClasses ? "クラス単位" : "学年単位";
  const unitClass = grade.classes[0];
  // 学年名と同名の「裏方クラス」（学年単位の表示単位）。クラス単位⇄学年単位の往復で再利用する。
  const backstageClass = grade.classes.find((c) => c.name === grade.name);

  // モード切替: クラス単位 → 学年単位（裏方クラスを 1 つ用意 + hasClasses=false）/ 学年単位 → クラス単位。
  // **冪等化**: 既に同名の裏方クラスがあれば再利用し、毎回 createClassAction しない。これにより
  // クラス単位⇄学年単位を往復しても同名クラスが孤児として累積しない（往復の自己回復）。
  const toUnit = () =>
    start(async () => {
      if (!backstageClass) {
        const create = await createClassAction({
          gradeId: grade.id,
          name: grade.name,
          academicYear: new Date().getFullYear(),
          grade: deriveGradeNumber(grade.name),
        });
        if (!create.ok) {
          report(create, "");
          return;
        }
      }
      const res = await updateGradeAction({
        id: grade.id,
        name: grade.name,
        displayOrder: grade.displayOrder,
        hasClasses: false,
        departmentId: grade.departmentId ?? undefined,
      });
      report(res, "学年単位にしました。");
    });

  const toClasses = () =>
    start(async () => {
      const res = await updateGradeAction({
        id: grade.id,
        name: grade.name,
        displayOrder: grade.displayOrder,
        hasClasses: true,
        departmentId: grade.departmentId ?? undefined,
      });
      report(res, "クラス単位に切り替えました。");
    });

  // 学年単位化は「組が無い（=空）」か「残るクラスが裏方クラス 1 つだけ」のとき提示する。後者を許すことで、
  // クラス単位に戻した後に裏方クラスだけが残った学年を、新規作成せず（裏方を再利用して）学年単位へ戻せる。
  const canBecomeUnit =
    grade.classes.length === 0 || (grade.classes.length === 1 && backstageClass !== undefined);
  const extraItems: MenuItem[] = grade.hasClasses
    ? canBecomeUnit
      ? [{ label: "学年単位にする（組に分けない）", onSelect: toUnit }]
      : []
    : [{ label: "クラスに分ける", onSelect: toClasses }];

  return (
    <div style={{ ...gradeNodeStyle, ...nodeDragStyle(reorder) }} {...(reorder?.dropProps ?? {})}>
      <NodeHeader
        name={grade.name}
        defaultOrder={grade.displayOrder}
        entity="学年"
        badge="学年"
        childCount={grade.classes.length}
        childLabel="クラス"
        reorder={reorder}
        deleteGuardMessage={
          grade.hasClasses
            ? undefined
            : "学年単位の学年です。削除するには先に「クラスに分ける」で組表示に戻してください。"
        }
        extraItems={extraItems}
        trailing={<span style={modeChipStyle}>{modeLabel}</span>}
        onSave={(v) =>
          updateGradeAction({
            id: grade.id,
            name: v.name,
            displayOrder: v.displayOrder,
            // name/順のみ変更。hasClasses / departmentId は現状値を保持（全置換 API のため明示）。
            hasClasses: grade.hasClasses,
            departmentId: grade.departmentId ?? undefined,
          })
        }
        onDelete={() => deleteGradeAction(grade.id)}
        report={report}
      />

      {!grade.hasClasses ? (
        <div style={unitRowStyle} className={styles.row}>
          <p style={unitNoteStyle}>クラス分けなし・学年そのものが掲示単位です（{grade.name}）。</p>
          {unitClass ? (
            <span style={unitMetaStyle}>
              <StatusDot active={statusByClass[unitClass.id] ?? false} />
              <span className={styles.actions}>
                <EditorLink classId={unitClass.id} />
              </span>
            </span>
          ) : null}
        </div>
      ) : grade.classes.length === 0 ? (
        <div style={childListStyle}>
          <div style={onboardCardStyle}>
            <p style={onboardTextStyle}>
              この学年を組に分けますか？ サイネージは「表示単位」ごとに配信されます。
            </p>
            <AddClassForm grade={grade} report={report} />
            <button type="button" disabled={pending} style={secondaryBtnStyle} onClick={toUnit}>
              {pending ? "設定中…" : "組に分けず学年単位にする"}
            </button>
          </div>
        </div>
      ) : (
        <div style={childListStyle}>
          {grade.classes.map((c) => (
            <ClassNode key={c.id} cls={c} active={statusByClass[c.id] ?? false} report={report} />
          ))}
          <AddClassForm grade={grade} report={report} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  クラスノード（末端）
 * ------------------------------------------------------------------ */

function ClassNode({ cls, active, report }: { cls: Cls; active: boolean; report: Reporter }) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const res = await updateClassAction({
        id: cls.id,
        name: fd.get("name"),
        academicYear: fd.get("academicYear"),
        // 学年数はツリーの親に追従するため編集させず現状値を保持する。
        grade: cls.grade,
      });
      report(res, "クラスを更新しました。");
      if (res.ok) setEditing(false);
    });
  }

  if (editing) {
    return (
      <form onSubmit={save} style={editFormStyle}>
        <input
          name="name"
          defaultValue={cls.name}
          required
          style={inputStyle}
          aria-label="クラス名"
        />
        <input
          name="academicYear"
          type="number"
          defaultValue={cls.academicYear}
          required
          style={orderInputStyle}
          aria-label="年度"
        />
        <button type="submit" disabled={pending} style={primaryBtnStyle}>
          {pending ? "保存中…" : "保存"}
        </button>
        <button type="button" onClick={() => setEditing(false)} style={ghostBtnStyle}>
          やめる
        </button>
      </form>
    );
  }

  return (
    <div>
      <div style={classRowStyle} className={styles.row}>
        <span style={classBadgeStyle}>クラス</span>
        <span style={classNameStyle}>{cls.name}</span>
        <StatusDot active={active} />
        <span
          className={styles.actions}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
          }}
        >
          <EditorLink classId={cls.id} />
          <RowMenu
            label="クラスの操作"
            items={[
              { label: "名称・年度を編集", onSelect: () => setEditing(true) },
              { label: "削除", danger: true, onSelect: () => setConfirming(true) },
            ]}
          />
        </span>
      </div>
      {confirming ? (
        <div style={confirmBoxStyle}>
          <span style={{ fontSize: "0.82rem", color: C.danger }}>
            「{cls.name}」を削除しますか？このクラスの予定・公開内容も失われます。
          </span>
          <span style={{ display: "inline-flex", gap: "0.4rem" }}>
            <button
              type="button"
              disabled={pending}
              style={dangerBtnStyle}
              onClick={() =>
                start(async () => {
                  const res = await deleteClassAction(cls.id);
                  report(res, "クラスを削除しました。");
                })
              }
            >
              {pending ? "削除中…" : "削除する"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} style={ghostBtnStyle}>
              やめる
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  要整理（学科に紐づかない学年）: 学科へ移動セレクト + restrict 削除
 * ------------------------------------------------------------------ */

function OrphanBox({
  orphans,
  departments,
  report,
}: {
  orphans: Grade[];
  departments: Dept[];
  report: Reporter;
}) {
  return (
    <div style={orphanBoxStyle}>
      <div style={orphanLabelStyle}>
        <span aria-hidden style={{ color: C.orange }}>
          ●
        </span>
        要整理：学科に未所属の学年（{orphans.length}件）
      </div>
      <div style={{ display: "grid", gap: "0.5rem" }}>
        {orphans.map((g) => (
          <OrphanRow key={g.id} grade={g} departments={departments} report={report} />
        ))}
      </div>
      <p style={orphanHintStyle}>所属する学科を選ぶと整理できます。</p>
    </div>
  );
}

function OrphanRow({
  grade,
  departments,
  report,
}: {
  grade: Grade;
  departments: Dept[];
  report: Reporter;
}) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const selectId = useId();
  const childCount = grade.classes.length;

  function move(e: FormEvent<HTMLSelectElement>) {
    const departmentId = e.currentTarget.value;
    if (!departmentId) return;
    start(async () => {
      const res = await updateGradeAction({
        id: grade.id,
        name: grade.name,
        displayOrder: grade.displayOrder,
        hasClasses: grade.hasClasses,
        departmentId,
      });
      report(res, "学年を学科へ移動しました。");
    });
  }

  return (
    <div>
      <div style={orphanRowStyle}>
        <span style={badgeStyle}>学年</span>
        <span style={nodeNameStyle}>{grade.name}</span>
        <label htmlFor={selectId} style={srOnlyStyle}>
          {grade.name}の学科へ移動
        </label>
        <select
          id={selectId}
          defaultValue=""
          disabled={pending}
          onChange={move}
          style={{ ...selectStyle, marginLeft: "auto" }}
        >
          <option value="">学科へ移動 …</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <RowMenu
          label="学年の操作"
          items={[
            {
              label: "削除",
              danger: true,
              onSelect: () => (childCount > 0 ? setBlocked(true) : setConfirming(true)),
            },
          ]}
        />
      </div>
      {confirming ? (
        <div style={confirmBoxStyle}>
          <span style={{ fontSize: "0.82rem", color: C.danger }}>
            「{grade.name}」を削除しますか？
          </span>
          <span style={{ display: "inline-flex", gap: "0.4rem" }}>
            <button
              type="button"
              disabled={pending}
              style={dangerBtnStyle}
              onClick={() =>
                start(async () => {
                  const res = await deleteGradeAction(grade.id);
                  report(res, "学年を削除しました。");
                })
              }
            >
              {pending ? "削除中…" : "削除する"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} style={ghostBtnStyle}>
              やめる
            </button>
          </span>
        </div>
      ) : null}
      {blocked ? (
        <div style={guardBoxStyle}>
          <span style={{ fontSize: "0.82rem", color: C.danger }}>
            配下にクラスがあるため削除できません。先にクラスを移動または削除してください。
          </span>
          <button type="button" onClick={() => setBlocked(false)} style={ghostBtnStyle}>
            閉じる
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  空状態（新規校）
 * ------------------------------------------------------------------ */

function EmptyState({ report }: { report: Reporter }) {
  const [showDept, setShowDept] = useState(false);
  const [pending, start] = useTransition();
  if (showDept) {
    return <AddDepartmentForm report={report} autoFocus />;
  }
  return (
    <div style={emptyStateStyle}>
      <p style={{ fontSize: "0.95rem", color: C.inkPrimary, margin: "0 0 0.25rem" }}>
        まだ学科・学年がありません
      </p>
      <p style={{ fontSize: "0.82rem", color: C.inkMuted, margin: "0 0 1rem" }}>
        学校の構成を作ると、各クラスにサイネージを割り当てられます。
      </p>
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", flexWrap: "wrap" }}>
        <button type="button" style={primaryBtnStyle} onClick={() => setShowDept(true)}>
          最初の学科を追加
        </button>
        <button
          type="button"
          disabled={pending}
          style={secondaryBtnStyle}
          onClick={() =>
            start(async () => {
              const res = await createGradeAction({ name: "1年" });
              report(res, "学年を追加しました（普通科）。");
            })
          }
        >
          {pending ? "作成中…" : "普通科（学科なし）で始める"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  追加フォーム群
 * ------------------------------------------------------------------ */

function AddDepartmentForm({ report, autoFocus }: { report: Reporter; autoFocus?: boolean }) {
  const [pending, start] = useTransition();
  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await createDepartmentAction({
        name: fd.get("name"),
        displayOrder: fd.get("displayOrder"),
      });
      report(res, "学科を追加しました。");
      if (res.ok) form.reset();
    });
  }
  return (
    <form onSubmit={add} style={addFormStyle}>
      <span aria-hidden style={plusStyle}>
        ＋
      </span>
      <input
        name="name"
        placeholder="学科名（例: 電子工学科）"
        required
        style={growInputStyle}
        // biome-ignore lint/a11y/noAutofocus: 「最初の学科を追加」直後の入力欄に限定したフォーカス誘導。
        autoFocus={autoFocus}
      />
      <input
        name="displayOrder"
        type="number"
        placeholder="表示順"
        style={orderInputStyle}
        aria-label="表示順"
      />
      <button type="submit" disabled={pending} style={secondaryBtnStyle}>
        {pending ? "追加中…" : "学科を追加"}
      </button>
    </form>
  );
}

/**
 * 学年追加。`department` があれば学科配下の追加で、学年名は **`{学科名}{入力}`** にして学校内一意制約の
 * 衝突を避ける（入力は「1年」等の短い学年でよい）。`department` 無し（学科なし校）は入力をそのまま使う。
 */
function AddGradeForm({ department, report }: { department?: Dept; report: Reporter }) {
  const [pending, start] = useTransition();
  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const base = String(new FormData(form).get("name") ?? "").trim();
    if (!base) {
      report({ ok: false, error: { code: "invalid", message: "学年名を入力してください。" } }, "");
      return;
    }
    start(async () => {
      const res = await createGradeAction(
        department
          ? { name: `${department.name}${base}`, departmentId: department.id }
          : { name: base },
      );
      report(res, "学年を追加しました。");
      if (res.ok) form.reset();
    });
  }
  return (
    <div>
      <form onSubmit={add} style={addFormStyle}>
        <span aria-hidden style={plusStyle}>
          ＋
        </span>
        <input
          name="name"
          placeholder={department ? "学年（例: 1年）" : "学年名（例: 1年）"}
          required
          style={growInputStyle}
        />
        <button type="submit" disabled={pending} style={secondaryBtnStyle}>
          {pending ? "追加中…" : department ? "この学科に追加" : "学年を追加"}
        </button>
      </form>
      {department ? (
        <p style={fieldHintStyle}>学科名が自動で付きます（例：{department.name}1年）。</p>
      ) : null}
    </div>
  );
}

function AddClassForm({ grade, report }: { grade: Grade; report: Reporter }) {
  const [pending, start] = useTransition();
  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await createClassAction({
        gradeId: grade.id,
        name: fd.get("name"),
        // 年度は今年を自動設定、学年数は親の学年名から自動算出（UI では入力させない）。
        academicYear: new Date().getFullYear(),
        grade: deriveGradeNumber(grade.name),
      });
      report(res, "クラスを追加しました。");
      if (res.ok) form.reset();
    });
  }
  return (
    <div>
      <form onSubmit={add} style={addFormStyle}>
        <span aria-hidden style={plusStyle}>
          ＋
        </span>
        <input name="name" placeholder="クラス名（例: 1組）" required style={growInputStyle} />
        <button type="submit" disabled={pending} style={secondaryBtnStyle}>
          {pending ? "追加中…" : "この学年に追加"}
        </button>
      </form>
      <p style={fieldHintStyle}>組がなければ空欄でOK。学年そのものが掲示対象になります。</p>
    </div>
  );
}

/** 全学科に同じ学年をまとめて追加（各学科に `{学科名}{入力}` を生成）。 */
function BulkAddYears({ departments, report }: { departments: Dept[]; report: Reporter }) {
  const [pending, start] = useTransition();
  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const base = String(new FormData(form).get("base") ?? "").trim();
    if (!base) {
      report({ ok: false, error: { code: "invalid", message: "学年名を入力してください。" } }, "");
      return;
    }
    start(async () => {
      let ok = 0;
      let firstFail = "";
      for (const d of departments) {
        const res = await createGradeAction({ name: `${d.name}${base}`, departmentId: d.id });
        if (res.ok) {
          ok += 1;
        } else if (!firstFail) {
          firstFail = `${d.name}: ${res.error.message}`;
        }
      }
      if (firstFail) {
        report(
          {
            ok: false,
            error: { code: "conflict", message: `一部失敗（${ok} 件成功）。${firstFail}` },
          },
          "",
        );
      } else {
        report({ ok: true, data: { id: "" } }, `すべての学科に「${base}」を追加しました。`);
      }
      form.reset();
    });
  }
  return (
    <form onSubmit={add} style={bulkBoxStyle}>
      <span style={bulkLabelStyle}>すべての学科（{departments.length}件）に学年を追加</span>
      <input name="base" placeholder="学年名（例: 1年）" style={growInputStyle} />
      <button type="submit" disabled={pending} style={secondaryBtnStyle}>
        {pending ? "追加中…" : "全学科に一括追加"}
      </button>
    </form>
  );
}

/** 新年度へ複製（現年度のクラスを翌年度の空クラスへ。実行ごとに翌年度へ1年進む）。クラスが無い校では出さない。 */
function NextYearCopy({
  currentYear,
  notify,
}: {
  currentYear: number | null;
  notify: (ok: boolean, text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  if (currentYear === null) {
    return null;
  }
  const targetYear = currentYear + 1;
  return (
    <>
      <button type="button" style={secondaryBtnStyle} onClick={() => setOpen(true)}>
        新年度へ複製
      </button>
      {open ? (
        <div style={modalOverlayStyle} role="dialog" aria-modal="true" aria-label="新年度へ複製">
          <div style={modalCardStyle}>
            <p style={modalTitleStyle}>新年度へ複製</p>
            <p style={modalBodyStyle}>
              {currentYear}年度 の構成を {targetYear}年度
              に複製します。各クラスを新年度の空クラスとして作成します（予定・公開内容は複製されません）。
              実行のたびに翌年度へ1年進みます。重複は作成されません（既存クラスはスキップされます）。
            </p>
            <div style={modalActionsStyle}>
              <button type="button" style={ghostBtnStyle} onClick={() => setOpen(false)}>
                キャンセル
              </button>
              <button
                type="button"
                disabled={pending}
                style={primaryBtnStyle}
                onClick={() =>
                  start(async () => {
                    const res = await duplicateClassesToNextYearAction();
                    if (res.ok) {
                      notify(
                        true,
                        res.data.created === 0
                          ? `${res.data.targetYear}年度のクラスは既に揃っています（新規作成なし）。`
                          : `${res.data.created}件のクラスを${res.data.targetYear}年度に複製しました。`,
                      );
                      setOpen(false);
                    } else {
                      notify(false, res.error.message);
                    }
                  })
                }
              >
                {pending ? "複製中…" : `${targetYear}年度に複製する`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ *
 *  styles — 3 色（ウォームグレー基調 + ブランドのオレンジ + 削除の赤）
 * ------------------------------------------------------------------ */

const C = {
  inkPrimary: "#1c1917",
  inkSecondary: "#57534e",
  inkMuted: "#78716c",
  inkTertiary: "#a8a29e",
  border: "#e7e5e4",
  borderLight: "#f5f5f4",
  surface: "#fafaf9",
  orange: "#ea580c",
  teal: "#0f766e",
  danger: "#b91c1c",
  dangerBg: "#fef2f2",
  dangerBorder: "#fca5a5",
} as const;

const pageStyle: React.CSSProperties = { display: "grid", gap: "0.85rem", maxWidth: "820px" };
const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: "0.75rem",
};
const h1Style: React.CSSProperties = { fontSize: "1.3rem", margin: 0, color: C.inkPrimary };
const msgStyle: React.CSSProperties = { display: "block", fontSize: "0.85rem" };
const hintStyle: React.CSSProperties = {
  color: C.inkMuted,
  fontSize: "0.82rem",
  margin: 0,
  lineHeight: 1.6,
};
const treeRootStyle: React.CSSProperties = { display: "grid", gap: "0.6rem" };
const childListStyle: React.CSSProperties = {
  margin: "0.5rem 0 0",
  padding: "0 0 0 0.9rem",
  borderLeft: `2px solid ${C.borderLight}`,
  display: "grid",
  gap: "0.45rem",
};
const deptNodeStyle: React.CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: "8px",
  padding: "0.7rem 0.85rem",
  background: "#fff",
};
const gradeNodeStyle: React.CSSProperties = {
  background: C.surface,
  borderRadius: "6px",
  padding: "0.5rem 0.65rem",
};
const nodeHeaderRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  flexWrap: "wrap",
};
const nodeNameStyle: React.CSSProperties = {
  fontWeight: 500,
  fontSize: "0.92rem",
  color: C.inkPrimary,
};
const summaryStyle: React.CSSProperties = { fontSize: "0.75rem", color: C.inkTertiary };
const classRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
};
const classNameStyle: React.CSSProperties = { fontSize: "0.88rem", color: C.inkPrimary };
const badgeStyle: React.CSSProperties = {
  fontSize: "0.68rem",
  fontWeight: 500,
  color: C.inkSecondary,
  background: C.borderLight,
  borderRadius: "999px",
  padding: "0.1rem 0.5rem",
};
const classBadgeStyle: React.CSSProperties = { ...badgeStyle };
const modeChipStyle: React.CSSProperties = {
  fontSize: "0.68rem",
  color: C.inkMuted,
  border: `1px solid ${C.border}`,
  borderRadius: "999px",
  padding: "0.05rem 0.5rem",
};
const unitNoteStyle: React.CSSProperties = {
  fontSize: "0.76rem",
  color: C.inkTertiary,
  margin: "0.4rem 0 0 0.9rem",
};
const unitRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.2rem 0.9rem",
};
const unitMetaStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.6rem",
  marginLeft: "0.9rem",
};
const statusActiveStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  fontSize: "0.72rem",
  color: C.teal,
};
const statusEmptyStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  fontSize: "0.72rem",
  color: C.inkMuted,
};
const dotFilledStyle: React.CSSProperties = {
  width: "7px",
  height: "7px",
  borderRadius: "999px",
  background: C.teal,
};
const dotRingStyle: React.CSSProperties = {
  width: "7px",
  height: "7px",
  borderRadius: "999px",
  border: `1.5px solid ${C.inkTertiary}`,
  boxSizing: "border-box",
};
const editorLinkStyle: React.CSSProperties = {
  fontSize: "0.76rem",
  color: C.inkSecondary,
  textDecoration: "none",
  border: `1px solid ${C.border}`,
  borderRadius: "6px",
  padding: "0.2rem 0.6rem",
  whiteSpace: "nowrap",
};
const onboardCardStyle: React.CSSProperties = {
  background: "#fff",
  border: `1px solid ${C.border}`,
  borderRadius: "8px",
  padding: "0.7rem",
  display: "grid",
  gap: "0.6rem",
};
const onboardTextStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  color: C.inkSecondary,
  margin: 0,
  lineHeight: 1.6,
};
const orphanBoxStyle: React.CSSProperties = {
  border: `1px solid ${C.border}`,
  borderLeft: `3px solid ${C.orange}`,
  borderRadius: "8px",
  padding: "0.7rem 0.85rem",
  background: "#fff",
  display: "grid",
  gap: "0.6rem",
};
const orphanLabelStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 500,
  color: C.inkPrimary,
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
};
const orphanRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  flexWrap: "wrap",
};
const orphanHintStyle: React.CSSProperties = { fontSize: "0.76rem", color: C.inkMuted, margin: 0 };
const emptyStateStyle: React.CSSProperties = {
  border: `1px dashed ${C.inkTertiary}`,
  borderRadius: "10px",
  padding: "1.75rem 1.25rem",
  textAlign: "center",
};
const confirmBoxStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
  margin: "0.45rem 0 0",
  padding: "0.5rem 0.6rem",
  background: C.dangerBg,
  border: `1px solid ${C.dangerBorder}`,
  borderRadius: "6px",
};
const guardBoxStyle: React.CSSProperties = { ...confirmBoxStyle };
const bulkBoxStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.6rem 0.75rem",
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: "8px",
};
const bulkLabelStyle: React.CSSProperties = { fontSize: "0.82rem", color: C.inkSecondary };
const addFormStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.4rem",
  alignItems: "center",
};
const editFormStyle: React.CSSProperties = { ...addFormStyle };
const fieldHintStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  color: C.inkTertiary,
  margin: "0.3rem 0 0 1.2rem",
};
const plusStyle: React.CSSProperties = { color: C.inkMuted, fontWeight: 500 };
const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: `1px solid ${C.border}`,
  borderRadius: "6px",
  fontSize: "0.85rem",
  minWidth: 0,
};
const growInputStyle: React.CSSProperties = { ...inputStyle, flex: "1 1 200px" };
const orderInputStyle: React.CSSProperties = { ...inputStyle, width: "5rem", flex: "0 0 auto" };
const selectStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: `1px solid ${C.border}`,
  borderRadius: "6px",
  fontSize: "0.82rem",
  background: "#fff",
  color: C.inkSecondary,
};
const primaryBtnStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  background: C.orange,
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.82rem",
};
const secondaryBtnStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  background: "#fff",
  color: C.inkSecondary,
  border: `1px solid ${C.border}`,
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.82rem",
};
const toolbarBtnStyle: React.CSSProperties = { ...secondaryBtnStyle, marginLeft: "auto" };
const ghostBtnStyle: React.CSSProperties = {
  padding: "0.3rem 0.7rem",
  background: "transparent",
  color: C.inkSecondary,
  border: `1px solid ${C.border}`,
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.8rem",
};
const dangerBtnStyle: React.CSSProperties = {
  padding: "0.3rem 0.8rem",
  background: C.dangerBg,
  color: C.danger,
  border: `1px solid ${C.dangerBorder}`,
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.8rem",
};
const iconBtnStyle: React.CSSProperties = {
  width: "1.85rem",
  height: "1.85rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: "#fff",
  color: C.inkSecondary,
  border: `1px solid ${C.border}`,
  borderRadius: "6px",
  cursor: "pointer",
};
const chevronBtnStyle: React.CSSProperties = {
  width: "1.5rem",
  height: "1.5rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: "transparent",
  color: C.inkMuted,
  border: "none",
  cursor: "pointer",
};
const gripStyle: React.CSSProperties = {
  cursor: "grab",
  color: C.inkTertiary,
  fontSize: "1rem",
  lineHeight: 1,
  userSelect: "none",
  padding: "0 0.1rem",
};
const draggingNodeStyle: React.CSSProperties = { opacity: 0.5 };
// ドロップ先候補は上辺にオレンジ（ブランド色）の差し込み線。3 色の範囲内。
const dropOverStyle: React.CSSProperties = { boxShadow: `inset 0 2px 0 0 ${C.orange}` };
const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "default",
  zIndex: 10,
};
const menuStyle: React.CSSProperties = {
  position: "absolute",
  right: 0,
  top: "2.1rem",
  minWidth: "11rem",
  background: "#fff",
  border: `1px solid ${C.border}`,
  borderRadius: "8px",
  padding: "0.25rem",
  display: "grid",
  gap: "0.1rem",
  zIndex: 11,
  boxShadow: "0 4px 16px rgba(28,25,23,0.08)",
};
const menuItemStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.45rem 0.6rem",
  background: "transparent",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.82rem",
  width: "100%",
};
const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};
const bulkPanelStyle: React.CSSProperties = { display: "grid", gap: "0.6rem" };
const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(28,25,23,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1rem",
  zIndex: 50,
};
const modalCardStyle: React.CSSProperties = {
  width: "420px",
  maxWidth: "100%",
  background: "#fff",
  borderRadius: "12px",
  padding: "1.1rem 1.25rem",
};
const modalTitleStyle: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 500,
  color: C.inkPrimary,
  margin: "0 0 0.6rem",
};
const modalBodyStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: C.inkSecondary,
  lineHeight: 1.7,
  margin: "0 0 1rem",
};
const modalActionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};
