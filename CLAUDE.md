# キミテラス v2 開発ガードレール（Claude Code 用）

このプロジェクトは旧 [キミテラス](../キミテラス/)（Firebase 構成）から **GCP ネイティブ構成への全改修版**。
公立高校の生徒データを 10 年保管前提で扱うため、**動けばいい開発は許容しない**。

このファイルは **不変の規律と参照先のインデックス**。現在地は [docs/STATUS.md](docs/STATUS.md) を参照すること。

---

## 必読フロー: 新セッション開始時

1. このファイル（CLAUDE.md）を読む
2. [docs/STATUS.md](docs/STATUS.md) を読む（現在地・進行中タスク・詰まり）
3. 該当 issue / PR を読む
4. `git status && git log -5` で最新状態確認
5. 必要なら Plan agent で実装計画
6. 着手

新セッションが**5分以内に作業に入れる**ことを設計目標とする。

---

## 必読フロー: セッション終了時

1. [docs/STATUS.md](docs/STATUS.md) を更新（次セッションが迷子にならないため）
2. 中途半端なコードもコミット（ローカルにだけ残さない）
3. 重要な技術判断は [docs/adr/](docs/adr/) に追加
4. 詰まりは STATUS.md の「詰まり / 確認待ち」に明示
5. プロジェクト横断の規律が出た場合は `~/.claude/projects/.../memory/` に追加

---

## スタック構成（不変）

| レイヤー | 採用技術 | 理由 → ADR |
|---|---|---|
| フロントエンド | Next.js 16 (SSR + Server Actions) | [ADR-008](docs/adr/008-nextjs-route-handlers.md) |
| デプロイ | Cloud Run (asia-northeast1) | [ADR-002](docs/adr/002-cloud-run-vs-functions.md) |
| 認証 | Identity Platform | [ADR-003](docs/adr/003-identity-platform.md) |
| データ | Cloud SQL for PostgreSQL 16 + pgvector | [ADR-001](docs/adr/001-postgres-vs-firestore.md) |
| ORM | Drizzle | [ADR-004](docs/adr/004-drizzle-vs-prisma.md) |
| AI | Vertex AI Gemini (asia-northeast1) | [ADR-005](docs/adr/005-vertex-ai.md) |
| AI ストリーミング | Vercel AI SDK | [ADR-006](docs/adr/006-vercel-ai-sdk.md) |
| ベクトル検索 | pgvector（PostgreSQL 内） | [ADR-007](docs/adr/007-pgvector.md) |
| IaC | Terraform | [ADR-009](docs/adr/009-terraform.md) |
| パッケージ管理 | pnpm + Turborepo | [ADR-010](docs/adr/010-pnpm-turborepo.md) |
| コード品質 | Biome（ESLint+Prettier 統合） | [ADR-011](docs/adr/011-biome.md) |
| テスト | Vitest + Playwright + Testcontainers | [ADR-012](docs/adr/012-testing-stack.md) |
| API | Next.js Route Handlers（Hono 非採用） | [ADR-008](docs/adr/008-nextjs-route-handlers.md) |
| エラー追跡 | Sentry | [ADR-013](docs/adr/013-sentry.md) |
| 観測 | Cloud Logging + Cloud Trace + OpenTelemetry | [ADR-014](docs/adr/014-observability.md) |

スタック変更は **ADR を新規作成 + 既存 ADR を Superseded にする** 手続きが必要。勝手に変えない。

---

## ルール1: 全テーブルに監査カラムを必ず付ける

### 適用条件
新規テーブル定義時、または既存テーブルにフィールド追加時。

### やること
全テーブルに以下のカラムを **例外なく** 付ける:

```typescript
created_at: timestamp().notNull().defaultNow(),
updated_at: timestamp().notNull().defaultNow(),
created_by: uuid().references(() => users.id),  // nullable: システム作成は null
updated_by: uuid().references(() => users.id),
// 操作元 IP は audit_log テーブル側で記録
```

別途 `audit_log` テーブルで以下を記録:
- who: user_id, ip_address, user_agent
- what: table_name, record_id, operation (insert/update/delete), diff
- when: timestamp

### NG パターン
- 「ログテーブルだから監査不要」 → ログテーブルも改竄検知のため監査対象
- 「マスタテーブルだから更新者は不要」 → 学校マスタの不正書き換えは最も追跡したい

### 理由
公立校データの法定保存と漏洩時の影響範囲特定。監査ログがないと、漏洩時に「誰がどこまで見たか」を立証できない。

---

