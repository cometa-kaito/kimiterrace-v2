# 【ドラフト】広告主セルフサービス入稿〜課金〜配信パイプライン (F17–F19)

> **位置づけ**: 学校向けデジタルサイネージ「キミテラス」の広告事業を、広告主からの申込・与信・課金・入稿・審査・配信まで自動化する。
> Gemini と検討した初版仕様を、**現行 v2 コードベース（GCP ネイティブ / Drizzle / Cloud SQL / Cloud Run / GCS / Vertex AI）に整合させた修正版**。
> 既存実装（F01–F16）に **増設**する形で設計する。初版から技術選定が複数変わっている点に注意（§0）。

ステータス: ドラフト（要レビュー） / 作成日: 2026-06-09

---

## 0. 初版（Gemini 仕様）からの修正点サマリ

初版は Prisma + Supabase/Vercel + Google Drive + Cloud Vision + LINE Notify を前提にしていたが、**現行 v2 の実態と矛盾する**。v2 に合わせて以下を差し替える。

| 項目 | 初版（Gemini） | 修正版（v2 整合） | 理由 |
|---|---|---|---|
| ORM | Prisma | **Drizzle ORM** | v2 は `packages/db` が Drizzle。Prisma 併用は不可。 |
| DB | Supabase / Vercel Postgres | **Cloud SQL (PostgreSQL 16 + pgvector)** | v2 既存。RLS 二層（ADR-019）も踏襲。 |
| ホスティング | Vercel | **Cloud Run（scale-to-zero）** | v2 既存。Vercel 固有機能（Cron 等）は使えない。 |
| 長時間処理 | API Route 同期 | **`apps/jobs`（Cloud Run Jobs）+ Cloud Tasks/Pub-Sub** | Vision/動画処理/Drive 中継は API Route だとタイムアウト。 |
| ストレージ | Google Drive API | **GCS（既存 `ad_media` / `upload_storage` バケット + 署名付きURL）** | v2 は `@google-cloud/storage` + per-school prefix が既存。Drive を足す理由がない。 |
| AI 審査 | Cloud Vision（画像のみ） | **Vertex AI Gemini（マルチモーダル）+ 必要なら Video Intelligence** | 動画は Vision で判定不可。v2 は Vertex（asia-northeast1 完結・PII マスキング・kill-switch）が既存。 |
| 通知（LINE） | **LINE Notify** | **LINE Messaging API（公式アカウント push）** | ⚠️ LINE Notify は **2025-03-31 でサービス終了済み**。Notify は使えない。 |
| 通知（その他） | Resend / Chatwork | Resend（メール）/ Chatwork（維持）/ 既存 `communications` 連携 | チャネルは `NotificationChannel` ポートで抽象化。 |
| 死活監視 | 新規実装 | **既存 F16（`tv_devices` / `tv_device_downtime` / `tv_alert_state`）を流用** | 端末死活・ダウン通知は実装済み。再実装しない。 |

---

## 1. 既存資産の再利用方針（重要）

新規にゼロから作らず、**既存テーブル・機構を最大限再利用**する。重複テーブルを作らないこと。

| 関心事 | 既存資産（再利用） | 追加の必要性 |
|---|---|---|
| 広告主アカウント | `advertisers`（F10 CRM, status: prospect/active/paused） | そのまま利用。セルフ登録の入口だけ追加。 |
| 契約・月額 | `contracts`（advertiser_id, monthly_fee_jpy, target_schools jsonb） | 単発出稿（期間課金）には不足 → **`ad_orders` を新設**して紐付け。 |
| 配信される広告 | `ads`（scope 階層 / media_url / media_type / duration_sec / display_order） | 配信レコードはこれを使う。**掲載期間と承認状態が無い → カラム追加 or 中間で管理**（§3.3 で検討）。 |
| 端末 | `tv_devices`（+ commands / downtime / liveness） | 配信先・死活はこれ。新 Monitor テーブルは作らない。 |
| マジックリンク | `magic_links`（token_hash / SECURITY DEFINER `resolve_magic_link` / 90日既定） | **教員1タップ承認**に流用。ただし単回・短命・用途識別が必要 → §3.4。 |
| 監査ログ | `audit_log`（auditOp insert/update/delete） | 与信・審査・承認の証跡に必須。全状態遷移を記録。 |
| ストレージ | GCS `upload_storage`（per-school prefix `uploads/{schoolId}/...`, ADC, env バケット名） | 広告クリエイティブ用に prefix を分離（`ad-creatives/{advertiserId}/...`）。 |
| AI | Vertex AI（PII マスキング / `AI_ENABLED` kill-switch / 全 LLM 呼出監査） | 不適切表現の足切りに流用。 |
| 通知 | `communications`（channel: email/phone/meeting/other） | 営業ログ用。広告主/教員への自動通知は別ポートで実装。 |

