# Phase 検証 トラック①: 機能受入テスト — 詳細設計

> 親: [docs/testing/test-strategy.md](../test-strategy.md)
> 関連: [requirements/functional/](../../requirements/functional/README.md) / [CLAUDE.md](../../../CLAUDE.md) / [STATUS.md](../../STATUS.md)

最終更新: 2026-05-31
ステータス: **詳細設計ドラフト**（個別ケースは代表＋拡張方針。横断行列は [traceability-matrix.md](../traceability-matrix.md) に集約予定）

---

## 1. 目的とスコープ（in / out）

統合された **staging** 上で、機能要件 F01–F16 と V1 互換導線が**端から端まで（システムレベルで）成立する**ことを、要件トレーサブルに確認する受入ゲート。「コードが正しい」（shift-left で済）ではなく「**統合された製品が要件を満たす**」を判定する。

### In（このトラックが見る）
- F01–F16 の各**受け入れ条件**が、staging の実コンポーネント（Next.js on Cloud Run + Cloud SQL + Vertex AI + Auth）を通して成立すること。
- 機能をまたぐ **golden path**（教員入力 → AI 構造化 → 即公開 → サイネージ/生徒画面反映）。
- **ロール別到達性**（system_admin / school_admin / teacher / 匿名生徒）と、許可・拒否の両側。
- **V1 互換導線**（管理 UI / サイネージ表示 / 広告階層マージ）の機能等価性。

### Out（他トラック・他フェーズに委譲）
- レイアウト崩れ・WCAG・視覚回帰 → **トラック② UI/UX/GUI**。
- 敵対的攻撃（越境・昇格・インジェクション）の網羅 → **トラック③ セキュリティ**（本トラックは「正常系 + 代表的 deny の機能確認」までに留め、攻めは③へ渡す）。
- 性能・負荷・コスト閾値 → **トラック④ 非機能**。
- 移行突合・監査網羅・コンプラ → **トラック⑤ 移行/監査/コンプラ**。
- 実機（岐南工業の Google TV / SwitchBot 実センサ）・本番データ・本番デプロイ → **導入フェーズ（人間）**。

---

## 2. 前提・環境（staging / 合成データ / 利用ツール）

- **環境は staging 限定**。実生徒 PII・本番投入での試験は**禁止**（CLAUDE.md セキュリティ最優先 / ルール4）。
- **合成データのみ**を使う。シードは e2e の既存資産（[apps/web/e2e/global-setup.ts](../../../apps/web/e2e/global-setup.ts) の `SEED` / `SEED2` / golden class）を母体に、受入用に拡張する（§7）。
- **2 校以上**を必ず seed する（テナント分離・cross-tenant ビューを機能として確認するため。`SEED`=SCHOOL1 / `SEED2`=SCHOOL2 を踏襲）。
- アプリ接続ロールは **非 BYPASSRLS（`kimiterrace_app`）**。migrate/seed のみ superuser。これにより受入経路でも RLS が実際に効く（[playwright.config.ts](../../../apps/web/playwright.config.ts) の `toAppDatabaseUrl` 方針を踏襲）。
- 認証は Auth emulator（teacher）+ 役割別合成ユーザー。Vertex AI は staging プロジェクトの実エンドポイント（PII マスキング経路を本物で通す）。
- ツール: Playwright e2e（既存 `apps/web/e2e/` を拡張）、Claude in Chrome / Preview MCP（手動ウォークスルー補助、利用許可済）、API レベルは Route Handler への直接リクエスト。

---

## 3. shift-left テストとの境界（既存 unit/RLS/API/e2e と何が違うか）