## ルール2: PostgreSQL の RLS を絶対に無効化しない

### 適用条件
すべての**テナント分離が必要なテーブル**（school_id を持つテーブル全部）。

### やること
1. テーブル作成時に必ず RLS を有効化:
   ```sql
   ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON schedules
     USING (school_id = current_setting('app.current_school_id')::uuid);
   ```
2. アプリ側で接続ごとに `SET app.current_school_id = '...'` を必ず設定
3. RLS テストを `__tests__/rls/` に追加（許可ケース + 拒否ケース両方）
4. `BYPASSRLS` 権限を持つロールは migration 用以外作らない

### NG パターン
- アプリ側のクエリで `WHERE school_id = ?` を書いて「これで安全」と判断する → アプリのバグで条件が抜けたら全テナント漏洩する。**DB レベルで強制する**
- テストデータ用に RLS を無効化したまま忘れる
- SECURITY DEFINER 関数で意図せず RLS をバイパスする

### 理由
旧 Firebase の `firestore.rules` は型なし DSL でテスト必須だったが、PostgreSQL RLS は SQL なのでテストが書きやすい。**だからこそ確実にテストを書く**。

---

## ルール3: 型は Drizzle スキーマを真実の単一ソースとする

### 適用条件
Firestore と違い PostgreSQL はスキーマありなので、**スキーマからの型生成を強制**できる。

### やること
1. スキーマ変更は `packages/db/schema/*.ts` のみで行う
2. 型は `drizzle-kit` で自動生成、手書きの interface でドメイン型を再定義しない
3. API レスポンス型は **DB 型から派生** させる（`InferSelectModel<typeof schedules>`）
4. Zod スキーマも `drizzle-zod` で DB スキーマから生成
5. `as any` / `as unknown as Foo` は禁止。型エラーは根本原因を直す

### NG パターン
- `types/schedule.ts` を手書きで作って DB と二重管理 → 必ずズレる
- API ハンドラで匿名オブジェクトリテラルを返す → 型が効かない
- migration を手書き SQL でやって drizzle スキーマと不整合

### 理由
旧 CLAUDE.md ルール3 と同じ思想を、PostgreSQL では「型自動生成」で機械的に強制する。人力レビューに依存しない。

---

## ルール4: PII の Vertex AI 送信前にマスキング

### 適用条件
- LLM (Gemini) を呼ぶハンドラ全部
- RAG の embedding 生成

### やること
1. 送信前に PII（生徒氏名・住所・電話・保護者名）を **トークン化**:
   ```
   "田中太郎さんは欠席" → "{{STUDENT_001}}さんは欠席"
   ```
2. LLM 応答後に逆変換
3. embedding は **マスキング後のテキスト**で生成（漏洩リスク最小化）
4. プロンプトに渡すコンテキストは `school_id` でスコープされた行のみ
5. すべての LLM 呼び出しを `audit_log` に記録

### NG パターン
- 「Vertex AI は同 GCP 内だから安全」と判断して生 PII を投げる → モデルログ・キャッシュに残る可能性
- プロンプトインジェクションでスコープ外データを引き出される設計

### 理由
LLM への送信は**事実上の外部委託**。Google 内であっても、モデルプロバイダ側のログ・将来の学習データに含まれる可能性を排除する設計を取る。

---

## ルール5: シークレットは Secret Manager のみ、コード/環境変数禁止

### 適用条件
API キー、DB 認証情報、JWT 秘密鍵、外部サービス credentials すべて。

### やること
1. Secret Manager に格納
2. Cloud Run は Workload Identity で取得（**JSON キーファイル禁止**）
3. ローカル開発も `gcloud secrets versions access` または `direnv` 経由
4. `.env*` ファイルは `.gitignore`、`.env.example` のみコミット
5. CI 上では Secret Manager または GitHub Secrets

### NG パターン
- `.env` ファイルをコミット
- ハードコードされた API キー
- ログに secret を出力（Cloud Logging の検索でヒットする）
- service account JSON キーをファイルで配布

### 検知
- pre-commit hook で `gitleaks` 実行
- CI で `gitleaks` 再実行
- 万一漏洩した場合は **24時間以内に rotate**（手順は [docs/runbooks/secret-rotation.md](docs/runbooks/secret-rotation.md)）

---

## ルール6: 1 PR = 1 機能、500 行を目安、必ずレビュー可能に

### 適用条件
すべての PR。

### やること
1. 1 つの目的に絞る。不要な refactor を混ぜない
2. テスト・ドキュメント変更は同じ PR に含める
3. 500 行を超えそうなら分割（feature flag や WIP マージで段階適用）
4. PR 説明は [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) に従う
5. Breaking change がある場合は明示

