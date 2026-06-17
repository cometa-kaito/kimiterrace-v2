# ADR-041: system_admin に school_admin 相当の「特定校スコープ操作」を開放する（運営代行）

- 状態: Accepted（2026-06-17、ユーザー判断「school_admin ができることは system_admin からもできるように」/ A+B 出荷・prod 反映済、C 進行中、D 着手）
- 日付: 2026-06-17
- 関連: [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [ADR-020 (来場検知センサー)](020-presence-sensor-switchbot-webhook.md), [ADR-040 (Q&A 知識源=daily_data・curated contents 休眠)](040-rag-knowledge-source-daily-data.md), [ADR-026 (アカウント無効化/ロール変更)](026-account-deactivation-role-change-enforcement.md), [CLAUDE.md ルール1/2/4](../../CLAUDE.md), #998/#999（hub 確立）, #1002/#1003/#1004（A+B 出荷）, #1007（C 土台）, [[ref_sysadmin_edit_tenant_via_downgrade_scope]], [[system-admin-not-in-users-table]]

## 文脈

`system_admin`（運営・cross-tenant）は当初「全校を**見られる**が、特定校に紐づく**書き込み**はできない監督ロール」として設計された。理由は構造的:

1. system_admin は `users` 行を持たない（`system_admins` 別テーブル）。`created_by`/`updated_by` は `users(id)` への FK（migration 0004/0006/0009/0014 等）なので、system_admin の uid を入れると FK 違反（23503）。
2. system_admin はどの school にも属さない（`schoolId = null`）。自校スコープ操作は RLS の `tenant_isolation` で弾かれる / `system_admin_full_access` で全校に漏れる。

しかし運用実態として、運営が**特定校の代行設定**（クラス階層・広告・静粛時間・生徒アクセスリンク・日々の掲示等）を行えないと、学校の立ち上げ支援・トラブル対応・代理運用ができない。#998/#999（hub: system_admin が `/ops/schools/[id]/hierarchy` で特定校のクラス階層を編集）で、この「特定校スコープ書き込み」を**安全に成立させる確立パターン**が出来た。本 ADR はこれを **school_admin ができる操作面全体へ展開する**決定を記録する。

## 決定

### D1. 正準パターン: 「targetSchoolId + tenantScoped 降格 + 三系統 actor」（または「対象から学校導出 + full_access」）

system_admin の特定校スコープ書き込みは、次のいずれかの確立パターンで行う（[[ref_sysadmin_edit_tenant_via_downgrade_scope]]）:

- **(P1) 明示 targetSchoolId + 降格**（hub/ads/quiet_hours/editor で採用）: action が `targetSchoolId` を受け取り、`withSession(..., { tenantScoped: true, schoolId })` で実行。`withSession` の schoolId override は **system_admin のときだけ honor**（tenant ロールは自校固定=越境不可）、`tenantScopedContext` が system_admin を school_admin に**降格**して `system_admin_full_access` の全校発火を止める。残る `tenant_isolation` + 書き込み前の対象可視性チェックで cross-tenant write が DB レベル不成立。
- **(P2) 対象から学校導出 + full_access**（magic-link で採用）: client は対象（classId 等）のみ送り、サーバが `system_admin_full_access` 下で対象から school_id を解決して書く。client 由来の学校値が介在しない（誤学校への書き込み構造的に不可）。

**監査 actor の三系統**（CLAUDE.md ルール1 / [[system-admin-not-in-users-table]]）:
- `actor_user_id` = acting uid（FK 無し。降格後 `audit_log_insert` policy(0005) の `actor_user_id = app.current_user_id` を充足）
- `created_by`/`updated_by` = **system_admin は null**（users FK 回避）、school_admin は自身の users.id
- `actor_identity_uid` = IdP uid（system_admin の追跡用）

UI は `/ops/schools/[id]/...` 配下に専用画面を置き、パンくず + 🛡監査バナーで「どの校を編集中か」を明示。既存の school_admin 用コンポーネントを `schoolId` context（未指定=自校=従来動作・回帰なし）で再利用する。

### D2. 開放対象（school_admin の操作面に揃える）

| 面 | 採用パターン | 状態 |
|---|---|---|
| クラス階層（学科/学年/クラス） | P1 | ✅ #998/#999（既出荷） |
| クラス/学科/学年/学校 広告 | P1 | ✅ #1002（prod 反映済） |
| 静粛時間 | P1 | ✅ #1003（prod 反映済） |
| 生徒アクセスリンク（magic link） | P2 | ✅ #1004（prod 反映済） |
| エディタ（daily_data 連絡/予定/提出物） | P1 | 🔄 #1007 土台 + 後続 /ops UI |
| **来場検知センサー登録/編集** | P1 | 🆕 本 ADR で開放（下記 D3） |

### D3. 来場検知センサーを system_admin に開放する（旧「school_admin 限定」を覆す）

[ADR-020](020-presence-sensor-switchbot-webhook.md) 系の実装（`apps/web/lib/sensors/mutations-core.ts`）は `SENSOR_WRITE_ROLES = ["school_admin"]` とし、コメントで「センサーの設置/設定は自校の運用管理操作であり school_admin に限定。system_admin は全校ビューを開けるが actor が school_id を持たないため実書き込みはできない」と**意図的に除外**していた。

本 ADR はこれを覆し、**system_admin も特定校スコープでセンサーを登録/編集できる**ようにする。

- **根拠**: 運営によるセンサー設置代行・初期構築支援・トラブル対応は実運用で必要。当初の除外は「system_admin が school_id を持たない」構造制約への対処であり（=やらない理由ではなく、当時できなかった理由）、#998 以降その制約は P1 パターンで解消済み。school_admin にできてシステム管理者にできない非対称を残す積極的理由はない。
- **実装方針（P1）**: `SENSOR_WRITE_ROLES` に system_admin を追加し、`toSensorActor(user, targetSchoolId?)` を三系統化（`sensor_devices.created_by/updated_by` は users FK（`0014_sensor_devices_rls.sql`）ゆえ system_admin は null 必須）、各 mutation に `targetSchoolId` 配線 + `withSession(..., { tenantScoped: true, schoolId })`。UI は `/ops/schools/[id]/sensors`（または既存 `/ops/sensors` の全校一覧から対象校スコープ編集への導線）。`device_mac` 一意性・`location_label` PII 非格納（ルール4）は不変。
- **越境防止**: 他面と同じく降格 + 対象（class）可視性チェック + override 限定 honor で DB レベル強制。`location_label` は引き続き教室名等のみ（生徒/保護者名を入れない）。

### D4. 休眠群（コンテンツ発行 / 教員入力 / 掲示物 Q&A）は据え置き（条件付き再訪）

`PUBLISHER_ROLES`（コンテンツ発行）・`TEACHER_INPUT_STAFF_ROLES`（教員入力）系は、[ADR-040](040-rag-knowledge-source-daily-data.md) で curated contents 経路が**全社休眠**（nav 撤去・embedding Job 未 apply・知識源は daily_data へ再ソース化）になっている。これらは school_admin/teacher にとっても実質非運用面であり、**system_admin に開いても今は無意味**（dead surface への配線）。

よって本 ADR では **休眠群を system_admin に開放しない**。再訪条件: ADR-040 の休眠が解除され curated contents の運用主体が確定したら、その時点で本 ADR の P1/P2 パターンで開放を再検討する。生徒/保護者 Q&A ボット自体は引き続き匿名 magic-link 経路（system_admin の編集対象ではない）。

## 影響

- 運営が `/ops/schools/[id]/...` から各校の階層・広告・静粛時間・生徒アクセスリンク・日々の掲示・センサーを**代行設定**できる。すべて対象校に RLS スコープされ、監査ログに「system_admin が代行」と記録される（actor_identity_uid で実行者追跡可）。
- school_admin/teacher の自校経路は全面で**不変**（targetSchoolId 未指定=従来動作）。
- スキーマ変更は D3 センサーで発生しない（既存 `sensor_devices` の role gate + actor 配線のみ）。migration 不要。
- 当初「監督のみ」の system_admin 像は「監督 + 特定校代行」へ拡張。全校横断の破壊操作（学校削除等）の規律は別途不変。

## 残存リスク / follow-up

- ① **代行操作の責任分界**: system_admin が school のデータを書き換えられる＝権限集中。監査ログ（三系統 actor）と 🛡バナーで可視化するが、誤操作・内部不正の影響範囲は拡大する。アカウント無効化/ロール変更の即時反映（[ADR-026](026-account-deactivation-role-change-enforcement.md)）規律を system_admin にも適用維持。
- ② **休眠群（D4）**: 開けていないことを明示。ADR-040 休眠解除時に再訪。
- ③ **センサー（D3）**: `location_label` への PII 混入は引き続き入力規律依存（自由文字列・best-effort）。運営代行でも同じ注意。