| 観点 | shift-left（PR 単位・開発フェーズ） | 機能受入テスト（本トラック・統合 staging） |
|---|---|---|
| 対象 | 1 コンポーネント / 1 関数 / 1 ハンドラ | **統合された製品全体**（複数 F をまたぐ導線） |
| DB | テスト用 PG（RLS スイートは越境を厳密検証） | **staging の Cloud SQL**（合成データ）で実構成のまま |
| 観点 | 実装の正しさ（型・ロジック・境界） | **要件の充足**（受け入れ条件 ↔ シナリオ ↔ 合否のトレース） |
| AI | `packages/ai` のオフライン検証（PII/Zod/インジェクション） | **Vertex 実呼び出し込み**の end-to-end（構造化 → 公開 → 反映） |
| ゲート | CI green が PR merge 条件 | **トラック横断の go/no-go**（導入可否の判断材料） |

二重化しない原則:
- RLS の**網羅的越境テスト**は [packages/db/\_\_tests\_\_/rls/](../../../packages/db/__tests__/rls/) に残す。本トラックは「ある機能を**正しいロールで使えて、間違ったロールでは到達できない**」という**機能としての**確認に留める（境界条件の全列挙はしない）。
- AI の**マスキング単体検証**は [packages/ai/src/\_\_tests\_\_/](../../../packages/ai/src/__tests__/) に残す。本トラックは「抽出 → 公開 → 表示」の**通し**が成立するかを見る。
- 既存 e2e（`signage.spec.ts` / `golden-path.spec.ts` / `admin-auth.spec.ts`）は**受入シナリオの起点として再利用**し、上に積む（書き直さない）。

---

## 4. テスト対象の分解（F01〜F16 + V1 互換を受入観点でグルーピング）

| グループ | 含む F | 受入の主眼 |
|---|---|---|
| **G1 入力 → 構造化 → 公開**（教員側 golden path） | F01 ファイル抽出 / F02 音声・チャット / F03 AI 構造化 / F04 即公開+安全網 | 自由入力が構造化 JSON になり、確信度・公開先明示・audit・rollback を伴って即公開される |
| **G2 配信・閲覧**（生徒/サイネージ側） | F05 magic link / F06 生徒 Q&A / F12 サイネージ表示・広告階層マージ / F14 天気 | 公開物が匿名生徒・サイネージに反映、Q&A はスコープ内のみ応答、天気は自校 DB から表示 |
| **G3 計測・可視化** | F07 イベントログ / F08 ダッシュボード+AI コメント / F09 月次レポート PDF | view/tap/ask/presence が記録され、ダッシュボード/レポートに集計される |
| **G4 管理・権限** | F10 CRM / F11 ロール管理 / F12 管理 UI（学校・端末・ユーザー） | system/school/teacher の権限階層、CRM は system_admin のみ、CRUD 等価性 |
| **G5 デバイス/センサ運用** | F13 来場検知 Webhook / F15 TV リモート管理 / F16 TV 死活監視 | Webhook 受信 → 正規化 → 集計、TV 設定ポーリング配信、last_seen ギャップでダウン判定（実機は導入フェーズ） |

V1 互換は **F12 を軸に G2/G4 に内包**し、旧 `management/src` 画面との等価性は `docs/architecture/v1-v2-mapping.md` の画面マッピングを参照点にする。

---

## 5. 受入シナリオ設計（代表ケース）

ケースID は `FUN-NNN`。**前提 → 操作 → 期待結果 → トレース元 F** を簡潔に示す。これは代表集であり網羅集ではない（拡張方針は §7）。**deny 系の攻撃網羅はトラック③**へ渡す（ここは機能としての許可/拒否確認まで）。