---

## 2. 新規ドメインの全体像

広告主が **セルフで申込→与信→入金→入稿→審査→配信** まで進む B2B フロー。運営（system_admin）は審査と例外対応のみ。

```
[広告主] 申込フォーム
   │  (パッケージ選択・期間・動的価格)
   ▼
ad_orders: draft → pending_credit ──(MF Kessai 取引登録/与信)──▶ credit_ok / credit_ng
   │                                                              │ credit_ng → 自動却下メール
   │ credit_ok（枠を HELD→CONFIRMED、請求確定）
   ▼
ad_creatives: awaiting_upload ──(署名URLで GCS 直アップロード)──▶ uploaded
   │
   ▼ 3 段階審査（F19）
ai_review ──(Vertex 足切り NG)──▶ rejected（再入稿URL）
   │ OK
admin_review ──(運営が枠はめプレビューで目視)──▶ rejected / OK
   │ OK
teacher_review ──(マジックリンクで対象校教員が1タップ)──▶ rejected / approved
   │ approved
   ▼
ads（掲載期間つきで配信投入）──▶ [TV端末] /api/devices/playlist が期間内のみ返す
```

---

## 3. データモデル（Drizzle / 新規テーブル）

規約に合わせる: `uuid` PK + `gen_random_uuid()`、`...auditColumns`、enum は `_shared/enums.ts` に追記（**末尾 ADD VALUE で非破壊**）、cross-tenant 整合は composite FK、トークンは `token_hash` のみ（平文を残さない・ルール5）、CHECK 制約で値域固定（ルール3）。

### 3.1 enum 追加（`packages/db/src/_shared/enums.ts`）

```ts
// F17: 広告申込（与信・課金）のライフサイクル。クリエイティブ審査とは別軸（状態爆発回避）。
export const adOrderStatus = pgEnum("ad_order_status", [
  "draft",          // フォーム入力中（未送信）
  "pending_credit", // 送信済・MF Kessai 与信待ち。枠は HELD。
  "credit_ng",      // 与信否決 → 自動却下・枠解放
  "credit_ok",      // 与信通過 → 枠 CONFIRMED・請求確定・入稿案内送付
  "active",         // 掲載中（1枠以上が配信投入済み）
  "completed",      // 掲載期間終了
  "cancelled",      // 取消・返金
]);

// F18: 枠予約の状態（在庫の二重押さえ防止）。
export const slotBookingStatus = pgEnum("slot_booking_status", [
  "held",       // 仮押さえ（hold_expires_at で自動解放）
  "confirmed",  // 与信通過で確定
  "released",   // 期限切れ/与信否決で解放
]);

// F19: クリエイティブ審査の3段階状態。
export const creativeStatus = pgEnum("creative_status", [
  "awaiting_upload",
  "uploaded",
  "ai_review",
  "admin_review",
  "teacher_review",
  "approved",
  "rejected",
]);

// F19: 審査主体（監査・履歴用）。
export const reviewActor = pgEnum("review_actor", ["ai", "admin", "teacher"]);

// F18: MF Kessai 連携の取引状態（Webhook 冪等処理用の内部射影）。
export const mfTxnState = pgEnum("mf_txn_state", [
  "registered",  // 取引登録 API 完了
  "approved",    // 与信通過 Webhook 受信
  "rejected",    // 与信否決
  "billed",      // 請求確定
  "paid",        // 入金確認
  "cancelled",
]);
```

### 3.2 `ad_packages` / `loop_configs`（販売単位・ループ設定）

