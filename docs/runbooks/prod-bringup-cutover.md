# 本番(prod)構築 + 岐南工業 実機TV cutover runbook

> **これは何**: `signage-v2-prod` をゼロから建て（[staging-bringup.md](staging-bringup.md) の prod 版）、
> 岐阜県立岐南工業高等学校（電子工学科 1〜3 年）に**現在稼働中**の Google TV サイネージ端末を、
> 旧 LP（`school-signage.net` / Turso）から v2 prod へ **端末操作ゼロ**で切り替えるための、
> 人間が読みながら手を動かす**機械的チェックリスト**。
>
> **いつやる**: [STATUS 2026-06-08 判断](../STATUS.md)で **「現在進行中の開発が完了次第」** に時期調整済。
> 今は実行しない（PoC は現 LP を継続、v2 は staging のまま）。v2 側の**実装は準備完了**
> （全機能 + `/api/tv/lp-config` LP 互換ポーリング + `TV_POLL_SECRET` 配線を staging で実機同形 3 台・HTTP200・🟢稼働中まで実証済）。
>
> **境界（不変）**: Claude は staging までを完成させ本 runbook を整備する。**本番 apply / gcloud / deploy / DNS 切替 /
> 稼働中サイネージへの cutover の実行は人間（導入フェーズ担当）**。本 runbook はその台本。
> 一次規律: [CLAUDE.md](../../CLAUDE.md) ルール5（秘密=Secret Manager のみ）/ ルール8（Terraform のみ）。
>
> **広い文脈との関係**: 本体アプリ + データ（Firestore → Cloud SQL）の本番移行・段階 DNS・旧 Firebase 停止判断は
> [cutover.md](cutover.md) が正。本 runbook は **prod 環境の bring-up** と **岐南 実機 TV の LP→v2 切替（端末操作ゼロ）**に特化する。

---

## 0. このページの構成

- **A. 前提チェックリスト（人間が用意するもの）** — prod プロジェクト現状 / 人間が投入する秘密 / 外部 access / 概算コスト
- **B. v2 prod bring-up** — Terraform enabled 化（依存順）→ 2 段 apply → migrate Job → 岐南 seed
- **C. 実機 TV の本物の device_id を取得** — 稼働中 LP から device 一覧を引く / `TV_POLL_SECRET` を LP 値に一致させる
- **D. TV を v2 へ向ける（端末操作ゼロ）** — (1) LP-as-proxy（推奨）/ (2) DNS repoint + domain mapping
- **E. cutover 実行 + 検証 + ロールバック**
- **F. なぜ LP-compat が要るのか**（補足）

---

## A. 前提チェックリスト（人間が用意するもの）

### A0. prod プロジェクトの現状（実測）

- GCP プロジェクト `signage-v2-prod`（`asia-northeast1`）は**シェルは存在しうるが、Cloud Run / Cloud SQL は未 provision**（[STATUS 2026-06-08](../STATUS.md) で「Cloud Run/SQL 無し・確認済」）。
- Terraform: `infrastructure/terraform/envs/prod/main.tf` は **WIF 以外の全モジュールが `enabled = false`** の雛形（= `apply` しても WIF しか作られない）。state backend は `gs://signage-v2-tf-state`（prefix `envs/prod`）で staging と共有バケット。
- ⚠️ STATUS 冒頭行は prod を「課金有効」と書くが、これは**プロジェクト/請求アカウントのリンクの話**で、**リソースは空**。本 runbook B で初めて中身を建てる。

### A1. 人間が投入する秘密（ルール5: Secret Manager のみ・Terraform は値を持たない）

Terraform（`module.secret_manager`）は**秘密コンテナ（空の secret）だけ**作る。**値は人間が `gcloud secrets versions add` で投入**する。最低限:

