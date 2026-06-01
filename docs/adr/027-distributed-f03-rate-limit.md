# ADR-027: F03 分散レート制限（Cloud SQL カウンタ行 vs Memorystore）

- 状態: Accepted（2026-06-01）
- 日付: 2026-06-01
- 関連: [#155](https://github.com/cometa-kaito/kimiterrace-v2/issues/155)（F03 follow-up: 分散レート制限）, [PR #144](https://github.com/cometa-kaito/kimiterrace-v2/pull/144)（インメモリ版）, [F03](../requirements/functional/F03-ai-structuring.md), [NFR06 rate limit], [ADR-002 (Cloud Run)](002-cloud-run-vs-functions.md), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [ADR-019 (RLS)](019-rls-two-layer-tenant-isolation.md), [CLAUDE.md ルール2/ルール8]

## 文脈

F03 構造化抽出（Vertex AI Gemini 呼び出し）は school 単位で **60 req/60s** にレート制限する（NFR06 コスト方針）。現行 `FixedWindowRateLimiter`（[packages/ai/src/rate-limit.ts](../../packages/ai/src/rate-limit.ts)）は **インメモリ・単一プロセス内のみ正確**。Cloud Run（ADR-002）は複数インスタンス構成のため、school 単位の全体上限はインスタンス跨ぎでは保証できない。インスタンス N 台ある場合、最悪 `60 × N` req/min が Vertex に流れる。

### 候補

| 候補 | 概要 | 閉域性 | 追加インフラ | レイテンシ | 月額コスト目安 |
|---|---|---|---|---|---|
| A. Cloud SQL のカウンタ行 | `ai_rate_limit_windows(school_id, window_start_ms, count)` に `INSERT ... ON CONFLICT DO UPDATE` する。1 文で原子的に上限判定 + インクリメント。 | ◎（既存 PG VPC 内）| なし（既存 Cloud SQL を流用）| ~5-15ms（既存接続）| ~$0（既存 Cloud SQL の余剰内）|
| B. Memorystore (Redis) | Redis の `INCR` + `EXPIRE`。 | ○（VPC 内に新規 Memorystore + Serverless VPC Access コネクタ）| Memorystore Basic Tier + VPC コネクタ | ~1-3ms | ~$50-70/月（最小構成）+ コネクタ $10-30/月 |
| C. クライアント側分散制限（インスタンス数で割る）| Cloud Run の最大インスタンス数 `M` を前提に各インスタンスを `60/M` に絞る | ◎（追加ストアなし）| なし | 0ms | $0 |

### 候補の評価

**A. Cloud SQL カウンタ行**:
- 利点:
  - **閉域原則維持**: 既存 PG を流用、新規ネットワーク経路（VPC コネクタ等）を増やさない（CLAUDE.md ルール8 / 閉域）。
  - **コスト ~0**: 既存 Cloud SQL のキャパシティ内。NFR06 のコスト方針と整合。
  - **原子性**: `INSERT ... ON CONFLICT DO UPDATE SET count = count+1 WHERE count < $limit RETURNING count` は単一 SQL 文で原子的（PG 内部で行レベルロック）。並列インスタンスが同時に同 school へ向けても、limit 超過は構造的に防げる。
  - **RLS で school 越境を構造排除**（ルール2、ADR-019）。
  - **監査**: ai_extractions 行と同じ Cloud SQL 内で監査ログと相関できる（漏洩時の操作再現）。
- 欠点:
  - レイテンシが Memorystore より大きい（数 ms オーダー、F03 の Vertex 呼び出し全体は 1-3s なので無視可）。
  - 古いウィンドウ行が累積する（日次 cron で `DELETE WHERE window_start_ms < now - 1day` する／メンテナンス時の物理 hardcap で十分）。
- 並行アクセスの正当性: PG の `INSERT ... ON CONFLICT DO UPDATE WHERE` は **同一行を巡る並行トランザクションを直列化**し、`count < $limit` 条件が成立した側だけが RETURNING で行を返す。これにより N インスタンス並列でも limit 超過は起きない。

**B. Memorystore (Redis)**:
- 利点: レイテンシ最小、`INCR` がアトミック。
- 欠点:
  - **新規インフラ**: Memorystore + Serverless VPC Access コネクタを追加（ルール8 で Terraform 化、運用面が増える）。
  - **コスト**: 最小構成でも月 $50-100。F03 のレート制限 1 機能のために専用に立てる正当性が薄い。
  - **閉域性は確保されるが付帯リソース増**: VPC コネクタはネットワーク表面積を増やす。**Redis を将来別ユースケース（セッション/キャッシュ等）でも使う計画が無い現状**では over-spec。

**C. クライアント側分散**:
- 各インスタンスを `60/M` に絞る案は、`min_instances=0` の Cloud Run では `M` が動的に変動し、整合性が壊れる。**実質的に成立しない**ため不採用。

## 決定

**A. Cloud SQL カウンタ行を採用する。**

- 既存 Cloud SQL（ADR-001）に `ai_rate_limit_windows` テーブルを追加し、`INSERT ... ON CONFLICT DO UPDATE WHERE count < limit RETURNING` の 1 文で原子的に slot を取る。
- RLS を有効化し、school 越境はテーブル設計で構造排除する（ADR-019）。
- インメモリ版（`FixedWindowRateLimiter`）は **単一プロセス・テスト用に維持**。本番 wiring（apps/web / Cloud Run Jobs）を `DistributedRateLimiter` に差し替える。
- 抽象は既存の `RateLimiter` インターフェイス（[packages/ai/src/rate-limit.ts](../../packages/ai/src/rate-limit.ts)）を **戻り型を `Promise<boolean> | boolean` に拡張**して維持する（呼び出し側 `structureContent` は `await` するだけで両実装を受け取れる、依存逆転済）。

### テーブル設計（本 ADR が拘束する SQL 契約）

```sql
CREATE TABLE ai_rate_limit_windows (
  school_id        uuid    NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  -- 固定ウィンドウ開始時刻（epoch ms / windowMs を切り捨て）。bigint で 2262 年まで安全。
  window_start_ms  bigint  NOT NULL,
  count            integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid,
  PRIMARY KEY (school_id, window_start_ms),
  CHECK (count >= 0)
);
ALTER TABLE ai_rate_limit_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_rate_limit_windows
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);
```

slot 取得の SQL（PostgresRateLimitStore 実装が必ずこの形を発行する）:

```sql
INSERT INTO ai_rate_limit_windows (school_id, window_start_ms, count)
VALUES ($1, $2, 1)
ON CONFLICT (school_id, window_start_ms)
  DO UPDATE SET count = ai_rate_limit_windows.count + 1, updated_at = now()
  WHERE ai_rate_limit_windows.count < $3
RETURNING count;
```

`RETURNING` が 1 行返れば slot 取得成功（allow）、0 行なら拒否（deny → HTTP 429）。**`count >= limit` の条件は WHERE 句で DB が判定**し、アプリ側の SELECT-then-UPDATE 競合は構造的に発生しない。

## 影響

### 良い影響

- 複数 Cloud Run インスタンスでの school 単位上限が **DB レベルで原子的に保証**される（CLAUDE.md ルール2 の思想を rate-limit にも適用）。
- 追加インフラ・追加月額なし、Terraform 変更も `ai_rate_limit_windows` 1 テーブル分のみ。
- インメモリ版を温存することで unit test（ADR-012、DATABASE_URL を必要としないテスト）が引き続き動く。
- 呼び出し側（`structureContent`）の API は `RateLimiter` インターフェイス 1 つで、インメモリ実装と分散実装の差し替えがコード変更なしに済む（PR #144 が確立した依存逆転を維持）。

### 悪い影響 / 既知のトレードオフ

- レイテンシ +5-15ms / req（Vertex 呼び出し 1-3s に対して無視可）。
- 古いウィンドウ行が累積する → 日次 cron で `DELETE WHERE window_start_ms < (extract(epoch from now()) - 86400)*1000`（運用 runbook 追加）。
- 固定ウィンドウ方式のため境界跨ぎで瞬間的に最大 `2 × limit` 流れる理論バーストは残る（slide window が必要なら別 ADR で再検討、Vertex の保護目的では十分）。

## 実装スライス（本 PR と follow-up）

- **本 PR（#155-A）**: ADR-027 + `RateLimiter` インターフェイスの async 化 + `DistributedRateLimiter` クラス（`RateLimitStore` 依存逆転）+ 並行アクセス unit テスト（fake atomic store）。
- **Follow-up PR（#155-B）**: Drizzle スキーマ `ai_rate_limit_windows` + RLS migration + `PostgresRateLimitStore`（上記 SQL を発行）+ RLS テスト + apps/web 配線。

本 PR は ADR-027 で **SQL 契約を確定し、その契約を満たす store を呼び出す class** までを atomic に提供する。実 PG 実装は契約に従って書くだけの定型作業として follow-up に切り出す（CLAUDE.md ルール6 = 500 行 / PR）。

## 代替案

- B（Memorystore）: 上記評価のとおりコスト・閉域性・運用負荷で不採用。将来セッションキャッシュ等で Redis を別途必要とした段階で再評価可。
- C（クライアント側分散）: `min_instances=0` で破綻するため不採用。

## 参照

- [ADR-001](001-postgres-vs-firestore.md) PostgreSQL を基盤に選択した根拠
- [ADR-002](002-cloud-run-vs-functions.md) Cloud Run 採用と複数インスタンス前提
- [ADR-019](019-rls-two-layer-tenant-isolation.md) RLS 2 層分離（rate limit テーブルも適用）
- [F03 functional spec](../requirements/functional/F03-ai-structuring.md)
- [PR #144](https://github.com/cometa-kaito/kimiterrace-v2/pull/144) インメモリ rate-limit の導入