| ID | 前提 | 操作 | 期待結果 | トレース元 |
|---|---|---|---|---|
| FUN-001 | 認証済み教員（SCHOOL1） | 進路だより PDF をアップロード | Cloud Storage（`school-{id}-uploads/`）に保存され、構造化 JSON 草稿（title/body/suggested_publish_scope/confidence_score）が編集 UI に出る。アップロード/抽出が `audit_log` に記録 | F01, F03 |
| FUN-002 | 認証済み教員 | チャット欄に「明日10時 体育館で説明会」と入力 | 日時・場所・対象が抽出され F01 と同じ編集 UI に流入。音声経路はテキスト化後のみ送信される（音声未保存） | F02, F03 |
| FUN-003 | 抽出済み草稿（confidence_score < 0.7） | 編集 UI を開く | 「⚠️ 要確認」バッジ + 根拠引用が表示される（F04.3） | F03, F04 |
| FUN-004 | 抽出済み草稿 | 公開先を未選択のまま公開 | 公開不可（`publish_scope` 必須、「全校」は既定/強調にしない）。明示選択後に公開成功 | F04.4 |
| FUN-005 | 認証済み教員（golden path） | エディタで連絡を一意文字列に更新 → 保存 → 該当クラスのサイネージ `/signage/{token}` を開く | 更新文字列がサイネージ連絡欄に反映（既存 `golden-path.spec.ts` を起点に拡張） | F04, F12 |
| FUN-006 | 公開済みコンテンツ + 版履歴あり | 教員 UI のタイムラインで「このバージョンに戻す」 | 直前版へ巻き戻り、rollback も新版として記録（履歴は失わない）。`audit_log` に rollback 記録 | F04.1, F04.2 |
| FUN-007 | 有効な magic link トークン | 匿名で `/signage/{token}`（または `/s/{token}`）にアクセス | 自校・自クラスの公開物のみ描画。セッション cookie 発行（個人特定情報なし）。別校の文字列は出ない | F05, F12 |
| FUN-008 | 失効済みトークン（`revoked_at` 設定） | 匿名アクセス | **410 Gone**（機能としての失効確認。濫用攻撃は③へ） | F05 |
| FUN-009 | 教員がクラス magic link を発行 | 有効期限・QR を確認、延長/失効を操作 | 既定 90 日で発行、QR が印刷可能形式で生成、延長/失効が反映 | F05 |
| FUN-010 | 匿名生徒（有効トークン） | 掲示物について「この説明会、うちのクラスも対象？」と質問 | 自校スコープの公開コンテンツのみを RAG 対象に SSE で応答。質問/応答が `ai_chat_*` に保管 | F06 |
| FUN-011 | 匿名生徒 | スコープ外（学習・進路アドバイス）の質問 | 「掲示物の話題から外れます」で誘導なし拒否 | F06 |
| FUN-012 | 匿名生徒がサイネージを閲覧・タップ・質問 | 通常操作 | `events` に view/tap/ask が記録（client_id は cookie UUID のみ、PII なし）。beacon で遷移時もロスなし | F07 |
| FUN-013 | 複数日分のイベント蓄積（合成） | school_admin/teacher でダッシュボードを開く | school_id スコープの時系列・ランキング・Q&A 件数が表示。AI 効果コメントが PII マスキング下で生成。「カメラ非使用」バッジ表示 | F08 |
| FUN-014 | system_admin | cross-tenant ビューを開く | 全校横断の集計が RLS 経由で見える（school_admin には見えない） | F08, F11 |
| FUN-015 | 月初相当の合成データ | 月次レポート生成 Job を staging で実行 → system_admin UI からダウンロード | 学校別/広告主別 PDF が生成され、`monthly_reports` に履歴が残る（自動配信はしない） | F09 |
| FUN-016 | system_admin | CRM で広告主・契約・コミュニケーション履歴を CRUD | 登録/更新/閲覧が成立。**school_admin/teacher はアクセス不可（到達拒否）** | F10, F11 |
| FUN-017 | system_admin / school_admin / teacher の各ログイン | それぞれのホームへ到達 | ロール別 nav・到達先が正しい（teacher→`/admin/editor`、school_admin→自校ハブ、system_admin→`/admin/system`）。未認証は `/login` へ（既存 `admin-auth.spec.ts` 拡張） | F11, F12 |
| FUN-018 | school_admin（SCHOOL1） | 自校 teacher を発行/無効化、他校 teacher の変更を試行 | 自校 teacher の発行/無効化は成功、他校は不可。ロール変更は全件 `audit_log` | F11 |
| FUN-019 | 既存 V1 相当の学校/クラス/コンテンツ構成 | 管理 UI（学校・コンテンツ・端末・ユーザー）と広告階層マージ（system→school→class）を確認 | V1 画面マッピングと機能等価。階層マージの優先度が期待どおり | F12 |
| FUN-020 | 各校に天気キャッシュ（合成 `weather_forecasts`） | サイネージを開く / 外部 API 障害を模擬 | 自校 DB から天気を SELECT 表示（端末は外部直叩きなし）。障害時は last-known-good を継続表示。匿名セッションで読める | F14 |
| FUN-021 | 登録済み `sensor_devices`（合成） | SwitchBot Webhook ペイロードを `POST /api/sensors/switchbot/webhook` に送信（正鍵 / 誤鍵 / 未知 device_mac） | 正鍵+既知 device は `events`（`type=presence`）に正規化。誤鍵は拒否、未知 device は `sensor_webhook_failures` に記録。ダッシュボードに presence ヒートマップ反映 | F13, F07, F08 |
| FUN-022 | 登録済み `tv_devices`（合成） | TV を模した `GET /api/tv/config` ポーリング、管理 UI から signage_url/スケジュール変更 | TV に最新 config が配信され `last_seen_at` 更新。school_admin は自校 TV のスケジュールのみ変更可（権限分離） | F15, F11 |
| FUN-023 | TV が一定時間ポーリング途絶（last_seen ギャップを模擬） | 死活チェッカ Job を staging で実行 | ダウン判定 → ダウン/復帰/再起動の通知が発火、ダウンタイムが記録。スケジュール OFF 時間帯は誤報抑制。school_admin は自校分のみ受信 | F16, F11 |