| Secret（prod の secret ID。命名は B2 で確定） | 中身 | 用途 |
|---|---|---|
| `prod-db-url-migrator` | migrator ロールの DSN（`postgres://kimiterrace_migrator:...@.../...`） | migrate / seed Job（FORCE RLS 下で system_admin context を張る） |
| `prod-db-url-app` | app ロールの DSN（`postgres://kimiterrace_app:...@.../...`、非 BYPASSRLS） | Cloud Run web service の `DATABASE_URL` |
| `prod-tv-poll-secret` | **TV ポーリング共有シークレット = 旧 LP の `SWITCHBOT_WEBHOOK_SECRET` と同値**（C 参照） | `/api/tv/config`・`/api/tv/lp-config` の認証（`TV_POLL_SECRET` env として注入） |
| （必要に応じて）Identity Platform / JWT 秘密 / Sentry DSN 等 | 各サービスの credentials | staging の `staging-*` secret に対応する prod 版 |

- DB の app / migrator **パスワード**自体も人間が決め、Cloud SQL ユーザ作成時に設定し、上記 DSN に埋めて Secret Manager に入れる（パスワード平文を tfvars / コード / CI ログに置かない）。
- **JSON キーファイル禁止**（ルール5）。Cloud Run は Workload Identity で secret を取得。

### A2. 必要な外部 access（人間しか持たない）

- **DNS レジストラ = お名前.com**: `school-signage.net` のゾーン管理。**D-(2) DNS repoint を採る場合のみ**必須（D-(1) では不要）。
- **Vercel**: 旧 LP（`edix-lp`、`C:\Users\20051\Desktop\学校DX事業\06_LP\edix-lp`）のデプロイ権限（`cometa-kaito`）。**D-(1) LP-as-proxy / E のロールバックで必須**。
- **Turso**: 旧 LP が使う `tv_devices` DB。**実機 device_id の取得**（C は HTTP 経由を推奨するため通常 Turso 直 access は不要だが、HTTP が使えない時のフォールバックとして）。
- GCP `signage-v2-prod` の **owner 権限**（B のブートストラップ apply / secret 投入 / Cloud SQL ユーザ作成）。

### A3. 概算コスト（意思決定材料）

- staging は最小 tier（`db-custom-1-3840` / `deletion_protection=false`）で **≈ $100/mo** 目安。
- prod は `cloud_sql.tier = db-custom-2-7680`（envs/prod/main.tf 既定、staging の倍）+ `deletion_protection=true` + 冗長 + バックアップ + Cloud Run min-instances 等で、**staging より高い**（少なくとも同等以上、構成次第で数倍）。常時 1 校（岐南）規模なら膨らみはしないが、**「課金が走り始める意思決定」**であることを明示。
- 検証が終われば staging は `terraform destroy` で停止できるが、**prod は cutover 後は止められない**（実機サイネージが live）。

---

## B. v2 prod bring-up（[staging-bringup.md](staging-bringup.md) の prod ミラー）

> コード変更（`enabled` flip + 配線）は Claude が PR してよいが、**apply / secret 投入 / Job 実行は人間/CI**。
> 各モジュールの要配線は `infrastructure/terraform/envs/prod/main.tf` のコメントに記載済。

### B0. ブートストラップ（一度きり・owner 権限）

staging-bringup §A と同手順を prod で:

- [ ] **B0-1. state バケット**: `gs://signage-v2-tf-state` 確認（staging と共有・既存のはず）。
- [ ] **B0-2. プロジェクト + 課金**: `signage-v2-prod` に billing account がリンク済か確認（A0）。未なら link（**コスト意思決定**）。
- [ ] **B0-3. API 有効化**: run / sqladmin / secretmanager / identitytoolkit / compute / servicenetworking / iam / cloudscheduler / artifactregistry / cloudkms / logging。
- [ ] **B0-4. WIF ブートストラップ**: `terraform -chdir=infrastructure/terraform/envs/prod apply` を **owner 権限で初回実行**（この時点では WIF モジュールのみ生成＝他は `enabled=false`）。
- [ ] **B0-5. Actions 変数登録**: 出力 `wif_provider_name` / `wif_deploy_sa_email` / `wif_plan_sa_email` を、prod 用 deploy で使う仕組み（GitHub Environment `prod` の variables 等）に設定。以降の apply は CI が keyless で実行可。

### B1. モジュール有効化（依存順 `enabled=false→true`）

