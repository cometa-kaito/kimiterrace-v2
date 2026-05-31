# ADR-001: Cloud SQL for PostgreSQL を採用、Firestore を捨てる

- 状態: Accepted（2026-05-31 実装稼働により Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-004 (Drizzle)](004-drizzle-vs-prisma.md), [ADR-007 (pgvector)](007-pgvector.md), [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [NFR03 セキュリティ](../requirements/non-functional/NFR03-security.md), [NFR04 監査ログ](../requirements/non-functional/NFR04-audit-log.md), [NFR07 コンプライアンス](../requirements/non-functional/NFR07-compliance.md), [CLAUDE.md スタック表 / ルール1・2・3](../../CLAUDE.md)

## 文脈

旧キミテラス（V1）は **Firebase / Firestore** を一次データストアにしていた。V2 は公立高校の生徒データを **10 年保管**前提で扱い、漏洩したらサービス終了という制約のもと、データ層を改めて選定する必要がある。

V2 の要求:

- **テナント分離を DB レベルで強制したい**（[CLAUDE.md ルール2](../../CLAUDE.md)）。アプリ層の `WHERE school_id = ?` 漏れが全テナント漏洩に直結する設計は許容できない。
- **監査要件**（[NFR04](../requirements/non-functional/NFR04-audit-log.md) / [NFR07](../requirements/non-functional/NFR07-compliance.md)）: 誰がいつ何を見た/変えたかを改竄検知付きで残す。
- **型の単一ソース**（[CLAUDE.md ルール3](../../CLAUDE.md)）: スキーマから型を機械生成し、人力レビューに依存しない。
- **RAG / ベクトル検索**: 掲示物の embedding を school_id スコープで検索（[ADR-007](007-pgvector.md)）。
- **リレーショナル整合**: CRM（広告主・契約・コミュニケーション・月次レポート）の参照整合・集計。
- **可監査なクエリ言語でのアクセス制御テスト**: セキュリティルールを自動テストで固めたい。

選択肢:

- **Cloud SQL for PostgreSQL 16**（+ pgvector）
- Firestore 継続
- AlloyDB for PostgreSQL
- Cloud Spanner

## 決定

**Cloud SQL for PostgreSQL 16（asia-northeast1、pgvector 拡張）を一次データストアに採用**し、Firestore を捨てる。

決め手:

- **Row Level Security (RLS)**: テナント分離を DB レベルで宣言的に強制でき（[ADR-019](019-rls-two-layer-tenant-isolation.md)）、許可/拒否ケースを **SQL で自動テスト**できる。Firestore の `firestore.rules` は型なし DSL で、同じ保証を得るにはテストの作りこみが重い。
- **スキーマあり → 型の機械生成**: Drizzle（[ADR-004](004-drizzle-vs-prisma.md)）でスキーマを単一ソースにし、API/Zod 型まで自動派生（[ルール3](../../CLAUDE.md)）。Firestore はスキーマレスで二重管理が避けられない。
- **監査とリレーショナル整合**: 監査カラム（[ルール1](../../CLAUDE.md)）+ `audit_log` のハッシュチェーン、外部キー・CHECK 制約・トランザクションで不変条件を DB が保証。CRM の集計も SQL で素直。
- **pgvector で RAG を同一 DB に同居**（[ADR-007](007-pgvector.md)）: ベクトル検索が RLS と同じ `school_id` スコープに自然に乗り、外部ベクトル DB への PII 越境を避けられる（[ルール4](../../CLAUDE.md)）。
- **マネージドな堅牢性**: Cloud SQL の自動バックアップ・PITR・HA で 10 年保管要件に対応。標準 SQL 寄りのため最悪の移行経路も残る。

## 検討した代替案

### 代替 A: Firestore 継続
- 却下理由: テナント分離が `firestore.rules`（型なし DSL）依存で、DB レベル強制 + SQL テストの保証に劣る。スキーマレスで型の単一ソース（[ルール3](../../CLAUDE.md)）が立たない。
- 副次理由: ベクトル検索・リレーショナル集計（CRM）が苦手で、外部サービス併用が増える＝ PII 越境面が広がる。
- 副次理由: V1 で蓄積した「リアルタイム購読（onSnapshot）」の利点は、サイネージの更新頻度では短ポーリング / LISTEN-NOTIFY で十分代替できる（`docs/architecture/v1-v2-mapping.md`）。

### 代替 B: AlloyDB for PostgreSQL
- 却下理由: PostgreSQL 互換で機能的には魅力的だが、PoC〜初期スケール（岐南工業 3 クラス〜数十校）に対してコストが過大。RLS / pgvector は Cloud SQL でも十分。
- 補足: 将来、分析ワークロードが重くなれば本 ADR を再評価して移行余地あり（PostgreSQL 互換なので移行経路は比較的緩やか）。

### 代替 C: Cloud Spanner
- 却下理由: グローバル分散・無限スケールは本システムの規模（国内・学校テナント）に対してオーバースペックでコスト過大。
- 副次理由: RLS 相当のきめ細かな行レベル制御や pgvector エコシステムの成熟度で PostgreSQL に劣る。

## 結果（Consequences）

### 良い影響
- テナント分離を DB レベルで強制でき、アプリのバグが即漏洩につながらない（[ルール2](../../CLAUDE.md) / [ADR-019](019-rls-two-layer-tenant-isolation.md)）。
- スキーマ → 型の機械生成で人力レビュー依存を排除（[ルール3](../../CLAUDE.md) / [ADR-004](004-drizzle-vs-prisma.md)）。
- 監査・整合・RAG が単一 DB に集約し、PII の外部越境面を最小化。
- 標準 SQL 寄りで Disaster Recovery / 将来移行の経路を確保。

### 悪い影響 / リスク
- **リアルタイム性の作り込み**: Firestore の `onSnapshot` 相当は短ポーリング / LISTEN-NOTIFY で自前実装が要る。サイネージ 50 台/校 × 短間隔ポーリングは Cloud SQL コネクションを圧迫しうる → 接続プール・キャッシュ設計を [NFR01](../requirements/non-functional/NFR01-performance.md) と突合（#48-E）。
- **接続管理**: サーバレス（Cloud Run）からの接続数管理が必要 → コネクションプーラ（pgbouncer / Cloud SQL Connector）を検討。
- **運用責任**: スキーマ migration（[ADR-004](004-drizzle-vs-prisma.md)）・バックアップ・パッチ適用の運用が発生 → Terraform 化（[ADR-009](009-terraform.md)）で再現性を担保。

### トレードオフ
- 「スキーマレスの柔軟性 vs スキーマありの安全性」のうち、公立校データのセキュリティ最優先のため **スキーマありの安全性**に振った。
- 「マネージド NoSQL のリアルタイム性 vs RDB の整合性・可監査性」のうち **整合性・可監査性**に振った（リアルタイム性は要件上ポーリングで足りる）。
