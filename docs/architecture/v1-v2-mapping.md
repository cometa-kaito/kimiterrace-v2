# V1 → V2 画面・機能マッピング表

- 状態: Draft（初版）
- 日付: 2026-05-30
- 関連 Issue: [#48 F0/F12 V1 既存機能の Cloud Run 移植](https://github.com/cometa-kaito/kimiterrace-v2/issues/48)
- 関連 ADR: ADR-001 (PostgreSQL、未作成 — [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94)), ADR-003 (Identity Platform、未作成 — 同上), ADR-008 (Next.js Route Handlers、未作成 — 同上), [ADR-019 (RLS 二層)](../adr/019-rls-two-layer-tenant-isolation.md)
- 関連要件: [F12 V1 機能移植](../requirements/functional/F12-v1-port.md)

## 目的

V1（旧 Firebase 版キミテラス、`../キミテラス/management/`）の既存機能を V2（`apps/web` 配下の Next.js 16 + Cloud Run）に移植するための、画面単位・機能単位のマッピング表と sub-Issue 分割案を確定する。

本ドキュメントを起点に、F0 (V1 移植) を **15 個の sub-Issue (#48-A 〜 #48-O)** に分割し、それぞれ ≤500 行の PR スコープに収める（[CLAUDE.md ルール 6](../../CLAUDE.md)）。

## V1 全体像（調査結果）

- **Framework**: Next.js 16 (App Router、`output: "export"` で SPA 静的 export)
- **Firebase SDK**: v12.12.0（`firebase/app` / `firestore` / `auth` / `storage` / `functions`）
- **総コンポーネント数**: 85 ファイル、約 8,500 行
- **テスト**: Vitest 4 ファイル（V2 では Playwright e2e を追加する）
- **重要な性質**:
  - 静的 export で SPA 化 → Cloud Run に SSR 移植する際、データ取得タイミングを再設計
  - Firestore `onSnapshot` でリアルタイム購読 → V2 では LISTEN/NOTIFY か短ポーリングに置換
  - 認証は Firebase Auth UI、V2 は Identity Platform + Server Component
  - ストレージは Firebase Storage、V2 は GCS（asia-northeast1）に直接置換可能（URL 形式互換）

## V1 → V2 ルート対応表

| V1 ルート | 用途 | V1 コンポーネント | V1 行数目安 | V2 ルート | V2 アーキ |
|---|---|---|---|---|---|
| `/` | サイネージ表示（公開） | `src/components/signage/SignagePage.tsx` ほか | 1,462 行 | `/signage/[classToken]` | Server Component + Client island で再生制御、Server Actions で次データ取得 |
| `/manage` | 認証後リダイレクト | （routing only） | — | `/admin`（共通レイアウト） | Next.js App Router の layout で role 分岐 |
| `/manage/editor` | スケジュール/連絡/宿題エディタ（PC） | `src/components/editor/EditorTargetMenu` 他 | 1,994 行 | `/admin/editor` | Server Action 主体、楽観 UI は localState、確定時に POST |
| `/manage/editor-mobile` | エディタ（モバイル簡易版） | （editor 流用） | — | `/admin/editor`（同一ルート + viewport 分岐） | Tailwind / CSS で responsive、コードを一本化（V1 の二重実装を解消） |
| `/manage/admin` | システム管理者ダッシュボード | `src/components/admin/SchoolListView` ほか（うち `SchoolDetailView` 単独 2,282 行が圧倒、移植時は再分割必須） | 4,463 行 | `/admin/system/*` | RLS bypass は不可、middleware で system_admin チェック ([ADR-019](../adr/019-rls-two-layer-tenant-isolation.md)) |
| `/manage/school-admin` | 学校管理者ハブ | `src/components/school-admin/SchoolAdminHub` | — | `/admin/school` | school_id スコープ |
| `/manage/class-settings` | クラス設定（広告・静粛時間） | `src/components/class-settings/*` | 938 行 | `/admin/classes/[classId]` | Server Action、画像 upload は signed URL 経由 GCS 直接 PUT |
| `/manage/guide` | ガイド + フィードバック（非認証） | （guide page） | — | `/guide` | Route Handler `POST /api/feedback` で受信、school 一覧は public read API |
| `/manage/login` | ログイン | `src/components/auth/LoginPage` | 294 行 | `/login` | Identity Platform redirect (ADR-003 未作成、[#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94)) + magic link ([ADR-016](../adr/016-class-magic-link-anonymous-access.md)) |

## Firestore コレクション → PostgreSQL テーブル対応

| V1 Firestore パス | V1 構造 | V2 テーブル | V2 RLS Policy | 備考 |
|---|---|---|---|---|
| `schools/{schoolId}` | document | `schools` | `tenant_self_read` / `tenant_isolation_modify` / `_delete` / `system_admin_full_access` (PR #103 / ADR-019 規約) | 既存 |
| `schools/{schoolId}/config/*` | 設定 sub-collection | `school_configs` (新規 or schools 列拡張) | `tenant_isolation` | display_settings / quiet_hours / schedule_templates の 3 種 |
| `schools/{schoolId}/master_daily_data/{dateStr}` | 学校全体デフォルト | `daily_data` (school_id + scope='school' + date) | `tenant_isolation` | scope 列で school / grade / class / department を区別 |
| `schools/{schoolId}/grades/{gradeId}` | 学年 | `grades` (新規) | `tenant_isolation` | composite key (school_id, grade_id) |
| `schools/{schoolId}/grades/{gradeId}/classes/{classId}` | クラス | `classes` (既存) | `tenant_isolation` | 既存 |
| `schools/{schoolId}/grades/{gradeId}/classes/{classId}/daily_data/{dateStr}` | クラス別日次 | `daily_data` (scope='class') | `tenant_isolation` | scope を判別、Materialized View で階層マージ可 |
| `schools/{schoolId}/grades/{gradeId}/classes/{classId}/ads` | 広告 Array | `ads` (新規、school_id + class_id nullable + grade_id nullable で 3 階層) | `tenant_isolation` | 配列 → 1 行/広告に正規化、display_order 列を追加 |
| `schools/{schoolId}/departments/{deptId}` | 学科（学科モード時のみ） | `departments` (新規) | `tenant_isolation` | hierarchyMode='department' の学校でのみ使用 |
| `feedback` (root) | フィードバック | `feedback` (新規、school_id nullable) | `system_admin_only` | guide page から非認証で書き込み、system_admin のみ閲覧 |

**未網羅**: V1 `firestore.rules` を別途 grep し、上記表に漏れがあれば追補（sub-Issue #48-A の前段で）。

## Firebase API → V2 置換マップ

| V1 機能 | V1 実装 | V2 置換 | 移植時の注意 |
|---|---|---|---|
| `onSnapshot` リアルタイム購読 | useSignageData / useEditorData 等 | (a) 5 秒短ポーリング (Server Action) または (b) LISTEN/NOTIFY + EventSource (SSE) | 初期実装は (a)、サイネージは描画頻度低いので 5-10 秒で十分。**ただし 50 台/校 × 5 秒 = 10 req/s/校で Cloud SQL コネクション圧迫の懸念**、#48-E 着手前に NFR (パフォーマンス) と突き合わせ要。学習用にエディタ画面のみ (b) 検証 |
| `getDoc` / `getDocs` 単発取得 | SchoolDetailView 等 | Drizzle `select()` + RLS | RLS context (`SET LOCAL`) を必ず middleware で設定 |
| `setDoc` / `updateDoc` 書込 | AdManager / QuietHoursConfig | Drizzle `insert()` / `update()` + audit_log trigger | NFR04 ハッシュチェーン対象、actor_user_id 必須 |
| Firebase Storage upload | AdManager | GCS signed URL → ブラウザから直接 PUT | media-pipeline は別 PR、URL 形式は互換維持 |
| Firebase Auth (UI + SDK) | LoginPage / AuthGuard | Identity Platform redirect (ADR-003 未作成、[#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94)) + Server Component で session cookie 検証 | magic link は別実装 ([ADR-016](../adr/016-class-magic-link-anonymous-access.md)) |
| Cloud Functions `httpsCallable` | firebase-functions.ts (327 行) | Next.js Route Handlers (ADR-008 未作成、[#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94)) | 1:1 で move、callable 名は `/api/admin/*` 等に namespace |

## 広告階層マージロジック

V1 の特徴である「学校 → 学年 → クラス（→ 学科）」の **3-4 階層広告マージ** ロジック:

- V1 ファイル (3 ディレクトリ分散):
  - `src/components/admin/HierarchicalAdsTab.tsx` (661 行、編集 UI)
  - `src/hooks/useAdRotation.ts` (191 行、再生制御)
  - `src/components/signage/AdDisplay.tsx` (107 行、表示)
- 動作: 親階層の広告を「編集不可」として子階層に伝搬、`isQuietTime` で再生/停止
- V2 設計案:
  - `ads` テーブルに `school_id` (NOT NULL) + `grade_id` (nullable) + `class_id` (nullable) + `department_id` (nullable)
  - **Materialized View** `effective_ads_per_class` で 3 階層マージを SQL で実行（クエリ側で OR + display_order）
  - サイネージ Server Component で View を SELECT、Client Island で rotation
  - 画像 prefetch (V1 の `src/lib/image-cache.ts` 400 行、`ImageCache` クラス) は Service Worker + Cache Storage に置換（オフライン耐性向上）

## 未移植機能（V2 で新規追加）

V1 に存在しないが V2 で追加する機能（[v2-mvp.md §1.2](../requirements/v2-mvp.md) より）:

| 機能 | V1 | V2 | 関連要件 |
|---|---|---|---|
| AI ファイル抽出 (PDF/Word/Excel/画像) | なし | Gemini 構造化 + confidence_score | [F01](../requirements/functional/F01-teacher-file-extraction.md) / [F03](../requirements/functional/F03-ai-structuring.md) / [ADR-017](../adr/017-gemini-ai-structuring-with-confidence.md) |
| 音声/チャット入力 | なし | Gemini stream + Vercel AI SDK | [F02](../requirements/functional/F02-teacher-voice-chat-input.md) |
| 即公開 + 安全網 4 種 | なし | audit_log・rollback・confidence flag・公開先明示 | [F04](../requirements/functional/F04-instant-publish-safety-nets.md) / [ADR-015](../adr/015-instant-publish-with-safety-nets.md) |
| 生徒スマホ/タブレット対話 | なし | magic link + 掲示物 Q&A | [F05](../requirements/functional/F05-class-magic-link.md) / [F06](../requirements/functional/F06-student-qa.md) / [ADR-016](../adr/016-class-magic-link-anonymous-access.md) |
| イベントロギング | なし | view/tap/dwell/ask/presence | [F07](../requirements/functional/F07-event-logging.md) |
| 効果ダッシュボード + AI コメント | なし | Recharts + Gemini 文章生成 | [F08](../requirements/functional/F08-effect-dashboard.md) |
| 月次レポート PDF | なし | system_admin が手動 generate + 配布 | [F09](../requirements/functional/F09-monthly-report.md) |
| 広告主 CRM | なし | advertisers / contracts / communications テーブル | [F10](../requirements/functional/F10-crm.md) / [ADR-018](../adr/018-custom-crm-design.md) |
| ロール管理 (3 層) | school_admin のみ | system_admin / school_admin / teacher | [F11](../requirements/functional/F11-role-management.md) |
| 来場検知センサー (PIR) | LiDAR 構想のみ | SwitchBot Webhook | [F13](../requirements/functional/F13-presence-sensor-webhook.md) / [ADR-020](../adr/020-presence-sensor-switchbot-webhook.md) |
| サイネージ天気予報 | なし | 気象庁 JMA をバックエンド Job で取得→Cloud SQL キャッシュ→端末は DB から表示 (外部直叩きなし) | [F14](../requirements/functional/F14-weather-forecast-signage.md) / [ADR-021](../adr/021-weather-data-source-jma.md) |

**LiDAR センサー (V1 firmware/)**: V2 では [ADR-020](../adr/020-presence-sensor-switchbot-webhook.md) で SwitchBot Webhook 方式に切替、自作 LiDAR は Deprecated。

## Sub-Issue 分割案（#48-A 〜 #48-O、15 個）

V1 全機能を ≤500 行 / PR の粒度で分割した結果、**15 個の sub-Issue** に落ち着く。依存順を考慮した順序で起票推奨:

### Phase 1: 基盤層（F0-A〜F0-D、他の sub-Issue から参照される）

| Sub-Issue | スコープ | 推定行数 | 依存 |
|---|---|---|---|
| **#48-A** | DB スキーマ拡張 (grades / departments / school_configs / ads / daily_data) + drizzle migration | 400 行 | PR #93 (Part C2) merged 済 |
| **#48-B** | Identity Platform 認証基盤 + middleware で RLS context SET LOCAL | 400 行 | #48-A、ADR-003 未作成 |
| **#48-C** | apps/web 共通レイアウト + role 別 navigation + 401/403 ハンドリング | 300 行 | #48-B |
| **#48-D** | Firestore データ移行スクリプト (`scripts/migration/firestore-to-pg.ts`) | 500 行 | #48-A |

### Phase 2: サイネージ表示（F0-E〜F0-G、生徒向けの公開動線）

| Sub-Issue | スコープ | 推定行数 | 依存 |
|---|---|---|---|
| **#48-F** | 広告階層マージ Materialized View + 検索クエリ層 | 400 行 | #48-A |
| **#48-E** | サイネージ表示 Server Component (schedule / notice / assignment 描画 + #48-F の View を SELECT) | 500 行（**要再分割保険**: V1 1,462 行を 500 行に圧縮するため Server Component 化と Client Island 分離で構造が変わる。500 行を厳守できない場合は #48-E1 (描画ロジック) / #48-E2 (再生制御 Client Island) に再分割推奨）| #48-A, #48-C, #48-F |
| **#48-G** | 画像/動画 prefetch + Service Worker キャッシュ | 400 行 | #48-E |

### Phase 3: 教員エディタ（F0-H〜F0-J、PC + モバイル統合）

| Sub-Issue | スコープ | 推定行数 | 依存 |
|---|---|---|---|
| **#48-H** | エディタ Schedule セクション (UI + Server Action + audit_log) | 500 行 | #48-A, #48-C |
| **#48-I** | エディタ Notice / Assignment セクション | 500 行 | #48-H |
| **#48-J** | クラス設定画面（静粛時間 + 広告管理 UI）| 500 行 | #48-A, #48-C |

### Phase 4: 管理者ダッシュボード（F0-K〜F0-M）

| Sub-Issue | スコープ | 推定行数 | 依存 |
|---|---|---|---|
| **#48-K** | 学校管理者ハブ + 学年/クラス/学科 CRUD | 500 行 | #48-A, #48-C |
| **#48-L** | システム管理者: 学校一覧 + 詳細 + 編集（**要再分割保険**: V1 `SchoolDetailView` 単独 2,282 行を含むため、500 行を厳守できない場合は #48-L1 (学校一覧 + 編集) / #48-L2 (詳細ビュー) に再分割推奨）| 500 行 | #48-A, #48-C |
| **#48-M** | システム管理者: フィードバック一覧 + ガイド画面 | 400 行 | #48-A, #48-C |

### Phase 5: 統合 / クリーンアップ（F0-N〜F0-O）

| Sub-Issue | スコープ | 推定行数 | 依存 |
|---|---|---|---|
| **#48-N** | Cloud Functions → Route Handlers 移植（残りの callable）| 400 行 | #48-B |
| **#48-O** | e2e (Playwright): ログイン → エディタ更新 → サイネージ反映の golden path | 300 行 | 全 sub-Issue |

**合計**: 約 6,500 行（PR メタ + テスト含む）。1 sub-Issue ≤500 行を厳守、Reviewer 指摘で追加修正が出る場合は scope を増やさず別 sub-Issue 化。

## 移植時の規律（CLAUDE.md 8 ルール 再確認）

| ルール | V1 移植時の適用 |
|---|---|
| 1. 監査カラム | V1 では `createdAt` のみだったが、V2 では `created_at` / `updated_at` / `created_by` / `updated_by` を全テーブルに追加 (PR #93 で baseline 確立) |
| 2. RLS | Firestore Security Rules は V2 では PostgreSQL RLS に **完全に置換**。アプリ層フィルタは禁止 ([ADR-019](../adr/019-rls-two-layer-tenant-isolation.md))、policy 命名規約も同 ADR §決定 参照 |
| 3. 型単一ソース | V1 は手書き interface 多数だが、V2 では `drizzle-zod` 生成型を真実とする ([CLAUDE.md ルール 3](../../CLAUDE.md)) |
| 4. PII マスキング | V1 は生徒氏名を直接表示する画面なし（クラス単位）だが、V2 でも引き続き個人特定なし維持 |
| 5. Secret Manager | V1 の Firebase config は `.env.local` ベタ書きだったが、V2 は Secret Manager + Workload Identity 必須 |
| 6. 1 PR ≤500 行 | 上記 sub-Issue 分割で達成 |
| 7. テスト緑 | V1 の vitest 4 ファイルは移植せず、V2 で **新規に書き直し**（Drizzle スキーマ前提のため） |
| 8. Terraform | Cloud Run / Cloud SQL / Identity Platform 設定は infrastructure/terraform 配下 (ADR-009 未作成、[#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94)) |

## 切替プラン（cutover）

[docs/runbooks/cutover.md](../runbooks/cutover.md) で別途定義する。本マッピング表は **「何を移植するか」** のスコープ定義であり、**「いつ・どう切り替えるか」** は cutover runbook が担う。

並行運用期間（2 週間想定）中は V1 を本番として残し、V2 は staging で動作確認 → 切替日に DNS のみ V2 へ変更（[STATUS.md 既知リスク](../STATUS.md) 参照）。

## 次のステップ

1. 本マッピング表を PR として merge（本 PR）
2. **sub-Issue #48-A 〜 #48-O を順次起票**（別 PR スコープ、本 PR では起票せず）
3. #48-A (DB スキーマ拡張) を最優先で着手、Phase 1 完了後に Phase 2 以降を並列化

## 関連

- 親 Issue: [#48 F12 V1 既存機能の Cloud Run 移植](https://github.com/cometa-kaito/kimiterrace-v2/issues/48)
- 関連要件: [F12 V1 機能移植](../requirements/functional/F12-v1-port.md)
- アーキテクチャ: [C4 Container](c4-container.md), [C4 Component](c4-component.md), [Data Model](data-model.md)
- セキュリティ: [Threat Model](threat-model.md), [ADR-019 RLS](../adr/019-rls-two-layer-tenant-isolation.md)