`infrastructure/terraform/envs/prod/main.tf` を編集し、**この順で**依存を満たしながら `enabled=true` にする（staging-bringup §B と同じ依存グラフ）:

1. [ ] **network** — VPC / サブネット / **Cloud NAT**（閉域 egress の前提、ADR-021。NAT 無しで weather Job を立てると plan が fail-fast。`module.network.egress_ready` が `cloud_run_job_weather.external_egress_ready` に配線済）。
2. [ ] **cloud_sql** — Postgres16 + pgvector。prod は `tier=db-custom-2-7680`（既定）+ `deletion_protection=true`（モジュール側 prod 既定）。
3. [ ] **secret_manager** — 秘密コンテナ作成（**値は B2 で人間が投入**）。
4. [ ] **identity_platform** — 有効化 + サインインプロバイダ設定（email/password）。
5. [ ] **cloud_run** — web 本体。`image`（B3 の実タグ）/ `vpc_connector`（network）/ `database_url_secret_id`（= `prod-db-url-app`）/ **`tv_poll_secret_id`（= `prod-tv-poll-secret`）** / accessor SA を配線。
   - ⚠️ `tv_poll_secret_id` を空のままにすると `TV_POLL_SECRET` env が注入されず、poll route は **fail-closed で 401**＝TV を接続させない。cutover 前に必ず配線 + 値投入。
6. [ ] **cloud_run_job**（embedding #416）/ **cloud_run_job_weather**（#128）/ **cloud_run_job_reports**（#430）— `image` / `vpc_connector` / `database_url_secret_id` / `report_bucket` を配線。
7. [ ] **report_storage / upload_storage** — GCS バケット（upload は生徒 PII 素材ゆえ CMEK 推奨）。
8. [ ] **logging_iam** — `log_viewer_members`（運用者 + breakglass）を設定（ADR-029）。

### B2. 2 段階 apply（secret_manager → 値投入 → 残り）

ルール5 上、**secret の値は Terraform が持てない**ので apply を分割する:

- [ ] **Phase 1 apply（secret コンテナだけ先に）**: `network` + `cloud_sql` + `secret_manager` を `enabled=true` にして apply。
  - 例: `terraform -chdir=infrastructure/terraform/envs/prod apply -target=module.network -target=module.cloud_sql -target=module.secret_manager`
- [ ] **Cloud SQL ユーザ作成**: `kimiterrace_app`（非 BYPASSRLS）/ `kimiterrace_migrator`（テーブルオーナー）を作成しパスワード設定（[db-migrations.md](db-migrations.md) のロール規律）。
- [ ] **秘密の値を人間が投入**（A1 の表）: `gcloud secrets versions add prod-db-url-migrator --data-file=-` 等で DSN / `prod-tv-poll-secret` を投入。**`prod-tv-poll-secret` の値は C で確定する LP 値と一致させる**。
- [ ] **Phase 2 apply（残り全部）**: `identity_platform` / `cloud_run` / 各 Job / storage / logging_iam を `enabled=true` にして全体 apply。

### B3. image タグを実ビルド済 tag に設定

- [ ] `envs/prod/main.tf`（または locals）の web / migrate image タグを、**Cloud Build 済・Artifact Registry push 済の実 sha** に設定する（staging の `local.web_image_tag` / `local.migrate_image_tag` と同パターン）。
  - 現行 staging live は `web:5ac0622` / `migrate:fc21f81`（[STATUS](../STATUS.md) 参照、cutover 時点の main HEAD を採用）。
  - schema を含む migrate イメージは `teacher_login_enabled`（ADR-032 / 教員ログイン・PR #713/#714）など**最新スキーマ**を含む sha を選ぶこと。

### B4. DB マイグレーション + 岐南 seed（Cloud Run Job）

> すべて migrate イメージに同梱された CLI を Cloud Run Job の command 上書きで実行。接続は **migrator DSN**（`prod-db-url-migrator`）。

- [ ] **B4-1. migrate**: `kimiterrace-migrate` Job を実行しスキーマ（RLS / トリガ / SECURITY DEFINER / `teacher_login_enabled` 含む）を適用。
  - 適用順の単一ソースは `packages/db/__tests__/_setup/global-setup.ts` の loader。SECURITY DEFINER オーナー = migrator の検証は [db-migrations.md](db-migrations.md)（誤ると F05 生徒アクセスが fail-closed で全断）。
  - 実行例: `gcloud run jobs execute kimiterrace-migrate --region asia-northeast1 --project signage-v2-prod`
