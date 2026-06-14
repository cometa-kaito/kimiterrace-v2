# Partner API 契約（portal ↔ v2 の接合点 / chokepoint）

作成: 2026-06-10 ／ 状態: **契約ロック（実装はこれに向けて両側独立に進める）**
関連: portal `kimiteras-portal/docs/KIMITERAS-V2-INTEGRATION.md`（K1 原案）／ ルート再設計 実装設計書 §3・§28.3・§37・§40。

> portal（商流 SoR・Supabase/Vercel）と v2（配信 SoR・Cloud SQL/Cloud Run）の**サーバー間API**。
> これが2リポジトリの**唯一の共有面**。portal は Outbox からこの契約に向けて呼び、v2 はこの契約の受け口を実装する。
> **両側はこの契約に固定して独立実装 → 最後に噛み合う**（並行レーンの chokepoint）。

---

## 0. 不変条件

- **ブラウザ非経由**。portal の Vercel サーバー ⇄ v2 の Cloud Run のみ。
- **認証 = 共有シークレット**（後述）。RLS 二層（第一層=シークレット検証 / DB層=`system_admin` policy、ADR-019）。`BYPASSRLS` 不使用。
- **PII 無し**。返すのは集計値のみ（user_id を返さない）。生徒データは渡さない（ルール4）。
- **冪等**。portal 由来IDを冪等キーに upsert（二重反映しない）。
- 追加エンドポイントのみ（既存ルート不変）。`runtime='nodejs'` / `force-dynamic`。

## 1. 認証（共有シークレット）

- env `PARTNER_API_SECRET`（本番=Secret Manager、ローカル/テスト=`.env.local`／CI、ルール5。コード直書き禁止）。
- ヘッダ `x-partner-key: <secret>`（または `Authorization: Bearer <secret>`）。
- 検証は **SHA-256 + `timingSafeEqual`**（定数時間、`lib/tv/poll-secret.ts` と同方式）。未設定/不一致は **401**（fail-closed）。
- portal 側は同値を Vercel env / `integration_secrets` に保持。

## 2. K1 — 効果メトリクス pull（read-only）

```
GET /api/partner/advertisers/{advertiserId}/metrics?ym=YYYY-MM[&by=school]
```
- `advertiserId` = v2 `advertisers.id`（UUID）。`ym` = JST 月。`by=school` で学校別内訳。
- 集計源: 既存 `packages/db` の advertiser-report クエリ（`advertisers→contracts→contract_contents→contents→events` を月集計、`count(distinct events.id)`）。`system_admin` context（cross-tenant）で実行。
- **200**:
```jsonc
{
  "advertiser_id": "uuid",
  "company_name": "…",
  "period": "2026-05",
  "tz": "Asia/Tokyo",
  "totals": {
    "impressions": 12345,   // view（延べ表示）
    "taps": 789,            // tap（リンク/QR）
    "asks": 12,             // ask（Q&A）
    "dwell_seconds": 65432,
    "presence": 3456        // 🆕 接触機会（対象校・期間の presence＝サイネージ前通行。§32: 主役KPI=リーチ）
  },
  "by_school": [ { "school_id":"uuid","school_name":"…","impressions":…,"taps":…,"presence":… } ],
  "contracts": [ { "contract_id":"uuid","status":"active","target_school_count":5,"monthly_fee_jpy":30000 } ],
  "generated_at": "…Z",
  "source": "monthly_reports" // "monthly_reports"(確定) | "live"(速報)
}
```
- ⚠️ **`presence` を追加供給する**（現 advertiser-report は presence 除外＝広告反応指標のみ）。presence は「対象校×契約期間の presence events」を distinct(device_mac) で集計＝**接触機会**（"居た"。"見た"=impressions/reach とは別物、統合マスター §4 で確定）。表記は「接触機会」、視認は断定しない（§32.3）。
- 📌 **`taps` の系譜（Phase5 月次レポート「クリック数」の供給元）**: `taps` = **`linkUrl` を設定した広告のクリックスルー数**。サイネージで広告領域全体をタップした回数（リンク先を新規タブで開く導線）を `type='tap'`・`payload.adId` で計上する（`linkUrl` 無し広告のタップは `<a>` 化されず計上しない）。実装経路 = `SignageClient`（tap テレメトリ）→ `events` → `advertiser-metrics`（`count(distinct events.id) filter (type='tap')`）。**portal の月次レポートはこの `taps` を「クリック数」として表示し「1回以上のみ表示」する**（接触単価=推定は portal 側で `monthly_fee_jpy / presence` から算出）。本注記はフィールド無変更の系譜明示のみ＝**契約ロック不変**（新フィールド `clicks` は追加しない。portal 側で `taps`→クリック数 にマップする）。
- エラー: 401 / 404（advertiser無）/ 422（ym不正）/ 500。冪等・PII無し。