> 注: 実機（Google TV 実端末・SwitchBot 実センサ）を要する確認は staging では**合成 Webhook / 合成ポーリングで代替**し、実機通しは導入フェーズ（人間）に残す（§10）。

---

## 6. 合否基準（機能ごとの pass/fail 判定基準、未達時の扱い）

### ケース単位
- **pass**: 期待結果が staging 上で再現し、トレース元 F の受け入れ条件を満たす。かつ副作用（`audit_log` 記録・RLS スコープ・PII マスキング）が要件どおり。
- **fail**: 期待結果の不一致、または副作用要件の欠落（例: audit 未記録、別校データ混入、生 PII 送信）。

### グループ単位（重み付け）
- **G1（入力→公開）と G2（配信・閲覧）の golden path（FUN-001〜FUN-012）は必須 pass**。ここが落ちると製品の中核導線が不成立のため **no-go 直結**。
- **セキュリティに直結する機能確認（FUN-007 別校非混入 / FUN-008 失効 410 / FUN-011 スコープ拒否 / FUN-016 CRM 到達拒否 / FUN-018 越権不可）が fail の場合は重大欠陥扱い**（トラック③へエスカレーションし、修正まで no-go）。
- G3/G4/G5 の個別機能 fail は、回避策の有無と導入時期（PoC スコープか）で go-with-conditions を許容しうる（判断は go/no-go レポートで明示）。

### 未達時の扱い
- 検出欠陥は [defect-log.md](../defect-log.md) に集約 → 修正 PR → **Reviewer 別 spawn** → 再検証で閉じる（busy CEO の自律 merge 範囲、CI green ≠ 仕様充足）。
- 修正不能 / スコープ外と判断したものは **既知の制約**として go/no-go レポートに明記（隠さない）。

### このトラックの Exit 合格条件（go/no-go 集約用）
1. golden path（FUN-001〜FUN-012 相当: 入力→構造化→即公開→サイネージ/生徒反映、magic link 閲覧、生徒 Q&A スコープ制御）が **全件 pass**。
2. ロール別到達性（system_admin/school_admin/teacher/匿名生徒）と代表 deny（CRM 到達拒否・失効 410・越権不可・別校非混入）が **全件 pass**。
3. 各 F の主要受け入れ条件が代表ケースでトレース済みで、open な重大欠陥（セキュリティ直結 fail）が **ゼロ**。
4. 残存欠陥はすべて defect-log で追跡され、未修正分は既知制約として go/no-go レポートに明記済み。