```ts
// 販売パッケージ（複数 TV 端末 or scope を束ねた販売単位）。価格と対象を定義。
export const adPackages = pgTable("ad_packages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 200 }).notNull(),
  // 期間課金の基準額（税抜）。動的価格はフロントで package×期間×枠数から算出し、確定額は ad_orders に保存。
  basePriceJpy: integer("base_price_jpy").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (t) => ({
  ckPrice: check("ck_ad_packages_price_nonneg", sql`${t.basePriceJpy} >= 0`),
}));

// パッケージ↔配信先（school/scope/tv_device のいずれか）を多対多で束ねる中間表。
export const adPackageTargets = pgTable("ad_package_targets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  packageId: uuid("package_id").notNull().references(() => adPackages.id, { onDelete: "cascade" }),
  schoolId: uuid("school_id").notNull().references(() => schools.id, { onDelete: "restrict" }),
  scope: hierarchyScope("scope").notNull(),
  gradeId: uuid("grade_id").references(() => grades.id, { onDelete: "cascade" }),
  departmentId: uuid("department_id").references(() => departments.id, { onDelete: "cascade" }),
  classId: uuid("class_id").references(() => classes.id, { onDelete: "cascade" }),
  ...auditColumns,
});

// ループ設定（端末/scope ごとの総枠数と1枠秒数）。在庫上限の根拠。
export const loopConfigs = pgTable("loop_configs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: uuid("school_id").notNull().references(() => schools.id, { onDelete: "restrict" }),
  scope: hierarchyScope("scope").notNull(),
  totalSlots: integer("total_slots").notNull(),
  slotDurationSec: integer("slot_duration_sec").notNull().default(5),
  ...auditColumns,
}, (t) => ({
  ckSlots: check("ck_loop_total_slots_pos", sql`${t.totalSlots} > 0`),
  ckDur: check("ck_loop_slot_dur_pos", sql`${t.slotDurationSec} > 0`),
}));
```

### 3.3 `ad_orders`（申込・契約データ）

```ts
export const adOrders = pgTable("ad_orders", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  // 既存 CRM に紐付け。セルフ申込時に未登録なら advertisers を upsert してから紐付ける。
  advertiserId: uuid("advertiser_id").notNull().references(() => advertisers.id, { onDelete: "restrict" }),
  packageId: uuid("package_id").notNull().references(() => adPackages.id, { onDelete: "restrict" }),
  status: adOrderStatus("status").notNull().default("draft"),
  // 掲載期間（JST 固定。timestamptz で保存し、表示・判定は Asia/Tokyo で行う）。
  publishStartAt: timestamp("publish_start_at", { withTimezone: true, mode: "date" }).notNull(),
  publishEndAt: timestamp("publish_end_at", { withTimezone: true, mode: "date" }).notNull(),
  // 申込時に確定した請求額（税抜）。package 基準額×期間×枠数の計算結果スナップショット。
  amountJpy: integer("amount_jpy").notNull(),
  // MF Kessai 取引ID。冪等性・突き合わせのキー。null = 未登録（draft）。
  mfTransactionId: varchar("mf_transaction_id", { length: 128 }),
  mfTxnState: mfTxnState("mf_txn_state"),
  ...auditColumns,
}, (t) => ({
  ixAdvertiser: index("ix_ad_orders_advertiser").on(t.advertiserId),
  ixStatus: index("ix_ad_orders_status").on(t.status),
  // 同一 MF 取引IDの重複登録を DB で弾く（Webhook 冪等性の最後の砦）。
  uqMfTxn: unique("uq_ad_orders_mf_txn").on(t.mfTransactionId),
  ckPeriod: check("ck_ad_orders_period", sql`${t.publishEndAt} > ${t.publishStartAt}`),
  ckAmount: check("ck_ad_orders_amount_nonneg", sql`${t.amountJpy} >= 0`),
}));
```

### 3.4 `slot_bookings`（在庫・二重押さえ防止）

**最重要**: 同一スロットの同時申込を DB で防ぐ。仮押さえは期限つき、確定は与信通過時。