- [ ] **B4-2. 岐南テナント seed（先に）**: `kimiterrace-seed-ginan-sch`（`dist/seed-ginan-school-cli.js`）を実行。学校「岐阜県立岐南工業高等学校」+ 電子工学科 + 1〜3 年 grades + 各 1 クラス（A組）を作成。
  - `gcloud run jobs execute kimiterrace-seed-ginan-sch --region asia-northeast1 --project signage-v2-prod`
  - ⚠️ **クラス重複バグ注意**（[STATUS 2026-06-08](../STATUS.md)）: `schools.name` は UNIQUE でなく、class の冪等性は `(school_id, grade_id, name, academic_year)` の SELECT→INSERT で担保される（`packages/db/src/seed-ginan-school-cli.ts`）。**学校行を二重に作る / `SEED_GINAN_ACADEMIC_YEAR` を前回と変える**と別クラスが増殖し、後続 TV seed の class 一意解決が `ambiguous→null` に落ちる。prod では学校行が 1 つ・academic_year が一貫していることを seed 後に確認する。
- [ ] **B4-3. 岐南 TV デバイス seed（次に・この順）**: `kimiterrace-seed-ginan-tv`（`dist/seed-ginan-tv-devices-cli.js`）を実行。前提は B4-2 完了（岐南テナント existence、無ければ fail-loud）。
  - `gcloud run jobs execute kimiterrace-seed-ginan-tv --region asia-northeast1 --project signage-v2-prod`
  - 🔴 **最重要: 実機の本物の device_id を使う**。現行の `packages/db/src/seed-ginan-tv-devices.ts` は **staging 用のプレースホルダ device_id**（`0e1c0001-…` / `0e1c0002-…` / `0e1c0003-…`）をハードコードしている。これは TV が初回起動時に自前生成した値ではない。**プレースホルダのまま prod に seed すると、実機がポーリングしてくる本物の device_id が `unknown` 扱いになり cutover が無効になる**。
  - ⚠️ 実装注記: タスク前提の env `SEED_GINAN_TV_DEVICES_JSON` は **現コードには未実装**（CLI は配列を env から読まない）。prod 投入は次のいずれか:
    - (a) **コード変更（推奨）**: `seed-ginan-tv-devices.ts` の `GINAN_ECE_TV_DEVICES` を C で取得した**実 device_id**に差し替える（または env `SEED_GINAN_TV_DEVICES_JSON` を読むよう CLI を拡張する）小 PR を先に land → その sha を含む migrate イメージで Job 実行。
    - (b) **管理 UI / 直接登録**: 実 device_id を `/admin/tv-devices` の登録 UI（または migrator DSN で system_admin context を張った直 INSERT）で 3 台登録する。
  - いずれにせよ device_id は **C で確定した実値**であること。`target_mac` / `schedule` の既定は seed 値（平日 08:00–17:00 表示・各教室の実 MAC）を踏襲してよい。

---

## C. 実機 TV の本物の device_id を取得し、TV_POLL_SECRET を LP 値に一致させる

実機 TV（`com.kimiterrace.tvbridge`）が**現在ポーリングしている device_id** は、TV が初回起動時に生成した UUID で、**旧 LP の Turso にのみ存在**する（本リポジトリ未コミット）。取得経路:

### C1. 稼働中 LP から device 一覧を引く（HTTP・推奨）

旧 LP の `GET /api/tv/config?key=<LP_SECRET>`（device_id 未指定 = **一覧モード**）が、登録済み端末を返す（`apps`… ではなく LP repo `app/api/tv/config/route.ts` の `listTvDevices` 経路）。レスポンスは `{ ok, devices: [{ device_id, label, school_id, target_mac, last_seen_ms, ... }] }`。