---

## 7. 手法・ツール（Playwright e2e 拡張、合成シードデータ戦略、シナリオ自動化）

- **Playwright e2e を受入シナリオ層へ拡張**: 既存 `apps/web/e2e/` を基盤に、受入用 spec を `apps/web/e2e/acceptance/`（新規想定）へ追加。`golden-path.spec.ts` を G1+G2 通しの起点に、ロール別 storageState（teacher は既存 `auth.setup.ts`、school_admin/system_admin は同方式で追加）で到達性ケースを駆動。
- **合成シードの拡張**: `global-setup.ts` の `SEED`/`SEED2`/golden class を母体に、受入で要る合成データ（confidence<0.7 草稿、版履歴、複数日イベント、`sensor_devices`、`weather_forecasts`、`tv_devices`、advertisers/contracts）を**冪等な固定 UUID + ON CONFLICT DO NOTHING** で追加。新規 migration を足したら `global-setup.ts` の loader 配列と RLS 真実ソース（`packages/db/__tests__/_setup/global-setup.ts`）の**両方**に登録（migration-loader-pattern 厳守）。
- **API レベル受入**: UI を経ない経路（Webhook 受信 FUN-021、TV config ポーリング FUN-022、月次レポート Job FUN-015、死活チェッカ FUN-023）は Route Handler / Job への直接リクエストで駆動し、副作用（DB 行・audit）を SQL で突合。
- **AI 経路**: Vertex を staging で実呼び出しし、マスキング往復が成立するか（生 PII がプロンプト/応答ログに残らないか）を確認。非決定な応答は**一意トークン / スキーマ妥当性 / スコープ拒否文言**など決定的アサーションに寄せ、flaky を回避（固定 sleep 禁止・auto-wait）。
- **手動ウォークスルー補助**: 自動化しづらい導線は Claude in Chrome / Preview MCP で記録（ただし合否は自動アサーションを正とする）。

---

## 8. トレーサビリティ（要件F ↔ FUN ケースID ↔ 既存テスト）

- 対応関係は **要件 F → FUN ケースID → 既存 shift-left テスト**の 3 列で管理し、**横断行列は本書に重複させず [traceability-matrix.md](../traceability-matrix.md) に集約**する（test-strategy §7 の成果物構成）。
- 本書は「どの F をどの FUN が代表するか」（§4/§5 の表）を一次ソースとして提供し、matrix 側がそれを全 F × 全ケースに展開・カバレッジ抜けを検出する。
- 抜け検出方針: 各 F の受け入れ条件チェックボックスに対し、最低 1 つの FUN ケースか既存テストが紐づくこと。紐づかない条件は matrix で「未カバー」として可視化し、ケース追加 or 既存テスト参照で埋める。
- **既存テスト参照の規律**: `apps/web/__tests__/` は **feature 別構成**（auth / contents / editor / magic-link / school-admin / signage / system-admin）で、`api/` `ai/` `ui/` `jobs/` `migration/` のサブディレクトリは（teacher-inputs を除き）存在しない。下表は**実在パスのみ実名で参照**し、未存在のカバレッジは「**新設(要確認)**」と明示する（断定しない。トラック③ §8 と同規律）。