```ts
export const slotBookings = pgTable("slot_bookings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid("order_id").notNull().references(() => adOrders.id, { onDelete: "cascade" }),
  loopConfigId: uuid("loop_config_id").notNull().references(() => loopConfigs.id, { onDelete: "restrict" }),
  slotIndex: integer("slot_index").notNull(),          // 0..total_slots-1
  periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
  status: slotBookingStatus("status").notNull().default("held"),
  holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }), // held のみ。期限切れで掃除ジョブが released。
  ...auditColumns,
}, (t) => ({
  // 同一スロット×期間の二重確定を構造的に禁止（held/confirmed のみ対象、released は除外）。
  // 期間オーバーラップまで厳密にやるなら btree_gist + EXCLUDE 制約（tstzrange &&）を migration で張る。
  uqActiveSlot: unique("uq_slot_active").on(t.loopConfigId, t.slotIndex, t.periodStart, t.periodEnd),
  ixOrder: index("ix_slot_bookings_order").on(t.orderId),
}));
```

> **同時実行制御**: 申込トランザクション内で「対象 loop_config の held/confirmed を `SELECT … FOR UPDATE` で数え、空きがあれば INSERT」。
> 期間オーバーラップを正確に扱うには PostgreSQL の **`EXCLUDE` 制約（`btree_gist`, `tstzrange(period_start, period_end) WITH &&`）** を推奨。`unique` では「同一期間の完全一致」しか弾けない。

### 3.5 `ad_creatives`（広告データ・審査）

既存 `ads` を「承認後の配信レコード」とし、審査中の素材は `ad_creatives` で持つ。承認時に `ads` 行を生成（または `ads` に `creative_id` / 掲載期間 / 承認フラグを足して一体化）。**初版は分離方式**を採る（既存 `ads` への破壊的変更を避ける）。

```ts
export const adCreatives = pgTable("ad_creatives", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid("order_id").notNull().references(() => adOrders.id, { onDelete: "cascade" }),
  // GCS object path（ad-creatives/{advertiserId}/{uuid}.{ext}）。クライアントのファイル名は使わない（traversal 防止）。
  gcsObjectPath: text("gcs_object_path").notNull(),
  mediaType: adMediaType("media_type").notNull(), // 既存 enum 再利用（image/video）
  status: creativeStatus("status").notNull().default("awaiting_upload"),
  // AI 足切り結果（Vertex の safety scores 等）。監査・再現用に生データを保持。
  aiReviewResult: jsonb("ai_review_result"),
  rejectionReason: text("rejection_reason"),
  // 承認後に生成した配信レコード ads.id（双方向トレース）。
  publishedAdId: uuid("published_ad_id").references(() => ads.id, { onDelete: "set null" }),
  ...auditColumns,
}, (t) => ({
  ixOrder: index("ix_ad_creatives_order").on(t.orderId),
  ixStatus: index("ix_ad_creatives_status").on(t.status),
}));

// 審査の全イベント履歴（誰が・いつ・どの段階で・承認/却下）。学校・B2B 相手なので証跡必須。
export const creativeReviews = pgTable("creative_reviews", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  creativeId: uuid("creative_id").notNull().references(() => adCreatives.id, { onDelete: "cascade" }),
  actor: reviewActor("actor").notNull(),       // ai / admin / teacher
  approved: boolean("approved").notNull(),
  reason: text("reason"),
  // teacher の場合の対象校・解決した magic link。actor=ai/admin では null。
  schoolId: uuid("school_id").references(() => schools.id, { onDelete: "set null" }),
  magicLinkId: uuid("magic_link_id").references(() => magicLinks.id, { onDelete: "set null" }),
  ...auditColumns,
}, (t) => ({
  ixCreative: index("ix_creative_reviews_creative").on(t.creativeId),
}));
```

### 3.6 マジックリンク（教員1タップ承認）の扱い

既存 `magic_links` は **F05 のクラス再利用リンク（90日・多人数・consumed しない）**。審査承認リンクは性質が違う（**単回・短命・1教員・承認/却下アクション付き**）。混ぜると危険なので、用途を判別できるようにする。

推奨: `magic_links` に `purpose`（enum: `class_access` / `ad_approval`）と `consume`（単回）方針を追加するか、**別テーブル `ad_approval_links`** を新設。初版は **別テーブル**を推奨（既存 `resolve_magic_link` の振る舞いを汚さない）。

