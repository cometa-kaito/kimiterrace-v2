# プロジェクト現在地

> このファイルは Claude Code セッションの起点。新セッションは必ずこれを読む。セッション終了時に必ず更新する。
> **役割を「現在地・進行中・詰まり・不変の参照」に限定。** 過去の引き継ぎ／旧タスク／セッション履歴は [STATUS-archive.md](STATUS-archive.md) に退避済み。各 PR の一次記録は PR body（`gh pr view <N>`）。

- リポジトリ: https://github.com/cometa-kaito/kimiterrace-v2 (public) ／ Issue: https://github.com/cometa-kaito/kimiterrace-v2/issues
- GCP プロジェクト: 本番 `signage-v2-prod`（asia-northeast1・課金有効） ／ staging `signage-v2-staging`（app live・**staging 作業は全てこちら**）
- 規律: [CLAUDE.md](../CLAUDE.md) ／ ロードマップ: [ROADMAP.md](ROADMAP.md) ／ 並行レーン: [parallel-lanes.md](parallel-lanes.md) ／ 検証戦略: [testing/test-strategy.md](testing/test-strategy.md)
- 最終更新: 2026-06-10 ／ 更新者: Claude Code

---

## 現在のフェーズ

**Phase 開発 完了 → Phase 検証 進行中。**

