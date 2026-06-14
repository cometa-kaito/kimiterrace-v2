# ADR-038: 生徒/保護者向け Q&A(RAG) の知識源と embedding バッチの本番有効化

- 状態: Accepted（2026-06-13、ユーザー判断「本番有効化まで進める」/ 学校体験リニューアル item4）
- 日付: 2026-06-13（Proposed / Accepted 同日。embedding バッチ Job の本番点灯に伴う知識源の確定）
- 関連: [ADR-005 (Vertex AI)](005-vertex-ai.md), [ADR-007 (pgvector / 埋め込みモデル)](007-pgvector.md), [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [ADR-028 (F06 回答ポリシー)](028-f06-chatbot-answer-policy.md), [ADR-030 (authoring 時 PII ガード)](030-authoring-time-pii-gate.md), [F06 生徒対話](../requirements/functional/F06-student-qa.md), [`docs/compliance/embedding-pii-masking.md`](../compliance/embedding-pii-masking.md), [CLAUDE.md ルール2 (RLS) / ルール4 (PII) / ルール8 (Terraform)](../../CLAUDE.md), #416 / #365 / #398（embedding バッチ）, #593（AI kill-switch）

## 文脈

生徒/保護者向け掲示物 Q&A（[F06](../requirements/functional/F06-student-qa.md)）の RAG は、`content_versions.embedding`（pgvector）への cosine 近傍検索で「掲示に根拠のある」回答を返す（grounded、[ADR-028](028-f06-chatbot-answer-policy.md)）。embedding を生成・投入する **Cloud Run Job（`apps/jobs/src/embedding/embed-job.ts`、ドライバ `run.ts`）は実装済み**だが、**本番 Terraform では `enabled = false`（雛形）のまま未稼働**だった（`infrastructure/terraform/envs/prod/main.tf` の `module "cloud_run_job"`）。

その結果、本番では `content_versions.embedding` が全 NULL のままで、RAG のベクトル検索が常に 0 件 → `createRagContentProvider` が **MVP 直接取得フォールバック**（`general_supplement`、掲示準拠と断定しない一般補足）に落ち続け、**grounded 回答にならない**（指摘ログ §7/§8）。

また、知識源について 2 つの未確定があった:

1. **誰が知識を投入するか**。当初の F06 は MVP 対象に教員を含み、`/app/teacher-input` 由来のドラフトも掲示物の供給源になりうる設計だった。ユーザー決定により **掲示物 Q&A/teacher-input は教員から撤去**し、Q&A/RAG は **生徒・保護者向け**と再定義された。撤去後、知識を「誰が・どこに」投入するかを確定する必要がある。
2. **既存盤面コンテンツ（サイネージの表示ブロック）を RAG の知識源に再利用するか**。盤面は表示最適化された断片（時間割・天気・広告枠等）で、Q&A の意味検索に適した自然文の知識源とは性質が異なる。

## 候補（知識源）

| 候補 | 概要 | 評価 |
|---|---|---|
| **A. school_admin 管理の published contents（採用）** | `/app/contents` で school_admin が公開した `contents`／`content_versions`（active publish）を embedding 化する既存パイプラインをそのまま知識源にする | **既存資産を再利用**（embedding バッチ・RLS・PII マスク・公開状態ゲートが全て実装済）。教員撤去後も供給主体が school_admin で一貫。最小実装で grounded を達成 |
| B. 盤面コンテンツ（表示ブロック）の再利用 | サイネージ表示ブロックを embedding 化 | 表示断片は自然文でなく semantic search の品質が読めない。スキーマ/公開状態ゲートが contents と別系統で**新規配線が要る**（RLS・PII 境界の再設計）。安全側でない |
| C. 教員 teacher-input ドラフトを供給源に残す | 撤去対象の教員導線を知識源に流用 | **ユーザー決定（教員撤去）に反する**。撤去レーンと矛盾し、運用主体が二重化する |

## 決定

### D1. 知識源 = school_admin 管理の published contents（候補 A）

生徒/保護者向け Q&A(RAG) の知識源は、**school_admin が `/app/contents` で公開した `content_versions`（active publish = `unpublished_at IS NULL`）に固定**する。盤面コンテンツ再利用（B）・教員 teacher-input 残置（C）は**不採用**。

- **理由**: 既存の embedding パイプライン（`listPendingEmbeddingVersions` → `embedPendingContent` → `saveContentEmbedding`、RLS 密結合 SQL）・RAG 検索（`getRelevantPublishedContent`）・PII マスク・公開状態ゲートがすべて contents パイプライン前提で実装済み。最小変更で grounded を達成でき、教員撤去後も供給主体が **school_admin に一本化**される（運用が単純）。
- **教員撤去との関係**: 教員からの掲示物 Q&A/teacher-input 撤去は**別レーン**（`refactor/remove-teacher-accounts-system` 系）で進む UI/権限変更であり、本 ADR の知識源確定とは独立。本 ADR は「撤去後の供給源は何か」を確定する（= published contents）。

### D2. embedding バッチ Job を staging/prod で本番有効化（ルール8）

`module "cloud_run_job"` を `enabled = true` に切り替え、weather/railway/tv_liveness Job と同形に配線する（同一 jobs:`<tag>` イメージを `container_args` で切替）:

- `image` = 既ビルド済み jobs イメージ（embed-job 同梱）。
- `container_args = ["dist/embedding/embed-job.js"]`（tsc emit 後のパス。モジュール既定の `src/...` は stale だったため `dist/...` に修正）。
- `database_url_secret_id = prod-db-url-app`（**kimiterrace_app ロール=非 BYPASSRLS**、ルール2/5）。
- `vpc_connector` = Cloud SQL private IP への内部 egress（`PRIVATE_RANGES_ONLY`、外部 egress 不要）。
- Scheduler はモジュール既定で**毎時起動**（`0 * * * *` JST）。
- `terraform apply` は本番反映ゲート（ユーザー）。本 ADR/PR はコード変更と plan 確認まで（ルール8）。

### D3. バックフィルは別スクリプト不要（バッチ自体が冪等バックフィル）

`listPendingEmbeddingVersions` は **`embedding IS NULL` かつ公開中**の全 version を返す。よって有効化後の**初回スケジュール起動が、既存 `content_versions` を含む未生成分を全て自動でバックフィル**する。以後の起動は差分（新規公開・再公開分）だけを拾う（冪等・コスト抑制）。専用バックフィルスクリプト/Job 引数は不要。

### D4. PII マスキング境界（ルール4）は既存経路を不変で踏襲

embedding は**必ずマスキング後テキスト**で生成する（`embedPendingContent` が `maskPII` → `findUnmaskedPii` fail-closed → `client.embed` の順を強制）。校スコープの職員 roster（`listStaffDisplayNames`、school_admin 降格 context）で氏名を確定マスクし、マスク後も PII 形跡が残る version は **Vertex へ送らず skip**（`blockedUnmaskedPii`、ADR-030）。生徒・保護者は匿名設計で roster を持たないため、`maskPII` の電話/メール正規表現 + fail-closed ゲートが最終防御。本 ADR はこの境界を**一切変更しない**。

### D5. 空知識（embedding 未投入・0 ヒット）時のフォールバック挙動

ベクトル検索 0 件 / 弱い類似のみ / 空質問の場合、`createRagContentProvider` は **MVP 直接取得（最近の公開掲示物）にフォールバック**し、その文脈を **`general_supplement`**（「掲示には無い一般的な情報です」ラベル + 学校固有事実の推測抑止 + 先生誘導、ADR-028 §3）に倒す。バッチ実行後に閾値（cosine 類似度 ≥ 0.70）を満たすヒットが出れば**自動で `grounded` に切り替わる（アプリのコード変更不要）**。embedding 未投入はエラーではなく 0 件ヒット = 正常系として扱う。

## 影響

- **アプリコードの変更はゼロ**: grounded 動作への切り替えは embedding 投入のみで成立する（`context-provider.ts` の既存フォールバック設計どおり）。本 PR は Terraform（Job 有効化）+ Dockerfile 防御 + ADR + テストに閉じる。
- **テナント分離（ルール2）**: バッチは校ごとに `school_admin` 降格 context で走り、RAG 検索は RLS で自校スコープを DB レベル強制する（`school_id` を書かない）。本 ADR で既存の RLS 境界は不変。
- **コスト**: 毎時バッチ + 質問時の embedding 1 本。バッチは未生成分のみ処理する冪等設計でコスト上限が読める。

## 残存リスク / follow-up

- ① **教員撤去レーンとの結線**: `/app/teacher-input` の UI/権限撤去は別 PR。撤去完了までは teacher-input 由来の published contents も知識源に含まれうるが、いずれも school_admin の公開ゲートを通った公開掲示物であり PII 境界は同一（安全側）。
- ② **publish 即時反映ではない**: 毎時バッチゆえ、公開直後〜最大 1 時間は当該掲示物が RAG に未反映（その間はフォールバックの `general_supplement`）。即時性が要件化したら publish 時トリガ（Pub/Sub 等）を別途検討。
- ③ **F06 のチャット route/UI 本体は別 issue（#42）**: 本 ADR は RAG 知識源の供給（embedding 投入）を確定するもので、SSE チャット route・LLM 応答生成・UI の実装完了とは独立。