```ts
export const adApprovalLinks = pgTable("ad_approval_links", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  creativeId: uuid("creative_id").notNull().references(() => adCreatives.id, { onDelete: "cascade" }),
  schoolId: uuid("school_id").notNull().references(() => schools.id, { onDelete: "restrict" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull(), // 平文は保存しない（ルール5）
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '72 hours'`),
  consumedAt: timestamp("consumed_at", { withTimezone: true }), // 単回。承認/却下で即時セット。
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ...auditColumns,
}, (t) => ({
  ixToken: index("ix_ad_approval_links_token").on(t.tokenHash),
  ixCreative: index("ix_ad_approval_links_creative").on(t.creativeId),
}));
```

> 解決は既存と同方針の **SECURITY DEFINER 関数 `resolve_ad_approval_link(token_hash)`**（有効行のみ最小カラム返却）に閉じ込める。

---

## 4. コアワークフロー（API / ジョブ）

ルーティングは v2 の `apps/web/app/api/...` 規約に合わせる。長時間処理は `apps/jobs`（Cloud Run Jobs）へオフロードし、Web 側は受付と起動のみ。

### フロー1: 申込〜自動与信・仮押さえ（F17/F18）

- **`POST /api/ad-orders`**（広告主フォーム送信）
  1. Zod でバリデート（package / 期間 / 連絡先）。
  2. **トランザクション内**で advertisers を upsert → `ad_orders`(draft→pending_credit) 作成 → `slot_bookings`(held, hold_expires_at = now()+30min) を `FOR UPDATE` で空き確認のうえ確保。空きが無ければ 409。
  3. **MF Kessai 取引登録 API** を呼び `mf_transaction_id` / `mf_txn_state=registered` を保存。
  4. 受付完了レスポンス（与信は非同期）。
- 動的価格計算はフロント（package×期間×枠数）。**確定額はサーバで再計算して `amount_jpy` に保存**（フロント値を信用しない）。

### フロー2: 与信通過 Webhook 〜 入稿案内（F18 → F17）

- **`POST /api/webhooks/mf-kessai`**
  1. **署名検証必須**（MF Kessai の署名ヘッダを検証。失敗は 401）。
  2. **冪等性**: `mf_transaction_id` で既処理ならスキップ（`uq_ad_orders_mf_txn` + イベントログで二重適用防止）。
  3. 与信通過 → `ad_orders.status=credit_ok` / `slot_bookings.status=confirmed` / 請求確定。否決 → `credit_ng` + 枠解放 + 自動却下メール。
  4. 通過時、`ad_creatives`(awaiting_upload) を作成し、**GCS 署名付きアップロード URL（短命・UUID 採番）** を Resend で広告主に送付。
- アップロード: **`POST /api/ad-creatives/{id}/upload`** または **GCS への直 PUT（V4 署名URL）**。
  - サイズ/MIME/解像度を検証。大容量動画は API Route を経由せず **GCS 直アップロード（resumable）** を使う（Cloud Run のボディ上限・タイムアウト回避）。
  - 保存先は per-advertiser prefix `ad-creatives/{advertiserId}/{uuid}.{ext}`。完了で `status=uploaded`。

### フロー3: 3段階ハイブリッド審査（F19）

1. **AI 足切り（Vertex）**: アップロード完了をトリガに `apps/jobs` のジョブが起動。
   - 画像: Gemini マルチモーダルでアダルト/暴力/NG ワード判定（または Cloud Vision SafeSearch）。
   - 動画: **Video Intelligence API**（Explicit Content Detection）または代表フレーム抽出 → Gemini。**Vision 単体では動画不可**。
   - `AI_ENABLED` kill-switch・PII マスキング・全呼出監査の既存規約に従う。NG → `rejected` + 再入稿リンク自動送付。OK → `admin_review`。
2. **管理者目視**: `apps/web/app/admin/ad-review/[id]` で **実サイネージフレームにはめ込んだプレビュー**（既存 `signage-preview` UI を流用）。OK → `teacher_review`、NG → `rejected`。
3. **教員1タップ承認（マジックリンク）**:
   - 管理者が送信先（対象校教員）とチャネル（メール/LINE/Chatwork）を選択。
   - `ad_approval_links` を発行（token_hash 保存・72h・単回）→ **LINE Messaging API（push）/ Chatwork API / Resend** で通知。
   - 教員はログイン不要で `/ad-approve/{token}` を開きプレビュー確認 → 承認/却下を 1 タップ。`creative_reviews` に記録、`consumed_at` をセット。
   - 複数校が対象のときの集約ルール（全員承認必須か1名でOKか）を `ad_packages` 単位で定義（**初版: 対象校ごとに全員承認必須**）。
   - 全段階通過 → `ad_creatives.status=approved` → `ads` 行を掲載期間つきで生成し `published_ad_id` に記録。

### フロー4: エッジ配信・死活監視（既存 F15/F16 流用）

- **`GET /api/devices/playlist`**（端末ポーリング）
  - **端末認証必須**（既存 `tv_devices` のデバイス資格情報／API キー。無認証で playlist を返さない）。
  - 「承認済 (`ads` に投入済) かつ掲載期間内（JST now が publish_start..end）」の広告とループ順を JSON 返却。期間外は自動除外。
  - **オフライン耐性**: コンテンツ URL に加え `ETag`/バージョンを返し、端末キャッシュで回線断でも再生継続。
- **死活監視は新規実装しない**。既存 F16（`tv_devices.alert_state` / `tv_device_downtime` / 定期チェッカ）をそのまま使い、ダウン時アラートは既存通知経路（LINE Messaging API 等）へ。

---

## 5. 横断要件

- **タイムゾーン**: 掲載期間・与信・審査の判定はすべて **Asia/Tokyo**。DB は timestamptz、表示・境界計算で JST 明示。
- **冪等性**: MF Kessai Webhook、ジョブ再実行、通知送信はすべて冪等キーを持つ（取引ID / creative_id+段階）。
- **キャンセル/返金**: `ad_orders.status=cancelled` 経路と MF Kessai 側の請求取消を定義（初版は手動運用 + API は将来）。**与信通過＝入金ではない**点に注意し、配信開始条件（与信OKで開始 or 入金後）を要確定。
- **RLS 二層（ADR-019）**: 新テーブルも middleware（第一層）+ RLS ポリシー（DB 層）。広告主向けセルフ画面は cross-tenant マスタ（`advertisers`/`ad_orders`）への限定アクセスポリシーを別途設計（広告主は自分の order のみ）。
- **監査**: 与信・各審査・承認・キャンセルの全遷移を `audit_log` / `creative_reviews` に記録。
- **通知の抽象化**: `NotificationChannel` ポート（email=Resend / line=Messaging API / chatwork=API）で実装差し替え可能に。
- **広告主向けレポート**: 掲載実績（配信証跡）。既存 `events`（view/tap）と `advertiser-report` クエリを流用して出稿レポートを生成。

---

## 6. 実装の進め方（提案）

1. **enum + migration**（§3.1）を追加（末尾 ADD VALUE で非破壊）。
2. **Drizzle スキーマ**（`ad_packages` / `loop_configs` / `ad_orders` / `slot_bookings` / `ad_creatives` / `creative_reviews` / `ad_approval_links`）を `packages/db/src/schema/` に追加し `index.ts` に登録。`EXCLUDE` 制約は手書き migration。
3. **`POST /api/ad-orders`**（フロー1: 申込 + 枠確保 + MF Kessai 取引登録）から実装。
4. **`POST /api/webhooks/mf-kessai`**（署名検証 + 冪等 + 入稿案内）。
5. GCS 署名URL アップロード → AI 足切りジョブ（`apps/jobs`）→ 管理者レビュー UI → 教員マジックリンク承認。
6. 承認 → `ads` 投入 → `playlist` 期間フィルタ。

> **未確定事項（要決定）**: ①配信開始は与信OK時点か入金確認後か ②MF Kessai の請求サイクル（都度/月締め）③複数校承認の集約ルール ④`ads` 分離方式 vs カラム追加一体化 ⑤キャンセル返金の自動化範囲。

---

## 付録: 初版仕様との対応表（Gemini ⇄ v2）

| 初版エンティティ | v2 での実体 |
|---|---|
| Monitor | 既存 `tv_devices`（+ `sensor_devices`） |
| AdPackage | 新 `ad_packages` + `ad_package_targets` |
| LoopConfig | 新 `loop_configs` |
| AdOrder | 新 `ad_orders`（+ 既存 `advertisers` / `contracts` 連携） |
| AdCreative | 新 `ad_creatives`（承認後は既存 `ads`） |
| マジックリンク（教員承認） | 新 `ad_approval_links`（既存 `magic_links` は F05 用に温存） |
| 死活監視 | 既存 F16（`tv_device_downtime` / `tv_alert_state`） |
