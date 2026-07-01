# Runbook: 個別教員 IdP アカウント（系統B）の棚卸し・無効化

> **ステータス: DRAFT（雛形）.** 教員アカウント一本化（系統A 学校共通PW）の最終段。`#887` 残タスク2 を実行可能な手順に落としたもの。実行前に「失敗時の対処」「未確定事項」を必ず確認すること。実行は人間（system_admin / 運営）。

教員アカウントの概念を撤去し **学校共通パスワード（系統A）へ一本化**する方針（ユーザー判断確定・`project_remove_individual_teacher_accounts`）の最終段。旧フロー `/admin/school/members`（撤去済み・#785）で発行された **個別教員アカウント（系統B）** が prod に残っていれば、棚卸しして無効化する。

---

## ⚠️ 用語の区別（最重要・取り違え厳禁）

| | 系統A（**残す**） | 系統B（**無効化対象**） |
|---|---|---|
| 実体 | 学校ごとに 1 つの**共通教員アカウント** | 教員ごとの**個別 IdP アカウント** |
| email | 合成 `t-<schoolId>@teacher.kimiterrace.invalid`（`lib/auth/teacher-account.ts` `teacherAccountEmail`） | 実在のメールアドレス（学校が入力したもの） |
| uid | `sharedTeacherUid(schoolId)`（school 単位で決定的） | IdP が採番した個別 uid |
| ログイン | 学校共通パスワード（ADR-032） | 個別 email/password（旧フロー） |
| 管理コード | `provisionSharedTeacherAccount` / `disableSharedTeacherAccount` | 旧 `/admin/school/members`（**既に撤去**） |

→ **系統A の `teacher.kimiterrace.invalid` ドメイン口座は無効化してはならない**（これが一本化後の正規ログイン）。無効化対象は「実在メール・role=teacher・共通口座ではない」行のみ。

---

## 1. 前提（誰が・いつ）

- **実行者**: 運営（system_admin）。
- **タイミング**: 各学校で **系統A（共通PW）ログインが活性化済み**であること（system_admin が `/admin/system/schools/<id>/edit` で共通PWを設定 → `/login` で教員が共通PWログインできる状態）。活性化前に個別口座を消すと教員がログイン手段を失う。
- **前提確認**: そもそも v2 prod に系統B（個別教員）口座が存在するか先に棚卸しで確認する。**v2 prod は個別教員発行フローを持たずに立ち上がっているため、対象ゼロ＝本手順スキップの可能性が高い**。旧 Firebase 由来の口座は v2 IdP には自動移行されない。

## 2. 必要な権限

- prod GCP project の **Identity Platform / Firebase Auth 管理**（user list / update; `firebaseauth.users.*`）。
- prod DB への **system_admin context** 接続（`app.current_school_id` 横断は system_admin ロールの `system_admin_full_access` ポリシー経由）。
- Secret Manager 不要（鍵ファイル禁止・ルール5）。

## 3. 棚卸し（対象の同定）

### 3-1. DB 側（真実の単一ソース）

system_admin context で `users` を全校横断し、**個別教員行**を抽出する。系統A 共通口座（`sharedTeacherUid` / 合成ドメイン）を除外する。

```sql
-- system_admin 接続（system_admin_full_access）で実行。
-- 個別教員 = role=teacher かつ email が合成ドメインでない（= 旧個別フロー由来）。
SELECT id, school_id, email, is_active, created_at
FROM users
WHERE role = 'teacher'
  AND (email IS NULL OR email NOT LIKE '%@teacher.kimiterrace.invalid')
ORDER BY school_id, created_at;
```

- 0 行なら **対象なし → 本手順は実施不要**（#887 残タスク2 を「対象なしで完了」とクローズ）。
- 1 行以上なら school_id ごとに件数を控え、各 `id`（= IdP uid）を無効化リストにする。

### 3-2. IdP 側の突き合わせ

DB で挙がった uid が IdP に実在し disabled でないかを確認（Firebase Admin SDK / `gcloud` で uid 引き）。DB に無く IdP にだけ存在する孤児口座（role=teacher claim 付き・合成ドメイン外）も対象に含める。

## 4. 無効化（IdP-first + DB mirror + 監査）

**原則: アプリの既存シーム経由で無効化し、`audit_log` に記録を残す**（ADR-026 IdP-first・直接 IdP コンソール操作は監査が残らないので最終手段）。

- 既存の system_admin 無効化アクション `setStaffActiveAction`（`apps/web/lib/system-admin/users-actions.ts`）が IdP disable → DB mirror → audit を同一経路で行う。
- **未確定事項（実行前に要確認）**: 現行 `setStaffActiveAction` は last-admin ガードまわりで `role === "school_admin"` を主対象に書かれている（`users-actions.ts` 参照）。**teacher を対象に取れるか**をコード/テストで確認し、取れない場合は **専用の一括無効化 CLI**（`apps/jobs` か `packages/db` の system_admin context スクリプト：対象 uid 群に対し `auth.updateUser(uid, {disabled:true})` + `users.is_active=false` + `audit_log` insert を同一 tx 思想で）を起こす。CLI 化する場合は別 PR + Reviewer + 実 PG テスト（`packages/db/__tests__/`）。
- 監査必須項目（ルール1）: who(system_admin actor / IP / UA)・what(table=users, record_id, op=update, diff)・when。actor は `users` 行を持たないため `actor_identity_uid` で記録（`system-admin-not-in-users-table`）。

## 5. 検証（成功確認）

1. 対象 uid が IdP で `disabled = true`。
2. DB `users.is_active = false`（3-1 の SQL を `is_active` 条件付きで再実行 → 対象が消える）。
3. `audit_log` に各無効化が who/what/when 付きで残っている。
4. `/login` で当該個別メール+旧PWが**拒否**され、同教員は**学校共通PW（系統A）でのみ**ログインできる。
5. 系統A 共通口座（`t-<school>@teacher.kimiterrace.invalid`）が **active のまま**（誤って無効化していない）。

## 6. 失敗時の対処 / ロールバック

- 誤無効化・教員ロックアウト時は同じシームで **再有効化**（`setStaffActiveAction` の reactivate / `auth.updateUser(uid,{disabled:false})` + `is_active=true`）。補償も audit に残す。
- **last-admin ガード**: 対象が「その学校で最後の有効な school_admin」を巻き込まないこと（teacher 無効化では本来無関係だが、role 取り違えに注意）。
- IdP 更新は成功・DB mirror 失敗（またはその逆）の片落ちに注意。片落ちを検知したら 3-1/5 の SQL と IdP 状態を突き合わせて手で整合させる。
- バッチ CLI を起こす場合は **dry-run（対象列挙のみ）→ 件数を人間が承認 → 本実行** の二段にする。

## 関連

- Issue: `#887`（教員アカウント一本化の継続実装・追跡）
- 方針メモ: `project_remove_individual_teacher_accounts`（一次ソース）
- ADR-032（系統A 学校共通PW）/ ADR-026（IdP-first 無効化・監査の置き場）
- コード: `apps/web/lib/auth/teacher-account.ts`（系統A 共通口座）/ `apps/web/lib/system-admin/users-actions.ts`（無効化シーム）
- 撤去済み: `/admin/school/members/**`（#785）/ `/admin/system/users` の teacher 発行（#788）