- [ ] 実行（`scripts/wake-tv.mjs` の一覧モードがそのまま使える）:
  ```bash
  # edix-lp repo で。SWITCHBOT_WEBHOOK_SECRET = 稼働中 LP の secret（= LP_SECRET）。
  SWITCHBOT_WEBHOOK_SECRET=<LP_SECRET> node scripts/wake-tv.mjs
  # → "登録済みデバイス（device_id / label / last_seen）" を表示。
  # あるいは直接:
  curl "https://www.school-signage.net/api/tv/config?key=<LP_SECRET>"
  ```
- [ ] 出力から**岐南 電子工学科 1〜3 年の 3 台の `device_id`（と label / target_mac）**を控える。これが B4-3 で seed する実値。
- [ ] `last_seen` が直近であること（= 実機が今も LP をポーリングしている）を確認。

`<LP_SECRET>` は **旧 LP の `SWITCHBOT_WEBHOOK_SECRET`**（Vercel env、`app/api/tv/config/route.ts` の `isAuthorized` が参照）。値は人間が Vercel ダッシュボード / `vercel env` で確認する。

### C2. prod の TV_POLL_SECRET を LP 値に「一致」させる（鍵を変えない）

実機 TV には**起動時に焼き込まれた `key`（= LP の `SWITCHBOT_WEBHOOK_SECRET`）**がベイクされており、TV の LAN に入れない以上**リモートで変更できない**。よって:

- [ ] **prod の `prod-tv-poll-secret` の値 = `<LP_SECRET>`（C1 と同一文字列）** にする（B2 の secret 投入時）。
  - v2 の `verifyTvPollSecret`（`apps/web/lib/tv/poll-secret.ts`）は SHA-256 定数時間比較。値が**完全一致**しないと全 TV が 401 になる。
- [ ] **鍵ローテーションは cutover とは別問題・既知の制約**: TV のベイク鍵を変えるには各端末の再構成（ADB / MDM、物理 or リモート管理）が要る。TV の LAN に入れない現状では cutover 時に鍵を変えない。ローテーションが必要になったら端末再構成を伴う別作業として計画する（[cutover.md §3 Phase C](cutover.md) の SWITCHBOT rotation はこの制約を前提に PoC 終了後を想定）。

---

## D. TV を v2 へ向ける（端末操作ゼロ）

実機の poll 先 URL（`school-signage.net/api/tv/config`）も `key` もベイク済で変えられない。**ドメイン/ルーティング側で v2 を返す**ことで端末操作ゼロを実現する。2 案:

### D-(1) LP-as-proxy（**推奨・最も低リスク / 最もリモート**）

旧 LP repo（`edix-lp`、Vercel）の `app/api/tv/config/route.ts` を編集し、**`school-signage.net/api/tv/config` への GET を v2 prod の `/api/tv/lp-config` に forward** する。

- 仕組み: 実機は今まで通り `GET school-signage.net/api/tv/config?device_id=<id>&key=<LP_SECRET>` を叩く。LP がその request を v2 prod `https://<prod-web-domain>/api/tv/lp-config?device_id=<id>&key=<LP_SECRET>` に proxy（または fetch して body をそのまま返す）。v2 は **LP 互換形（snake_case + `commands{}` + `schedule.days_mask`）** を返す（F 参照）ので、実機はアプリ改修なしで解釈できる。
- メリット:
  - **DNS 変更不要**（お名前.com access 不要）。
  - **パス整形が綺麗**: 実機の `/api/tv/config` を v2 の `/api/tv/lp-config` に**マッピングして橋渡し**できる（パスが違っても LP 側で吸収）。
  - **ロールバックが一瞬**: LP の proxy 化を revert（再デプロイ）すれば即 LP 自身が config を返す状態に戻る（E のロールバック）。
- 必要なもの: **人間による Vercel デプロイ**（LP repo の 1 ファイル編集 + deploy）。
- 注意: proxy 先 v2 URL / forward 時の `key` 透過を LP env で設定（秘密は Vercel env、ルール5 相当）。POST（`/api/tv/config` の upsert / wake）は v2 では別経路（`/api/tv/commands`）ゆえ、cutover では **GET の config 配信だけ**を proxy すれば足りる（wake/reload コマンド連携は follow-up、`commands{}` 空で実機は no-op）。

