# キミテラス v2 ロードマップ

旧 Firebase 構成から GCP ネイティブへの全改修。

## 構成

```
Phase 調査 → Phase 設計 → Phase 開発 → Phase 検証 → Phase 導入
─────────  ─────────  ─────────  ─────────  ─────────
   Claude 主導（調査〜検証を全力で進める）         人間担当
                                          （Claude は staging までを完成）
```

**Claude は調査〜検証を全力で進める。導入は人間が学校・契約・現場運用と並行で進める。**

---

## Phase 調査 (Investigation)

**目的**: 既存システムと制約条件を把握し、設計の前提を固める。

**やること**:
- 旧 Firebase 構成の棚卸し（コレクション・Functions・UI ルート・firmware・Auth claims・Storage）
- 既存運用パターンの把握（学校・端末・ユーザー導線）
- 外部制約の確認（県教委 Wi-Fi、ISMAP 要件、文科省 GL）

**成果物**: `docs/discovery/*.md`

**関連 issue**: [#11](https://github.com/cometa-kaito/kimiterrace-v2/issues/11) 既存システム棚卸し

---

## Phase 設計 (Design)

**目的**: 要件・アーキテクチャ・データモデル・脅威を文書化し、後続開発の地盤を作る。

**やること**:

| 領域 | 成果物 | 関連 issue |
|---|---|---|
| 機能要件 | `docs/requirements/functional/F01-F07.md` | [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12) |
| 非機能要件 | `docs/requirements/non-functional/NFR01-NFR06.md` | [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13) |
| アーキ判断 | `docs/adr/001-014.md` | [#14](https://github.com/cometa-kaito/kimiterrace-v2/issues/14) |
| データモデル | `packages/db/schema/*.ts` (DDL 初稿) | [#15](https://github.com/cometa-kaito/kimiterrace-v2/issues/15) |
| C4 図・シーケンス | `docs/architecture/c4-*.md`, `sequence-diagrams/*.md` | [#16](https://github.com/cometa-kaito/kimiterrace-v2/issues/16) |
| 脅威モデル | `docs/architecture/threat-model.md` (STRIDE) | [#17](https://github.com/cometa-kaito/kimiterrace-v2/issues/17) |
| API 契約 | `docs/architecture/api-contracts.openapi.yaml` | 派生 |
| 移行計画 | `docs/runbooks/data-migration.md` | 派生 |

---

## Phase 開発 (Development)

**目的**: 設計を実装に変換、staging で全機能が動くまで持っていく。

サブストリームに分割。**依存順** で並べたが、Claude は依存解消され次第並列起動する:

### 開発: インフラ基盤

- Terraform 全モジュール（cloud-run / cloud-sql / identity-platform / vpc / cloud-armor / secret-manager）
- dev / staging / prod 環境分離
- VPC + Cloud SQL Private IP (PostgreSQL 16 + pgvector)
- GitHub Actions CI に terraform plan, Cloud Run preview
- Workload Identity Federation (GitHub Actions ↔ GCP)
- 観測: Cloud Logging, Cloud Trace, Cloud Monitoring, Sentry 接続

### 開発: データ層

- PostgreSQL スキーマ確定（設計フェーズの初稿を本番化）
- 全テーブルに監査カラム (CLAUDE.md ルール1)
- RLS ポリシー実装 + テスト（許可・拒否ケース両方）(ルール2)
- Drizzle 型生成、`drizzle-zod` で validation 自動化 (ルール3)
- migration 運用フロー

### 開発: 認証

- Identity Platform セットアップ
- Firebase Auth → Identity Platform ユーザー移行スクリプト
- Custom Claims (systemRole / teacher / editor / schoolId) 引き継ぎ
- Next.js middleware で JWT 検証 + RLS context 設定
- MFA 強制ポリシー

### 開発: API 層

- Next.js Route Handlers で各機能 API（schools / schedules / notices / submissions / memberships / users / signage）
- 認可ミドルウェア（漏れたら全テナント漏洩リスク）
- 監査ログミドルウェア
- Rate limit（Cloud Armor + アプリ層）
- 統合テスト（Testcontainers で実 PostgreSQL）

### 開発: フロントエンド

- Next.js SSR + Server Actions
- 旧 management UI コンポーネント移植
- データ取得を Firestore SDK → Drizzle + Server Actions へ
- アクセシビリティ (WCAG 2.2 AA)
- E2E テスト (Playwright)

### 開発: AI 機能

- pgvector embedding pipeline（夜間バッチ）
- Vertex AI Gemini クライアント
- PII マスキング (ルール4)
- RAG クエリ（school_id スコープ）
- Vercel AI SDK + SSE ストリーミング UI
- プロンプトインジェクション対策
- AI 利用ログを audit_log に
- **チャットボット仕様は [ADR-028](adr/028-f06-chatbot-answer-policy.md) で確定済**（対象=生徒+教員 / 掲示物 Q&A のみ・学習進路は拒否 / 中立丁寧トーン / 多言語対応 / コスト天井なし+rate limit、2026-06-01）

### 開発: サイネージ統合

- firmware の API エンドポイントを Cloud Run に切替
- Cloud Storage の signage-json バケットへの配信
- 端末ごとのサービスアカウント発行・失効フロー
- ファームウェア更新の署名検証

### 開発: 運用基盤

- BigQuery 連携（Datastream で Cloud SQL → BQ 同期）
- 文科省報告用集計クエリ
- Cloud Logging 長期保管（コールド 7 年）
- バックアップ自動化 + 復元演習
- インシデント対応 playbook
- ペネトレ代替 (Semgrep / CodeQL / gitleaks / Dependabot / RLS テスト) — 本格ペネトレの要否・時期は別途見直し（「ペネトレ計画」節を参照）

### 開発: staging 内部受入

- 全機能 staging で動作確認
- データ移行スクリプトの dry-run（3 回）
- 切替 runbook 完成
- **Claude 担当範囲の完成宣言**（ここから先は人間に引き継ぎ）

---

## Phase 検証 (Verification, Claude 主導)

**目的**: 開発で完成させた staging を、導入の前に **システム横断・敵対的・要件トレーサブル**に検証する受入ゲート。
PR 単位の shift-left テスト（unit / RLS / API / e2e / CI スキャン）では捕まえられない統合レベルの欠陥を潰す。

**大枠設計**: [docs/testing/test-strategy.md](testing/test-strategy.md)

- **Entry ゲート**: staging が feature-complete（全 F0–F16 が staging で動作、データ移行 dry-run が回る）
- **Exit ゲート**: 5 トラック合格 → go/no-go レポートを人間へ提出 → 導入へ
- **環境**: staging 限定・合成データのみ（実生徒データ・本番投入での試験は禁止）

**5 トラック**:

| トラック | 内容 | トレース元 |
|---|---|---|
| ① 機能受入テスト | F01–F16 + V1 互換の端〜端検証、要件↔テスト トレーサビリティ行列 | `docs/requirements/functional/` |
| ② UI/UX/GUI テスト | サイネージTV / 教員管理 / 生徒スマホ、WCAG 2.2 AA、視覚回帰 | NFR05 |
| ③ セキュリティ・ペネトレ | テナント越境・ロール昇格・magic-link 濫用・プロンプトインジェクション・PII 漏洩・OWASP（STRIDE 突合） | threat-model.md / NFR03 |
| ④ 非機能テスト | 性能・負荷・可用性・コスト | NFR01 / NFR02 / NFR06 |
| ⑤ 移行・監査・コンプラ | 移行 dry-run 検証、監査ログ網羅性、文科省GL / ISMAP | NFR04 / NFR07 |

検出欠陥は Claude の開発権限内で **修正 PR → Reviewer 別 spawn → 再検証** で閉じる。
**第三者による正式（外部）ペネトレ認証**・**実機/実環境検証**・**本番データに対する試験**は Claude の範囲外（人間 / 外部）。

**備考**: 開発フェーズ末尾と一部オーバーラップ可

---

## Phase 導入 (Deployment, 人間担当)

Claude は staging までを完成。**本番稼働は人間が以下を整えてから判断**:

| カテゴリ | 内容 |
|---|---|
| 契約・規程 | 個人情報取扱規程・プライバシーポリシー最終化、SaaS 利用契約 |
| リスク移転 | サイバー保険加入、GCP DPA 確認 |
| 委託先管理 | 委託先管理表確定 |
| 学校統合 | 学校向け移行説明資料、教員説明会、岐南工業 実機確認 |
| パイロット | 1校パイロット運用（1〜2 週間） |
| 切替 | DNS 切替、並行運用、旧 Firebase 停止判断 |

**Claude は技術 support のみ**（runbook 参照、トラブル時の修正 PR、AI 利用ログから挙動分析など）。
調整・判断・対外コミュニケーションは人間。

Phase 開発完了の節目で、Phase 導入用の issue を改めて起票する。

---

## マイルストーン

| マイルストーン | 達成基準 |
|---|---|
| Phase 調査 完了 | discovery docs 一式 |
| Phase 設計 完了 | 要件・ADR・スキーマ・図 一式 |
| Phase 開発 完了 (staging) | staging で全機能、AI チャット動作、データ移行 dry-run OK |
| Phase 検証 完了 (受入ゲート) | 5 トラック合格、go/no-go レポート提出 |
| Phase 導入 完了 (本番稼働) | 学校 OK + 契約 OK + パイロット完了後（人間判断） |

---

## ペネトレ計画

**旧方針（撤回）**: 「ペネトレは 2027 実施に延期（確定）、開発内は CI 自動スキャンで代替」。

**現方針**:
- **開発フェーズ内**は引き続き CI 自動スキャンで継続的に守る:
  - Semgrep (SAST) / CodeQL / gitleaks (シークレット) / Dependabot (依存脆弱性) / RLS テスト (テナント分離)
- **Phase 検証**で **Claude Code 駆動の内部ペネトレ（敵対的セキュリティテスト）を導入前ゲートとして実施**
  （トラック③、詳細は [docs/testing/test-strategy.md](testing/test-strategy.md)）。
- **第三者による正式（外部）ペネトレの要否・時期は見直し**（旧「2027 確定」は撤回）。
  Claude の内部ペネトレは外部認証の**代替ではなく前段**で、認証が要る場合は人間が別途手配。

Phase 導入の本番判断は、CI スキャン + Phase 検証の go/no-go レポートで行う。

---

## スコープ調整方針

工程遅延時に削る順序:

| 優先度 | カテゴリ | 削れる |
|---|---|---|
| 最優先 (削らない) | セキュリティ・監査・データ移行・既存機能の完全互換 | × |
| 優先 | AI チャット中核 (RAG, ストリーミング) | △ MVP に縮める |
| 通常 | AI 補助 (要約、自動生成) | ○ |
| 任意 | 高度分析ダッシュボード、BigQuery 連携 | ○ ポストローンチへ |

「速度のために安全を削る」は**絶対にしない**。

---

## 関連ファイル

- 現在地: [docs/STATUS.md](STATUS.md)
- 規律: [CLAUDE.md](../CLAUDE.md)
- 意思決定: [docs/adr/](adr/)
- 棚卸し: [docs/discovery/](discovery/)
- 検証戦略: [docs/testing/test-strategy.md](testing/test-strategy.md)
- 運用手順書: [docs/runbooks/](runbooks/)