## 3. K3 — 配信 push 受け口（write・Flow B の v2 側）

```
POST /api/partner/delivery
```
- **Body**（portal の承認時に Outbox 経由で送られる）:
```jsonc
{
  "advertiser": { "portalCompanyId":"uuid","companyName":"…","industry":"…","contactEmail":"…","status":"active|prospect|paused" },
  "contract":   { "portalContractId":"uuid","monthlyFeeJpy":30000,"startedAt":"ISO","endedAt":"ISO|null","targetV2SchoolIds":["uuid"] },
  "ads": [ { "portalPlacementId":"uuid","v2SchoolId":"uuid","scope":"school|grade|department|class","scopeRef":"学科名|学年名|クラス名|null","mediaType":"image|video","durationSec":7,"displayOrder":1,"assetFetchUrl":"https://…(短命署名URL)","title":"素材タイトル(広告名)…?","caption":"…?","linkUrl":"…?" } ]
}
```
- **title / caption（広告名 = 「(無題の広告)」修正・運営整理 §4）**: `title` は portal の**素材タイトル（広告名）**で任意（≤60文字）。v2 は専用の `ads.title` 列を持たず **`caption` に流用**する（ユーザー判断 2026-06-14）。正規化規則は **`caption` が明示指定されていればそれを優先、無ければ `title` を `caption` として採用**（両方 null なら null）。これにより月次レポート PDF の「（無題の広告）」フォールバックは caption も title も無い場合のみに限定される。portal は素材タイトルを **必ず** `title`（または `caption`）で送ること。
- **scope / scopeRef（Phase4 §0b 枠モデル）**: `scope` は配信スコープ。`school`=学校全体（`scopeRef`=null）。`department`/`grade`/`class` は `scopeRef` に**対象の名前**（学科名/学年名/クラス名）を入れる。v2 が **`v2SchoolId` の学校内で名前一致解決**して `ads.grade_id`/`class_id`/`department_id` を確定する（`ck_ads_scope` 充足）。非 school で `scopeRef` 欠如は **400**。学校内に対象が無い/曖昧（class 名が複数一致）は **409**（再送で直らない・portal 側を直す）。※学校特定後の sub-scope は名前一致で解決する（学校ブリッジ `v2_school_id` の「名前一致禁止」規律は学校特定のみが対象）。
- **挙動**: `portalCompanyId`/`portalContractId`/`portalPlacementId` を**冪等キー**に `advertisers`/`contracts`/`ads` を upsert。`assetFetchUrl` を v2 が取得して **GCS（ad-media バケット・キー `ads/partner/<portalPlacementId>`）へ再ホスト** → `ads.media_url` には**同一オリジン配信パス `/ad-media/<key>`**（ADR-037・県教委 Wi-Fi FQDN 許可リスト対応。API レスポンス契約には影響しない v2 内部表現）。
- **200**: `{ "applied": { "advertisers":1, "contracts":1, "ads":3 }, "advertiserId":"uuid" }`。
- **冪等**: 同じ portal ID で再送しても二重作成しない（Outbox 再送・§42.1 と整合）。
- **要スキーマ（別PR・schema先行）**: v2 `advertisers` に `portal_company_id uuid unique`、`contracts` に `portal_contract_id unique`、`ads` に `portal_placement_id unique`（+ §13 `ad_slots`/`ads.slot_id`）。**全テーブル監査カラム（ルール1）・RLS（ルール2）・Drizzle 型（ルール3）厳守**。
- エラー: 401 / 400（payload不正）/ 409（整合不能）/ 422 / 500。

## 4. v2 の Read Model 化（§42.2）

v2 が保持する advertiser/contract は **配信判断に必要な最小フィールドの Read Model**（portal=write 正、v2=read 自律）。営業ステータス/コミュニケーション/請求は portal 専有。**portal がダウンしても v2 は配信/停止を自律判断できる**（完全参照にしない）。`status`(active/paused) を K3 で受けて配信可否に反映。

## 5. 実装順（v2 側）

1. **K1**（低リスク・集計クエリ既存）: `lib/partner/secret.ts`（認証）→ `app/api/partner/advertisers/[id]/metrics/route.ts` → presence 集計を追加 → テスト。
2. **K3**（schema 変更 + asset 再ホスト・要分割）: portal_*_id / ad_slots migration（schema PR）→ delivery upsert クエリ（packages/db）→ `app/api/partner/delivery/route.ts` → GCS 再ホスト → テスト。

> ルール6（1 PR ≤500行）: 認証+K1 で1 PR、schema で1 PR、K3 で1 PR に分割。各 PR は Reviewer agent + テスト green（ルール7）。
