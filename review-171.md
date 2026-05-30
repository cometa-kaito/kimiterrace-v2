## Reviewer 判定: **APPROVE 相当** ✅ (merge 可)

独立 Reviewer (fresh context) として PR #171 (F0 #48-H「エディタ Schedule セクション」, 698 行 / 7 ファイル / 全 apps/web) を correctness 最優先で実証レビューしました。**CLAUDE.md 8 ルール違反なし、RLS / 監査 / CHECK / unique を実証確認。Critical / High ゼロ。** 自律 merge OK と判断します。

| Severity | 件数 |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 3 |

CI: 全 green (`gh pr checks 171` 12/12 SUCCESS, WIF のみ SKIPPED)。

---

### 実証できた正当性 (重点項目)

- **RLS / ルール2**: 全 読み書きが `withSession` の自校 tx 内。書込前に `classes` を RLS 経由 SELECT し不可視なら `ClassNotFoundError` → `withTenantContext` の `db.transaction` が throw でロールバック (`client.ts:95`)。cross-tenant 書込不能を確認。読取 (`schedule-queries.ts`) も同 tx 前提で class → daily_data を自校限定。
- **CHECK `ck_daily_data_scope`**: INSERT 行は `scope='class'` / `classId` セット / `gradeId`・`departmentId` 未指定 (= NULL default)。class 分岐は `classId IS NOT NULL` のみ要求 (`daily-data.ts:49`) → 充足。
- **upsert × `ux_daily_data_target_date`(nullsNotDistinct)**: 既存判定が `(scope='class', classId, date)` で RLS により暗黙 school スコープ → unique index の列集合と矛盾せず、通常フローで二重行を作らない。
- **audit / ルール1**: update→`diff{before,after}` / insert→`diff{after}`、`actorUserId=actor.userId`・`schoolId=actor.schoolId`。これは `audit_log_insert` policy (migration 0005) の WITH CHECK — 「自ロールは actor_user_id が SET LOCAL の user_id に完全一致」「school_id は現テナント一致」— を両方満たす。`withSession` が `user.uid`/`user.schoolId` から RLS context を張るため actor と context が一致。`rowHash:""` + 0003 BEFORE INSERT トリガ計算前提も merged hub-actions と同一パターン。
- **検証**: `validateScheduleItems` (period 1..12 整数・重複拒否・科目 1..32・最大 12・period 昇順正規化・空配列許可)、`isValidDate` (UTC で実在日判定, 2026-02-30 false)。テスト 13 ケースが網羅。`subject` 必須 → SignageBoard `itemLabel` (`["title","label","text","subject",...]`) が科目名を描画 → #48-E1 描画と整合 (実ファイル確認)。
- **認可 / XSS**: `requireRole(EDITOR_ROLES=[school_admin,teacher])` で他ロール → `/forbidden`。`"use server"` は async export のみ。React テキスト描画 (`dangerouslySetInnerHTML` 不使用) でエスケープ。`revalidatePath("/admin/signage-preview/[classId]","page")` は過剰無効化方向 (under-invalidation でない) で安全。
- **型単一ソース (ルール3)**: 行型は schema 由来 (`@kimiterrace/db`)、手書きドメイン型の再定義なし。

---

### Medium 1 件

**M1. select-then-INSERT に ON CONFLICT / 23505 ハンドリングが無い → 同時保存で 500**
`apps/web/lib/editor/schedule-actions.ts:85-141`
同一 class+date への並行 submit (編集者のダブルクリック、または 2 名同時編集) で、既存判定 SELECT 後に他 tx が INSERT すると `ux_daily_data_target_date` 違反 (SQLSTATE 23505) が発生。catch は `ClassNotFoundError` のみ処理し他は re-throw → ユーザーには graceful な conflict でなく 500 が見える。
- 比較: merged 先例 `hub-actions.ts` は `isUniqueViolation(error)` (23505) を `conflict()` に写像している。本 action は同じ写像を持たない。
- 機能ブロッカーではない (整合性は unique index が守る、データ破壊なし) が、UX とエラー観測性で先例に劣る。
- **修正案**: (a) `dailyData` の INSERT を `.onConflictDoUpdate({ target: [...ux 列], set: {...} })` にして select 分岐自体を畳む (audit の before 取得が必要なら RETURNING で旧値を拾う設計に)、または (b) hub-core の `isUniqueViolation` + `conflict("この日付の時間割は既に更新されています。再読み込みしてください。")` を catch に追加。フォロー Issue でも可。

---

### Low 3 件

- **L1.** `schedule-actions.ts:122` `inserted?.id as string`。ルール3 の精神 (`as` で undefined を握り潰す) に触れるが、**merged 先例 `hub-actions.ts:132/170/208` が `row?.id as string` で同一**。本 PR が新規に持ち込んだ違反ではなく既存パターン踏襲。横断改善するなら別 Issue で `if (!inserted) throw` に統一。本 PR では不問。
- **L2.** `schedule-queries.ts:6` `EditableClass.grade` を SELECT しているが index page (`page.tsx:45`) は `academicYear` と `name` のみ表示、`grade` 未使用。死にフィールド。表示に使うか select から外すと無駄が減る。
- **L3.** SignageBoard 描画は `subject` のみで `period` (時限) を出さない (`SignageBoard.tsx:74`)。本 PR の整合観点 (subject 必須化) は満たすが、描画側で時限が落ちる。**本 PR scope 外** (描画は #48-E1)、参考まで。

---

### サイズ (ルール6) / テスト

698 行・1 機能凝集 (core/queries/actions/page×2/UI/test)。500 行目安は超えるが大半が JSDoc + inline style で、責務分割は明確 (純粋ロジックを `schedule-core.ts` に分離 → `"use server"` async-only 制約も遵守)。許容。テストは純粋層 13 ケースで網羅良好。actions の RLS/監査は merged 先例と同型のため新規 RLS テスト無しは許容範囲 (ただし将来 #48-I で同 [classId] エディタを拡張する際、actions の cross-tenant 拒否を `__tests__/rls/` に 1 本足すと回帰防止になる — 推奨)。

---

**結論**: Critical/High ゼロ、ルール違反なし、RLS・監査・CHECK・unique・#48-E1 整合をすべて実証。**APPROVE 相当 / merge 可**。M1 (並行 23505 → 500) は先例の `isUniqueViolation` 写像を借りれば軽微修正で潰せるが、データ整合は index が守るためブロッカーではない。本 PR 同梱修正でも別 Issue でも可 (Desktop 判断)。

*(self-review 制約により `--comment` で投稿。本コメントは APPROVE 相当の判定を明記。fresh-context Reviewer Agent による独立評価。)*
