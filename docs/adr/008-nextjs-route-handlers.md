# ADR-008: API は Next.js Route Handlers + Server Actions に統合、Hono 非採用

- 状態: Accepted（2026-05-31 実装稼働により Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [#48-B (#113)](https://github.com/cometa-kaito/kimiterrace-v2/issues/113), [#48-N (#125)](https://github.com/cometa-kaito/kimiterrace-v2/issues/125), [ADR-002 (Cloud Run)](002-cloud-run-vs-functions.md), [ADR-003 (Identity Platform)](003-identity-platform.md), [ADR-004 (Drizzle)](004-drizzle-vs-prisma.md), [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [F13 (来場 Webhook)](../requirements/functional/F13-presence-sensor-webhook.md), [CLAUDE.md スタック表](../../CLAUDE.md)

## 文脈

V1（旧キミテラス）はバックエンド処理を **Cloud Functions の `httpsCallable`**（`firebase-functions.ts`、約 327 行）で実装していた。V2 は Next.js 16（App Router）を **Cloud Run 上で SSR + Server Actions** として動かす（[ADR-002](002-cloud-run-vs-functions.md) で Functions ではなく Cloud Run、[ADR-008 = 本 ADR] で API レイヤー）。

API レイヤーの設計方針を確定する必要がある。考慮点:

- **テナント分離の一元化**: すべての DB アクセスはリクエストごとに RLS コンテキスト（`SET LOCAL app.current_school_id` 等、[ADR-019](019-rls-two-layer-tenant-isolation.md)）を張った接続で実行する必要がある。コンテキスト設定箇所が API レイヤーに散ると漏れる（= テナント越境漏洩）。
- **型の単一ソース**: [CLAUDE.md ルール3](../../CLAUDE.md) / [ADR-004](004-drizzle-vs-prisma.md) で「型は Drizzle スキーマが真実の単一ソース」。API 入出力型もそこから貫通させたい。
- **V1 callable の移植**: V1 の callable 群を [#48-N](https://github.com/cometa-kaito/kimiterrace-v2/issues/125) で 1:1 移植する。namespace は `/api/admin/*` 等。
- **外部 Webhook 受信**: SwitchBot（[F13](../requirements/functional/F13-presence-sensor-webhook.md)）等の外部 POST 受け口が必要（Server Actions では受けられない、CSRF/origin 制約のため）。

選択肢:

- **Next.js Route Handlers（`app/api/*/route.ts`）+ Server Actions** に統合
- **Hono** を別 API レイヤーとして同居（Cloud Run 内 or 別サービス）
- **tRPC**
- 別 API サーバー（Express / Fastify を別 Cloud Run サービス）

## 決定

**Next.js Route Handlers + Server Actions に API を統合する。Hono は採用しない。**

役割分担:

- **画面内の mutation / form 送信** → **Server Actions**（Drizzle の型がサーバー関数引数まで貫通、[ADR-004](004-drizzle-vs-prisma.md)）。
- **外部からの受信・機械間 API（Webhook / 公開 read API / V1 callable 移植）** → **Route Handlers**（`POST /api/webhooks/switchbot`、`GET /api/schools`（public read）、`/api/admin/*` 等）。
- **認証 + RLS コンテキスト確立** → Next.js **middleware で session cookie を検証（[ADR-003](003-identity-platform.md)）し、ハンドラ / Server Action 冒頭の DB トランザクションで `SET LOCAL`** する共通ヘルパに集約。コンテキスト設定を**単一経路**に閉じ込めることで [ADR-019](019-rls-two-layer-tenant-isolation.md) の「SET LOCAL 漏れ」リスクを構造的に抑える。

これにより API は **Cloud Run 単一デプロイ単位**（[ADR-002](002-cloud-run-vs-functions.md)）に収まり、ビルド・デプロイ・観測（[ADR-014](014-observability.md)）が 1 経路になる。

## 検討した代替案

### 代替 A: Hono を別 API レイヤーとして同居
- 却下理由: Server Actions / Route Handlers と Hono で **ルーティング・認証・RLS コンテキスト設定が二重化**する。`SET LOCAL` の設定箇所が増えるほどテナント越境漏洩の面が広がる（[ADR-019](019-rls-two-layer-tenant-isolation.md) の最大リスク）。
- 副次理由: Hono の性能優位（ルーティング速度）は、本システムの規模（学校無料モデル、ピークでも端末 50 台/校のポーリング）では体感差にならない。Cloud SQL レイテンシが支配的。
- 副次理由: 型の単一ソース（[CLAUDE.md ルール3](../../CLAUDE.md)）を保つには Hono ハンドラと Drizzle 型を別途接続する層が必要 → 二重管理リスク。

### 代替 B: tRPC
- 却下理由: tRPC が解く「型安全な client-server 呼び出し」は、Next.js の **Server Actions が標準機能としてほぼ同等**に提供する（App Router 前提）。追加依存・追加学習コストに見合わない。
- 副次理由: 外部 Webhook（[F13](../requirements/functional/F13-presence-sensor-webhook.md)）は結局 Route Handler で受ける必要があり、tRPC では完結しない。

### 代替 C: 別 API サーバー（Express / Fastify を別 Cloud Run サービス）
- 却下理由: デプロイ単位が 2 つになり、認証・RLS コンテキスト・観測・Secret 取得（[ルール5](../../CLAUDE.md)）がサービス間で二重化。モノレポ単一性（[ADR-010](010-pnpm-turborepo.md)）と運用簡素性が崩れる。
- 副次理由: フロント（Next.js）→ 別 API のネットワークホップが増え、レイテンシ・障害点が増加。

## 結果（Consequences）

### 良い影響
- **デプロイ単位が 1 つ**（Cloud Run 1 サービス、[ADR-002](002-cloud-run-vs-functions.md)）。ビルド・観測（[ADR-014](014-observability.md)）・Secret 取得が一経路。
- **RLS コンテキスト設定を middleware + 共通 DB ヘルパに一元化**でき、[ADR-019](019-rls-two-layer-tenant-isolation.md) の「`SET LOCAL` 漏れ → テナント越境」リスクを構造的に低減。
- **型が Drizzle → Server Action 引数 → UI まで貫通**（[CLAUDE.md ルール3](../../CLAUDE.md) / [ADR-004](004-drizzle-vs-prisma.md)）。API 専用の型定義レイヤーが不要。
- V1 の callable 群を `/api/*` Route Handler に 1:1 で移植でき（[#48-N](https://github.com/cometa-kaito/kimiterrace-v2/issues/125)）、移植経路が明快。

### 悪い影響 / リスク
- **Next.js のバージョン追従に API も巻き込まれる**: App Router / Server Actions の仕様変更が API に波及。→ 機微なロジックは framework-agnostic な関数（`packages/` 配下）に出し、Route Handler / Server Action は薄いアダプタに保つ。
- **Route Handler の冷スタート**: Cloud Run の min-instance 設定で緩和（[ADR-002](002-cloud-run-vs-functions.md) / [ADR-009 Terraform](009-terraform.md)）。
- **Server Actions の CSRF / origin 前提**: 外部機械間 API は Server Actions で受けられない → 明示的に Route Handler を使う規律（本 ADR の役割分担）で対応。
- **Next.js への lock-in**: API レイヤーが framework に密結合 → 上記「薄いアダプタ + `packages/` にロジック分離」で最悪の移行経路を残す。

### トレードオフ
- 「単一デプロイの運用簡素性 vs 専用 API レイヤーの分離性」のうち **単一デプロイの運用簡素性 + RLS 一元化のセキュリティ**に振った。
- 「Hono の性能 vs Next.js ネイティブの型貫通」のうち、本規模では性能差が無視できるため **型貫通とセキュリティ一元化**に振った。
- framework lock-in は受容するが、ドメインロジックを `packages/` に分離することで Route Handler / Server Action を差し替え可能な薄い層に保つ。