### D-(2) DNS repoint + Cloud Run domain mapping

`school-signage.net`（または専用サブドメイン）を**お名前.com で v2 prod の Cloud Run に向け**、Cloud Run の domain mapping で受ける。

- 必要なもの: **お名前.com access**（DNS レコード変更）+ Cloud Run domain mapping（Terraform 化、ルール8）+ マネージド証明書。
- ⚠️ **パス/形状の考慮**: LP 互換エンドポイントは v2 では **`/api/tv/lp-config`** にある。実機は **`/api/tv/config`** を叩くので、純粋な DNS + domain mapping だけだと **実機の `/api/tv/config` が v2 の native `/api/tv/config`（camelCase + `commands[]`）にヒットして実機が解釈できない**。
  - 解決には (i) v2 側で `/api/tv/config` のパスで LP 互換応答を返すルーティング（rewrite / 別ハンドラ）を足す、または (ii) ロードバランサ層で `/api/tv/config` → `/api/tv/lp-config` に URL 書換、が要る。**追加実装が必要**＝ D-(1) より手数が多い。
- メリット: LP（Vercel）への依存を断てる（最終的に LP を畳むなら最終形）。
- デメリット: DNS 伝播待ち / 証明書 / パス整形 / ロールバックは DNS を戻す（伝播待ちで遅い）。

### 推奨

**まず D-(1) LP-as-proxy** で切替える（端末ゼロ操作・DNS 無変更・即ロールバック）。LP を完全に畳む段階で D-(2) に移行する（その時 v2 側の `/api/tv/config` パス整形を別 PR で用意）。

---

## E. cutover 実行 + 検証 + ロールバック

> **低トラフィック窓**（夜間 / 休校日など、サイネージ表示が止まっても影響が小さい時間帯）に実施する。実機は最大 60 秒ごとに poll するので、切替後 1〜2 分で全台が新経路に乗る。

### E1. 事前確認（cutover 直前）

- [ ] v2 prod が live（`/api/health` 200）。
- [ ] `prod-tv-poll-secret` = `<LP_SECRET>`（C2）。
- [ ] 岐南 3 台の**実 device_id** が v2 prod の `tv_devices` に登録済（B4-3）。
- [ ] v2 prod に対して**手元から**互換エンドポイントを叩き、実機相当の応答を確認:
  ```bash
  curl "https://<prod-web-domain>/api/tv/lp-config?device_id=<実device_id>&key=<LP_SECRET>"
  # → 200 / {version, config:{target_mac,signage_url,schedule:{days_mask,...}}, commands:{}}
  # 未登録 device_id なら {version:0, config:null, commands:{}}（= 実機 no-op）→ 登録漏れを検知
  ```

### E2. 切替（D-(1) 採用時）

- [ ] LP repo の `app/api/tv/config` を v2 `/api/tv/lp-config` への proxy に変更し、**人間が Vercel に deploy**。
- [ ] deploy 直後、再度 `curl school-signage.net/api/tv/config?device_id=<実device_id>&key=<LP_SECRET>` で **v2 由来の応答（LP 互換形）**が返ることを確認。

（D-(2) 採用時は: DNS レコードを v2 に向け、domain mapping + パス整形が有効なことを確認 → 伝播を待つ。）

### E3. 検証（各 TV が v2 をポーリングしている）

- [ ] **v2 管理 UI `/admin/tv-devices`** を開き、岐南 3 台の **`last_seen` が更新され続け → 🟢稼働中** になることを確認（`pollTvConfig` が cross-tenant 解決して last_seen_at を更新する）。
- [ ] 物理的に**サイネージ画面**が継続表示されていること（黒画面 / エラーになっていない）を、現地 or 既存の監視手段で確認。
- [ ] v2 側ログ（Cloud Logging）で 3 device の poll が 200 で来ていること / 401・404・429 が出ていないことを確認。
- [ ] 旧 LP 側で当該 3 台の `last_seen` が**更新されなくなる**（= 実機が LP を叩かなくなった = v2 に乗った）ことを確認。

### E4. ロールバック（live サイネージを最優先で復旧）