- 全 16 機能 F01–F16 の **feature 実装は完了**（umbrella #41/#43/#46/#47 close）。検証は開発と導入の間の受入ゲート。
- **staging 構築（B1–B5）完了・app live**（[#588](https://github.com/cometa-kaito/kimiterrace-v2/pull/588) cloud_run module + [#589](https://github.com/cometa-kaito/kimiterrace-v2/pull/589) pdfjs font-fix）。
- **#289 実 Vertex ON 完了**: kill-switch `AI_ENABLED` / aiplatform API / F03 PII soft-gate を全 merge → gated image deploy → `AI_ENABLED=true` flip → retired モデル `gemini-1.5-pro-002`→`gemini-2.5-flash` 修正（[#598](https://github.com/cometa-kaito/kimiterrace-v2/pull/598)）→ **app 層 認証 E2E 成功**（実 staging で F03 PII soft-gate 409→override で実 Vertex 抽出/マスク/監査 + F06 chat 実 Vertex SSE を裏取り）。
- **検証 track③（web セキュリティ）= ZAP baseline DAST 0 FAIL / 62 PASS で飽和。track⑤（移行 dry-run）完走。**
- **残 = staging-gated 検証トラック（[#243](https://github.com/cometa-kaito/kimiterrace-v2/issues/243)）+ 多ロール UI テスト（下記「次にやるべき」）。** Claude は調査〜検証を全力、導入は人間担当。

---

## 現在地サマリ（2026-06-08）

- **main HEAD**: `476d36e`（#740 学校編集ページ DB エラーバウンダリ修正 + #743 staging bump）。
- **staging live**: image `web:3db9b38`（2026-06-08 デプロイ）。`/api/health` 200 / `/login` 200 確認済。`migrate_image_tag` は `4b96a30` のまま（schema 変更なし）。
- **本セッション追加（2026-06-08）**: [#740](https://github.com/cometa-kaito/kimiterrace-v2/pull/740) 学校編集ページ（`/admin/system/schools/[id]/edit`）で DB 到達不能時にルートエラーバウンダリに吹き上がるバグを修正（`.catch(→null) + notFound()`）。[#743](https://github.com/cometa-kaito/kimiterrace-v2/pull/743) で staging デプロイ済。
- **★ デプロイ後の残（要 人間/学校入力）**: ①**岐南 TVデバイス実投入** = staging に岐南工業テナント（school+電子工学科+1-3年 grades/classes）が未seed。岐南テナント seed CLI + TV-seed Cloud Run Job を要追加してから `seed-ginan-tv-devices-cli` を実行。②**教員ログイン有効化** = system_admin が `/admin/system/schools/<id>/edit` で学校共通パスワードを設定（学校が選ぶPWゆえ運営/学校が入力）。
- **Cloud Run URL**: `https://kimiterrace-web-5wkl3il5zq-an.a.run.app`（`/api/health` 200）。`AI_ENABLED='true'`（実 Vertex ON・gemini-2.5-flash）。
- **staging 構成**: network + Cloud SQL（`kimiterrace-pg`・private IP `10.60.0.3`・schema/RLS/トリガ/関数 全投入）+ Identity Platform（email/password）+ Cloud Run web。~$95–105/月（Cloud Run scale-to-zero）。
- **コスト停止** = staging cloud_run `ai_enabled=false` に戻して apply（Vertex 即 OFF）、またはフル停止は `terraform -chdir=infrastructure/terraform/envs/staging destroy`。
- 非 dependabot open PR ゼロ。staging 手順書 = [staging-bringup.md](runbooks/staging-bringup.md)、検証 backlog = [#243](https://github.com/cometa-kaito/kimiterrace-v2/issues/243)。

---

## 直近の完了（最新の引き継ぎ）

- 2026-06-10: **多ロール UI follow-up B1 完了 — school_admin が自校 teacher の初回パスワード設定リンクを再発行可能に**（[#781](https://github.com/cometa-kaito/kimiterrace-v2/pull/781) merged, squash `d31b377`）。教員発行の `setupLink` は一度しか表示されず紛失/失効＝行き止まりだった（IdP user 削除→再作成のみ）課題を解消。`reissueStaffSetupLinkAction`（requireRole school_admin + RLS read + `canModifyTargetUser` の role 境界、無効化/email欠落を弾く、IdP 呼び出しは read tx の外、audit に生リンク/email を焼き込まない）+ 一覧の管理可×稼働中 teacher 行に再発行ボタン。reset-link 生成は `generateSetupLinkForExistingUser` に切り出し新規発行と共有。fresh Reviewer APPROVE / CI 13/13 green。**未デプロイ**（prod web イメージ再ビルド + `web_image_tag` bump の通常フローで反映可）。
- 2026-06-06: **🔻 引き継ぎ（最新・次セッション最優先）— ★ 多ロール UI テスト継続中 → 改善点を全修正 → 最終再デプロイ（#618 ソリッドカラー込み）**:
  - **★ 次にやること**: ユーザー依頼「各ロールのテストアカウントを作って Chrome で UI を触り（ボタンの意味を解釈→押下結果を予想→実挙動との差分を確認）改善点を全修正」。**teacher 巡回は前タスクで完了**。**school_admin / system_admin の巡回が未着手**（アカウント発行済・下記）。任意で student（匿名 magic-link 閲覧）。→ 見つけた改善は **全て PR→fresh Reviewer→自律 merge** → 最後に **1回だけ再デプロイ**。
  - **テストアカウント（staging IdP・全て pw `Kimiterrace-E2E-2026`・合成データのみ・再利用可）**:
    - teacher: `e2e-teacher@kimiterrace-e2e.invalid`（uid `e2e51111-0000-4000-8000-000000000002`・**DB users 行あり→読み書き両方OK**）
    - school_admin: `e2e-schooladmin@kimiterrace-e2e.invalid`（uid `...0004`・**claims のみ・users 行なし→読みOK / 書込 happy-path は created_by FK 失敗**。学校管理/教職員の書込を試すなら users 行 seed が要る）
    - system_admin: `e2e-sysadmin@kimiterrace-e2e.invalid`（uid `...0005`・claims のみ・school_id なし・**書込も OK**＝コードが system_admin は created_by=null にするため FK 不要）
    - 学校: 「E2Eテスト高校」`e2e51111-0000-4000-8000-000000000001`。ホーム遷移: teacher→/admin/editor, school_admin→/admin/school, system_admin→/admin/system/schools。
  - **デプロイ状態（重要）**: **live = image `web:548a212`（revision `kimiterrace-web-00007-srg`・前タスクの UI フィックス済・ボタンはまだグラデ版）**。main HEAD = **`be2804c`**（= [#618](https://github.com/cometa-kaito/kimiterrace-v2/pull/618) UI グラデ→ソリッド `#c2410c` 反映済・merged）。**image `web:be2804c` は Cloud Build + AR push 済だが未デプロイ**（`web_image_tag` は `548a212` のまま）。→ **最終再デプロイで be2804c 以降を反映**。
  - **最終再デプロイ手順**: ① 新規修正があれば最新 main から image build（`gcloud builds submit . --project=signage-v2-staging --config=<tmp yaml> --service-account=projects/signage-v2-staging/serviceAccounts/33826309713-compute@developer.gserviceaccount.com`、yaml は `docker build -f apps/web/Dockerfile -t <repo>/web:<sha> .` + `--build-arg GIT_COMMIT/NEXT_PUBLIC_FIREBASE_API_KEY(=terraform output -raw firebase_api_key)/AUTH_DOMAIN=signage-v2-staging.firebaseapp.com/PROJECT_ID=signage-v2-staging` + `images:` + `options.logging=CLOUD_LOGGING_ONLY`、repo=`asia-northeast1-docker.pkg.dev/signage-v2-staging/kimiterrace`）。② `infrastructure/terraform/envs/staging/main.tf` の `local.web_image_tag` を新 sha に bump → PR → fresh Reviewer → CI → 自律 merge。③ `terraform -chdir="infrastructure/terraform/envs/staging" apply -target=module.cloud_run -input=false -auto-approve`（ADC・トークン設定しない）。④ 実機確認（curl ヘッダ + Chrome）。**新規修正が無ければ** be2804c を deploy（tag を `548a212`→`be2804c` に bump して②③）。
  - **Chrome 自動化の罠（実踏）**: `computer type` / `form_input` / Enter は **React 制御入力で不安定**（login は成功する時と入力が state に乗らず `required` で submit がブロックされ進まない時がある／teacher-input textarea・chat 入力は不発で POST が飛ばない）。**navigation + read_page（アクセシビリティツリー）+ screenshot は安定**。挙動テストは「URL 直打ち遷移 + guard(403)確認 + read_page + 予想↔実挙動」を主軸にし、フォーム送信の happy-path はツール制約として割り切る（人間の実入力なら動く・実 Vertex SSE は curl で裏取り済み）。ログインが進まない時は read_page で fresh ref 取り直し + 再試行、または stale ref に注意。アカウント切替はログアウト→再ログイン（新ログインで `__session` 上書き）。
  - **設計の最上位軸（記憶化済 [[project_school_dx_no_teacher_burden]]）**: 校務DX＝先生に新たな工数を発生させない。監視/閲覧系は運営(system_admin)専用、学校側UIは最小入力。UI 判断は常にこの軸で。
  - **このセッションで完了済（参考）**: #605/#606（音声入力 `microphone=(self)`）, #611（MFA 詰まり）, #612（ブランド/ログイン刷新/レスポンシブ/ログイン後遷移/open-redirect）, #614（④監視撤去+エディタ403）, #615（③送信後導線）, #618（グラデ→ソリッド・未deploy）。前タスクの teacher 実機確認で全て live 動作確認済（be2804c のソリッドのみ未反映）。
  - **follow-up（非ブロッカー）**: favicon 226KB 最適化 / MFA の client SDK currentUser 喪失の復元機構（別issue候補）/ 「入力履歴」の nav 掲載（③は導線のみ）/ school_admin 書込 happy-path テスト用に users 行 seed（seed-staging-cli.ts 拡張 or 受容）/ student/signage 巡回はクラス+magic-link 発行が前提（E2E校はクラス0）。

## 今やっているもの（→ GitHub が一次ソース）

> 「いま誰がどのレーンを持っているか」は race-free な GitHub を唯一の真実とする（issue/label/assignee/PR はサーバ側で直列化され、ファイルのように上書きされない）:
>
> | 知りたいこと | 見る場所 |
> |---|---|
> | 稼働中レーンと owner | open issue の `lane:*` ラベル + assignee（`gh issue list --state open`） |
> | in-flight な PR | `gh pr list --state=open` |
> | schema/deps/infra トークンの保持者 | `packages/db/**`・lockfile・`infrastructure/**` を触る open PR（各 1 本のはず） |
>
> 新レーンの claim 〜 land 〜 release の手順は [parallel-lanes.md](parallel-lanes.md) §5/§6。

---

## 次にやるべき（次セッション entry point）

**★ アクティブ = 多ロール UI テスト継続**（詳細・テストアカウント uid・再デプロイ手順は↑「直近の完了（最新の引き継ぎ）」2026-06-06）:

1. **school_admin / system_admin の Chrome UI 巡回**（teacher 巡回は完了済）。任意で student（匿名 magic-link 閲覧）。各ロールのテストアカウント（pw `Kimiterrace-E2E-2026`・合成データのみ）でログイン → ボタンの意味を解釈 → 押下結果を予想 → 実挙動との差分を確認。
2. 見つけた改善は **全て PR → fresh Reviewer spawn → CI green → 自律 `--squash --admin` merge**。
3. 最後に **1 回だけ再デプロイ**（`web:be2804c` のソリッドカラー込み・手順は↑引き継ぎ §最終再デプロイ手順）→ curl ヘッダ + Chrome で実機確認。

**並行/後続（staging-gated 検証・[#243](https://github.com/cometa-kaito/kimiterrace-v2/issues/243)）**: GCS IAM / Cloud Logging PII 走査 / mTLS（NFR03 非要求・後）/ embedding inversion / 実負荷 DoS / requireRole route 適用漏れ監査 e2e / ①機能②UI-UX④非機能 受入。**#289 close 判断**（実装①〜④+app E2E 完了。残 follow-up = [#593](https://github.com/cometa-kaito/kimiterrace-v2/issues/593) embedding Job gate / thinking-budget tuning / モデル ID env 化）。

> **設計の最上位軸**（[[project_school_dx_no_teacher_burden]]）: 校務DX＝先生に新たな工数を発生させない。監視/閲覧系（月次レポート/センサー管理/効果ダッシュボード）は運営（system_admin）専用、学校側 UI は最小入力に徹する。学校側に「見る/管理」機能を足す前に本軸と照合。

---

## 詰まり / 確認待ち

- **school_admin 書込 happy-path** は claims のみのアカウント（users 行なし）で `created_by` FK が失敗。書込を試すなら users 行 seed が要る（`seed-staging-cli.ts` 拡張 or 受容）。読み取りは可。
- **Chrome 自動化の罠（実踏）**: `computer type` / `form_input` / Enter は React 制御入力で不安定（login / teacher-input textarea / chat 入力の送信が不発になる時がある）。navigation + read_page（アクセシビリティツリー）+ screenshot は安定。挙動テストは「URL 直打ち遷移 + guard(403)確認 + read_page + 予想↔実挙動」を主軸にし、フォーム送信の happy-path はツール制約として割り切る（実 Vertex SSE は curl で裏取り済）。
- **並行セッション注意**: 共有 working tree が別セッションに checkout 切替される事例あり。自分の作業は隔離 worktree（`git -C` / ASCII path・`-target` apply）で行う（[[feedback_shared_working_tree_collision]]）。
- staging-gated 検証トラックは staging app が live ゆえ実行可能（前倒し不可だった項目が解禁済）。


---

## 将来追加機能（後送り・現フェーズ対象外）

- **外部システム自動取込み（Google Calendar / メール / Google Classroom / Classi 等）**:
  サイネージのコンテンツ源を外部システムから自動取得する経路。技術ハードルが高い + 外部連携が増えるとセキュリティ攻撃面が広がるため、**現フェーズ（AI 主導コンテンツ生成 MVP）では実装しない**。
  - 方針: 当面は「**自校システム内で完結する閉じた構成**」を維持する（セキュリティ優先）
  - 将来検討時期: AI 主導コンテンツ生成（ファイル抽出 + 生徒対話）が安定運用に乗ってから
  - 判断者: 2026-05-28 ユーザー判断

---

## 重要な未決定事項

- **第三者セキュリティ診断（ペネトレ）の代替策**:
  ユーザー判断で従来型ペネトレは実施しない。
  公立校データを扱う SaaS としては**第三者検証ゼロは推奨できない**。
  代替案（SaaS 型診断、簡易診断、内部チェックリスト、バグバウンティ）を検討する必要あり。
  詳細議論は次セッション。

---

## 重要な近況の判断

- **2026-06-09**: **C方式 TV プロビジョニング機能（v2クラウドUI + ローカルエージェント）を全実装 + prod デプロイ完了**（PR #762 DB / #765 ServerAction / #766 管理UI / #764 agentAPI / #763 F16§9 Slack死活 / #768 infra / #767 ローカルagent、+ deploy 記録 #769）。**機能**: ①`tv_provisioning_jobs`（enum/schema/RLS migrations 0021/queries: create+claim(FOR UPDATE SKIP LOCKED, system_admin cross-tenant)+report(claimed_by 一致必須=状態詐称防止)）②`createProvisioningJobAction`（system_admin → signage_url 発行 + device 事前作成 + magic_link(hash・class∈school は composite FK 強制) + job 作成。signage 純ロジックを packages/db barrel で seed CLI と共通化）③管理UI `/admin/tv-devices/provision`（学校→クラス カスケード + IP/label/MAC/スケジュール 既定平日08-17 + 3秒ライブ進捗）④`/api/tv/provisioning/{claim,[jobId]/status}`（専用 `PROVISION_AGENT_SECRET` 認証 + rate-limit）⑤`scripts/provision-agent/`（Node・preflight 県Wi-Fi/factory-MAC キャプチャ→awaiting_physical 物理手順提示→provisioning install/DeviceOwner/オフタイマー無効/prefs注入/起動。provision-googletv.md §3-7 準拠、secret は base64 で on-device のみ・ログ非出力）⑥infra: 2 secret + cloud_run 配線 + 新規 `cloud_run_job_tv_liveness`（毎分 Scheduler、#94 を初構築）⑦F16§9: TV死活 Slack（up→down🔴/down→up🟢 エッジ）+ OFF緩和撤廃で24/7 tight(120s)。**prod 検証済**: migrate で `tv_provisioning_jobs`+RLS 適用 / web=`3f067e9`（provision UI/API + PROVISION_AGENT_SECRET）/ `prod-provision-agent-secret` v1 投入。`/api/health`200・claim 無鍵401/有鍵200`{job:null}`（新テーブル+RLS+専用secret 疎通）・provision page 307。**残（ユーザーゲート）**: (a) **Slack Incoming Webhook URL** 発行→`prod-slack-webhook-url` 投入で §9 アラート有効化、(b) **liveness Job の prod 有効化** = jobs image build→`local.jobs_image_tag` 実sha→`module.cloud_run_job_tv_liveness` enabled=true→apply（現 enabled=false）、(c) **実機プロビジョニング** = 運用者が provision-agent + adb で実TV（factory reset/県Wi-Fi は人手）。全PR fresh Reviewer 承認 + CI緑 + 自律merge。詳細 [[project_v2_tv_provisioning_deployed]]。
- **2026-06-08（同日・反転して実行）**: ⚠️ 直後にユーザーが下記 deferral を反転し「**今 prod 構築を始めて**」と明示承認 → **v2 本番(prod) bring-up 完了**（PR #753 merged）。`signage-v2-prod` に network(VPC/NAT/connector/PSA) / **cloud_sql `kimiterrace-pg`（Postgres16+pgvector・REGIONAL HA・private IP 10.60.0.2・deletion_protection）** / secret_manager(5・値投入済) / identity_platform(+prod firebase key) / **cloud_run web live=`https://kimiterrace-web-gfbtyrivvq-an.a.run.app`** / migrate+岐南 school/tv seed jobs を全 apply（image=`17449d2`・prod AR）。**migrate=全スキーマ適用** / **岐南テナント seed=created**（schoolId `de422a5b`・電子工学科+1/2/3年+各1クラス・fresh ゆえ重複無）。疎通 `/api/health`200・`/login`200。**残 go-live/cutover**: ①実機TV cutover（実 device_id を `SEED_GINAN_TV_DEVICES_JSON` で seed 実行 + `prod-tv-poll-secret`=旧LP `SWITCHBOT_WEBHOOK_SECRET` 値へ + ルーティング LP薄proxy/DNS）②web `_APP_URL` を実 run URL/独自ドメインへ finalize して再 build（現状は予測URL baked）③Cloud SQL GCP ネイティブ削除保護（task_c5e7bf36）④WIF(prod CI・現状ローカル ADC apply)⑤周辺 module は必要時 enable。手順=[prod-bringup-cutover.md](runbooks/prod-bringup-cutover.md) / 詳細 [[project_v2_prod_cutover_deferred]]。
- **2026-06-08**: **v2 本番(prod)構築 + 実機TV cutover は「現在進行中の開発が終了次第」に実施**（ユーザー判断）。`signage-v2-prod` が未構築（Cloud Run/SQL 無し・確認済）と判明し、本番化は本番コスト + 人手のシークレット投入 + DNS/Vercel/Turso access + 稼働中サイネージへの cutover リスクを伴うため、進行中開発の完了後に集中実施する（2026-05-31 の「staging 完了次第すぐ cutover」を「進行中開発の完了後」に時期調整）。**v2 側は準備完了**: 全16機能 + 2026-06-08 の7改善が main + staging live(`web:2912a3e`)、かつ実機TVを端末操作ゼロで v2 へ向ける土台 `/api/tv/lp-config`（LP互換ポーリング）+ `TV_POLL_SECRET` 配線を実装し staging で実機同形ポーリング3台 HTTP200・🟢稼働中まで実証済。prereq と手順は [[project_v2_prod_cutover_deferred]]（prod bring-up=envs/prod・人手secret / 実device_idは稼働中LPから取得 / TV_POLL_SECRET=LP現値一致 / ルーティング=LP薄proxy or DNS / school seed のクラス重複バグ注意）。
- **2026-05-31**: **F15 (TV デバイスリモート管理) を「PoC 終了後 2026-10〜」から前倒し**（ユーザー判断、2 段階）。(1) **v2 実装は開発フェーズ中に他機能と並行してすぐ着手**し staging まで先行完成。(2) **LP エンドポイント廃止 + Turso→Cloud SQL データ移行 (cutover) も開発 (staging) 完了次第すぐ切り替える**（旧「PoC 期間中は岐南工業 TV が LP Turso を参照し続けるため cutover は PoC 終了後 2026-10-01〜」を反転）。すなわち PoC 期間中（2026/6〜9）であっても v2 が staging で完成した時点で実機 TV を v2 (Cloud SQL) へ切替え LP を廃止する。反映先: [F15 仕様書](requirements/functional/F15-tv-device-management.md) §旧 LP リファレンス実装 / 本 STATUS の entry-point + 2026-05-30 ログ位置づけ。着手時は F15 §実装分割方針の 4 単位（①スキーマ+migration+RLS ②ポーリング API ③管理 UI ④コマンドキュー）で Issue 化してから進める
- **2026-05-28**: Firebase 継続方針を反転、GCP ネイティブ全改修へ → 後日 ADR-000 として記録
- **2026-05-28**: API 層は Next.js Route Handlers に統合（Hono 非採用） → ADR-008 ドラフト要
- **2026-05-28**: API 層に tRPC は使わず、`zod` + REST に統一する暫定方針 → 要 ADR
- **2026-05-28**: **ロードマップを 4 Phase 構成 (調査→設計→開発→導入) に再設計**。「W」表記廃止。Claude 担当 = 調査〜開発（staging 完成まで）、導入は人間担当。Phase 名は調査・設計・開発・導入の固有名で扱う（番号付けしない）
- **2026-05-28**: **AI 機能群 MVP スコープ確定**（本セッション、ユーザー × Claude 議論結果）:
  - **教員入力**: ファイル抽出（PDF/Word/Excel/画像）+ 音声 + チャット → AI 構造化 → 即公開
  - **公開フロー**: 即公開、承認なし。代わりに**安全網 4 種**（audit_log・1-click rollback・AI 確信度フラグ・公開先明示）
  - **生徒アクセス**: クラス magic link で個人特定なし、スマホ/タブレットから閲覧 + 音声/チャット Q&A（掲示物に関する質問のみ、学習・進路は Phase 2）
  - **イベントロギング**: タップ・遷移を全部記録 → 効果可視化の元データ
  - **管理者**: 校務管理者（school_id スコープ）+ システム管理者（cross-tenant、奥村さんのみ）
  - **広告主はシステム外** — 月次レポート + 対面コミュニケーションで伝達。直接システムアクセスなし
  - **CRM 機能を独自追加**（広告主マスタ・契約・コミュニケーション履歴、システム管理者のみ）
  - **RLS**: school_id 単層 + system_admin の cross-tenant policy
  - 外部システム連携は将来送り（[将来追加機能] 参照）
  - 詳細はこのセッションで議論、次セッションで `docs/requirements/v2-mvp.md` に書き下す
- **2026-05-28**: **ブランド訂正** — 公開ブランド名は「**キミテラス**」で統一。LP コード（`C:\Users\20051\Desktop\学校DX事業\06_LP\edix-lp\`）に「Edix」表記が残っているが誤り
- **2026-05-28**: **V1 サイネージ表示の所在訂正** — V1 のサイネージ表示エンジンは既に実装されている。場所は `management/src/components/signage/`（`SignagePage.tsx` 等、root `/` ルートが表示エントリ）。トップレベルの `signage-display/` フォルダは空（過去の分離試行の残骸）。V2 では「一から実装」ではなく「Next.js 16 + Cloud Run へ移植」する
- **2026-05-28**: **コスト天井は当面気にしない方針**（ユーザー判断）。ただし不正対策としての rate limiting（生徒チャットの 1 端末あたり/分のクエリ数制限など）はセキュリティ要件として実装する

---

## 既知のリスク

| リスク | 影響度 | 対応 |
|---|---|---|
| 県 Wi-Fi が IP ベースフィルタの場合、Cloud Run 移行で疎通不可 | 高 | 確認待ち。最悪は Firebase Hosting の前段に Cloud Run を置く構成も可 |
| ペネトレテスト見積が予算超過の可能性 | 中 | 3社相見積もり、SaaS型の脆弱性診断（年契約）も検討 |
| 移行中の既存運用学校（岐南工業）への影響 | 中 | 並行運用期間を 2 週間確保、DNS は最後に切替 |
| AI 機能のコスト膨張（Vertex AI Gemini 利用増） | 中 | コスト天井は意図的に設けないがユーザー判断、rate limiting は不正対策として実装する |

---

## 履歴・参照

- **過去の引き継ぎ（2026-06-05 以前）・旧「次にやるべき」・セッション履歴** → [STATUS-archive.md](STATUS-archive.md)
- 各 PR の一次記録 → 各 PR body（`gh pr view <N>`）／ 各 Issue → `gh issue view <N>`
- 詳細な技術判断 → [docs/adr/](adr/)（ADR 一覧）／ プロジェクト横断の規律 → `~/.claude/projects/.../memory/`