### NG パターン
- 「ついでに refactor」で 2000 行 PR
- テストなしで「動作確認した」と書く
- 関連 issue を書かない

### 理由
Claude Code が次セッションで自分の作業を読み戻せる単位にする。レビュー疲労を避ける。ロールバック可能性を保つ。

---

## ルール7: テストが落ちている状態で次に進まない

### 適用条件
全コミット。

### やること
- `pnpm test` が green でない状態で commit しない
- CI が赤い PR を merge しない
- `pnpm typecheck` も同様
- `pnpm lint` も同様

### NG パターン
- `// @ts-ignore` で型エラーを隠す
- `it.skip` で落ちるテストを無効化
- CI を skip して merge

### 例外
- 既知の flaky test は issue 化 + リトライ設定。隠さない

---

## ルール8: Terraform で管理されていないインフラ変更を作らない

### 適用条件
GCP リソース全般（Cloud Run、Cloud SQL、IAM、ネットワーク等）。

### やること
1. すべて `infrastructure/terraform/` 配下で管理
2. GCP コンソールでの直接変更は**緊急時のみ**、終わったら Terraform 化
3. `terraform plan` を PR に貼る（CI で自動投稿）
4. `terraform apply` は main merge 後の自動か、手動承認

### NG パターン
- コンソールで Cloud SQL の設定変更して Terraform 未反映
- 「これだけは手動でいい」が積み重なる

### 理由
Disaster Recovery 時に**コードから完全再現できる**ことが、データ保護要件の根幹。

---

## セキュリティ最優先の心構え

このプロジェクトは公立校の生徒データを扱う。**漏洩したらサービス終了**。

判断に迷ったら:
- 「便利だが少しリスクがある」 vs 「やや不便だが安全」 → **安全側**
- 「速いが監査がない」 vs 「遅いが監査がある」 → **監査がある側**
- 「Claude が言ったから」 → **疑う**。根拠を ADR で書かせる

---

## ディレクトリ構成

```
kimiterrace-v2/
├── CLAUDE.md                  # このファイル
├── README.md                  # 人間向け概要
├── docs/
│   ├── STATUS.md              # 【最重要】現在地
│   ├── ROADMAP.md             # 12週計画
│   ├── adr/                   # 意思決定記録
│   ├── requirements/          # 機能・非機能要件
│   ├── architecture/          # C4 図・データモデル・API契約
│   ├── compliance/            # プライバシー・文科省GL対応
│   └── runbooks/              # 運用手順書
├── apps/
│   ├── web/                   # Next.js (Cloud Run)
│   ├── firmware/              # サイネージ端末
│   └── jobs/                  # Cloud Run Jobs (バッチ)
├── packages/
│   ├── db/                    # Drizzle スキーマ + マイグレーション
│   ├── shared-types/          # フロント/バック共通の型
│   ├── ui/                    # 共通コンポーネント
│   └── ai/                    # Vertex AI + RAG ロジック
├── infrastructure/
│   ├── terraform/             # GCP IaC
│   └── docker/                # ローカル開発用
├── scripts/
│   ├── migration/             # Firestore → PostgreSQL 移行
│   └── seed/                  # 開発用 fixture
├── .github/                   # CI/CD・テンプレート
└── .claude/                   # Claude Code 設定
```

---

## 旧プロジェクトとの関係

旧 [キミテラス](../キミテラス/) は移行完了まで**読み取り専用の原本**として保持。

データ移行スクリプト（`scripts/migration/`）は旧 Firestore からエクスポートして PostgreSQL にインポートする。**新規データの書き込みは v2 のみ**に切替後行う。

切替プランは [docs/runbooks/cutover.md](docs/runbooks/cutover.md)。

---

## 関連ドキュメント

- 現在地: [docs/STATUS.md](docs/STATUS.md)
- ロードマップ: [docs/ROADMAP.md](docs/ROADMAP.md)
- 意思決定一覧: [docs/adr/](docs/adr/)
- インシデント対応: [docs/runbooks/incident-response.md](docs/runbooks/incident-response.md)

---

## 困った時

- 設計判断に迷う → Plan agent でレビュー、ADR ドラフト作成
- 既存実装を理解したい → Explore agent
- 大きな PR のレビュー → `/ultrareview`（人間が起動）
- 本番障害 → [docs/runbooks/incident-response.md](docs/runbooks/incident-response.md) に沿って対応