実機サイネージは**現役の生徒向け表示**。異常時は秒で戻す:

- **D-(1) の場合**: LP の proxy 化コミットを **revert して Vercel 再 deploy**（または Vercel の Instant Rollback で前リビジョンへ）。LP 自身が再び Turso から config を返す → 実機は次の poll（最大 60 秒）で元に戻る。**最速・最確実**。
- **D-(2) の場合**: お名前.com で DNS を旧 LP（Vercel）に戻す。**DNS 伝播待ち**があるため D-(1) より遅い（cutover に D-(1) を推す理由のひとつ）。
- どちらでも、**旧 LP / Turso のデータと secret はロールバック先として温存**しておく（cutover 成功確認まで LP を畳まない・Turso を消さない）。
- v2 prod 側に問題（DB / Cloud Run）があるだけなら、ロールバックで LP に戻しつつ v2 を直す。

### E5. 後処理（成功確認後）

- [ ] 並行観測期間（例: 数日〜，現役サイネージなので保守的に）を置き、v2 で 3 台 🟢稼働中 + 画面正常を継続確認。
- [ ] LP の TV config 経路 / Turso `tv_devices` を畳む判断は**この後**（[cutover.md §3 Phase C / §6](cutover.md)、SWITCHBOT secret rotation・露出ファイル redact・LP エンドポイント廃止と合わせて）。**鍵ベイクの制約（C2）**上、LP を完全廃止する前に「実機が確実に v2 のみを叩いている」ことを last_seen で裏取りする。

---

## F. なぜ LP-compat（`/api/tv/lp-config`）が要るのか

実機 TV アプリ（`com.kimiterrace.tvbridge`、旧 LP 向けビルド）は、ポーリング応答を **snake_case + `commands{}`（オブジェクト）+ `schedule.days_mask`（Calendar 曜日ビット）** で解釈する。一方 v2 ネイティブの `/api/tv/config` は **camelCase + `commands[]`（配列、ack フロー付き）** で**形が違う**ため、実機をそのまま v2 に向けても解釈できない。`apps/web/app/api/tv/lp-config/route.ts` + `apps/web/lib/tv/lp-compat.ts`（`toLpConfigResponse`）が、v2 native の `pollTvConfig` 結果を LP 互換形に変換して返す**橋渡し**で、これにより**実機アプリを一切改修せず**端末ゼロ操作で v2 へ向けられる（認証・レート制限・cross-tenant 解決・last_seen 更新は native `/api/tv/config` と同一実装を共有）。コマンドキュー（wake/reload）は ack フローが LP と異なるため本互換層では橋渡しせず `commands:{}`（実機は undefined を no-op 扱い）＝ cutover の主目的である**設定配信**に絞っている。

---

## 関連

- [staging-bringup.md](staging-bringup.md): staging bring-up（本 runbook B の元）
- [cutover.md](cutover.md): 本体アプリ + データの本番移行 / 段階 DNS / 旧 Firebase 停止 / SWITCHBOT rotation（Phase C）
- [db-migrations.md](db-migrations.md): DB マイグレーション適用（SECURITY DEFINER オーナー固定 / migrator ロール規律）
- `infrastructure/terraform/envs/prod/main.tf`: prod 雛形（全モジュール `enabled=false`）
- `apps/web/app/api/tv/lp-config/route.ts` / `apps/web/lib/tv/lp-compat.ts`: LP 互換ポーリング
- `apps/web/lib/tv/poll-secret.ts`: `TV_POLL_SECRET` 検証（定数時間）
- `packages/db/src/seed-ginan-school-cli.ts` / `seed-ginan-tv-devices-cli.ts`: 岐南 seed（school → TV の順）
- 旧 LP: `C:\Users\20051\Desktop\学校DX事業\06_LP\edix-lp`（`app/api/tv/config/route.ts` 一覧モード / `scripts/wake-tv.mjs`）
- [STATUS.md](../STATUS.md) 2026-06-08 判断: prod 構築 + 実機 TV cutover は「進行中開発の完了後」
- CLAUDE.md: ルール5（秘密=Secret Manager）/ ルール8（Terraform）