| F | 代表 FUN | 既存 shift-left（実在） / 新設(要確認) |
|---|---|---|
| F01/F02/F03 | FUN-001,002,003 | 実在: `packages/ai/src/__tests__/`（抽出・rate-limit）, `packages/ai/src/extract/__tests__/`, `apps/web/__tests__/api/teacher-inputs.api.test.ts` / 新設(要確認): ファイルアップロード受入 e2e |
| F04 | FUN-003,004,005,006 | 実在: `apps/web/__tests__/contents/publish-*.test.ts`, `apps/web/e2e/golden-path.spec.ts` / 新設(要確認): rollback 通し |
| F05 | FUN-007,008,009 | 実在: `apps/web/__tests__/magic-link/*`, `packages/db/__tests__/rls/magic-links.test.ts`, `apps/web/e2e/signage.spec.ts` |
| F06 | FUN-010,011 | 実在: `packages/ai/src/__tests__/prompt-injection/build.test.ts`, `packages/ai/src/pii/__tests__/mask.test.ts` / 新設(要確認): RAG 通し e2e |
| F07/F08/F09 | FUN-012,013,014,015,021 | 実在: `packages/db/__tests__/rls/`（イベント/抽出 RLS）/ 新設(要確認): イベント API・ダッシュボード UI・月次レポート Job の専用テスト |
| F10/F11 | FUN-014,016,017,018 | 実在: `packages/db/__tests__/rls/crm-system-admin.test.ts`, `apps/web/__tests__/system-admin/roles.test.ts`, `packages/db/__tests__/rls/` |
| F12 | FUN-005,007,017,019 | 実在: `apps/jobs/src/migration/__tests__/transform.test.ts`, `apps/web/e2e/signage.spec.ts`, `apps/web/e2e/admin-auth.spec.ts` / 新設(要確認): v1-parity 通し |
| F13/F14 | FUN-020,021 | 新設(要確認): F13/F14 専用テスト（天気 SELECT 全開放 / sensor テナント分離は RLS スイートで担保） |
| F15/F16 | FUN-022,023 | 新設(要確認): F15/F16 専用テスト（config ポーリング / last_seen ギャップ判定） |

---

## 9. 成果物・記録

- 受入 spec 群: `apps/web/e2e/acceptance/`（新規想定）と拡張した `global-setup` シード。
- [traceability-matrix.md](../traceability-matrix.md): 要件 ↔ FUN ↔ 既存テスト ↔ 合否（本トラックが供給する行を含む）。
- [defect-log.md](../defect-log.md): 検出欠陥 → 修正 PR → 再検証の追跡。
- 本トラックの Exit 判定サマリ（§6 の合格条件に対する pass/fail）を、トラック横断 [go-no-go-report.md](../go-no-go-report.md) へ寄稿。

---

## 10. Claude / 人間の境界

| 区分 | 内容 |
|---|---|
| **Claude 主導** | staging 上の受入シナリオ自動化（Playwright/API/Job 駆動）、合成シード整備、欠陥の修正 PR → Reviewer 別 spawn → 再検証ループ。 |
| **人間 / 導入フェーズ** | ① **実機通し**（岐南工業の Google TV 実端末・SwitchBot 実センサでの F13/F15/F16 フィールド確認）、② **本番データ・本番環境**に対する一切の検証、③ 実地での運用フロー（QR 配布・センサ設置・電源運用）の妥当性確認。 |

実機を要する F13/F15/F16 は、staging では合成 Webhook / 合成ポーリングで**機能ロジックまで**を受入し、ハードウェア通しは導入フェーズへ明確に切り出す。

---

## 11. 未決事項

- F04.3 確信度フラグの**データ配線未了**（confidence は `ai_extractions` 側、`contents` に列なし）。FUN-003 を「表示部品 + 配線後の通し」のどちらで合否確定するか、配線タスク完了時期に依存。
- F01/F02 のアップロード・音声 UI の staging 実装到達度（受け入れ条件に未着手項目あり）。未実装機能は FUN ケースを **blocked** とし、no-go ではなく既知制約として扱うか要判断。
- F13/F15/F16 の Issue 未起票（TBD）。受入着手前に Issue 化と staging 実装の有無を確認。
- 役割別 storageState（school_admin / system_admin）の setup 整備（teacher 用 `auth.setup.ts` の横展開）。
- 合成データでの「AI 効果コメント / 月次レポート PDF」の決定的アサーション設計（非決定出力をどこまで固定するか）。
