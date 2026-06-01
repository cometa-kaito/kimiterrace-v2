# ADR-025: 広告 impression / 到達数の計上セマンティクス（延べ表示数 vs ソフト重複排除済 到達数）

- 状態: Accepted（2026-06-01）
- 日付: 2026-06-01
- 関連: [#265](https://github.com/cometa-kaito/kimiterrace-v2/issues/265)（F07 follow-up M-1）, [#43 (F07)](../requirements/functional/F07-event-logging.md), [#44 (F08)](https://github.com/cometa-kaito/kimiterrace-v2/issues/44), [#45 (F09)](https://github.com/cometa-kaito/kimiterrace-v2/issues/45), [event-logging シーケンス](../architecture/sequence-diagrams/event-logging.md), [ADR-019 (RLS)](019-rls-two-layer-tenant-isolation.md), [CLAUDE.md ルール4](../../CLAUDE.md)

## 文脈

PR #263（F07 サイネージ広告 impression beacon 第2スライス）の独立 Reviewer が M-1（Medium）として指摘した:
広告「到達数」の **計上セマンティクスが doc とコードで未確定**であり、F08（効果ダッシュボード）/ F09（月次レポート、広告主向け到達数）の集計と整合させる必要がある。

### 現状の実装

- **クライアント送信**（[`SignageClient.tsx`](../../apps/web/app/(signage)/signage/[classToken]/_components/SignageClient.tsx)）:
  表示中の広告が変わるたびに `view` を 1 件ベストエフォート送信する（依存は `currentAdId` / `safeIndex`）。
  - 単一広告クラス（`adCount <= 1`）はローテーション early-return のため、**マウント中に `view` を 1 回しか送らない**。
  - 端末は `__session` を持たない匿名公開経路で、`client_id` は localStorage の**匿名 uuid**（個人特定情報ではない、ルール4）。
- **サーバー取り込み**（[`event-ingest.ts`](../../apps/web/lib/signage/event-ingest.ts)）:
  append-only ベストエフォート。`adId` は当該クラスの実効広告に実在照合（#265 L-1）するが、**重複排除はしない**（`occurred_at` は DB `now()`、クライアント時刻不信）。
- **集計**（[`event-stats.ts`](../../packages/db/src/queries/event-stats.ts) `getEventStats` 他）:
  `count(*)` の**素の延べ件数**。`totals.view` は全 `view` 行（広告 + content）の延べ数。

### doc が示す意図

- [F07-event-logging.md](../requirements/functional/F07-event-logging.md): 「**広告主として、自社広告の到達数を月次レポートで知りたい**」。
- [event-logging.md](../architecture/sequence-diagrams/event-logging.md): 「**beacon は冪等性なし**: クライアント側でリトライしないため、サーバー側で `(client_id, content_id, event_type, timestamp_minute)` 単位の**ソフト重複排除（集計時に DISTINCT）を許容**」。

→ doc の「到達数」は **集計時に分（minute）粒度でソフト重複排除した impressions** を意図している。一方、現 `getEventStats` は素の延べ。両者は**別の指標**であり、混同したまま「到達数」と呼ぶと広告主への報告値が膨らむ。

## 決定

**2 つの指標を明確に分離して定義する。dedup は取り込み時ではなく集計時（DISTINCT）に行う**（取り込みは append-only ベストエフォートのまま = 「beacon は冪等性なし」を維持）。

### 指標1: 延べ表示数（gross impressions / engagement proxy）

- 定義: 期間内の `view` イベント件数（`count(*)`）。重複排除しない。
- 用途: **学校向け** F08 効果ダッシュボード（`getEventStats.totals.view` 等）の「どれだけ反応があったか」の engagement 指標。
- 判定: **現実装が正しい**。学校に見せる engagement 量としては延べで良く、変更不要。ただし UI / 型のラベルは「延べ表示数（engagement）」であって「到達数（reach）」ではないことを明示する。

### 指標2: 広告到達数（advertiser reach、ソフト重複排除済）

- 定義: `view` イベントを **`(client_id, ad_id, floor(occurred_at → JST 分))` で DISTINCT** した件数。
  - キーは `ad_id`（`payload.adId`）。`content_id` ベースの content engagement とは別軸（content 到達は `(client_id, content_id, 分)`）。
  - 時刻は `occurred_at`（DB `now()` 由来、クライアント時刻不信）を **JST 分**に丸める（F08 の JST 集計と同じ思想）。
  - `client_id` 欠落イベント（localStorage 不可の端末）は dedup できないため、**別系列（client_id NULL は 1 件ずつ計上 or 除外）**として扱い、レポートで注記する。実装スライスで確定する。
- 用途: **広告主向け** F09 月次レポートの「到達数」、および将来の広告主ダッシュボード。
- 判定: **未実装**。F09 広告主到達数スライスで `getAdReach`（仮）として本定義の DISTINCT 集計を新設する。RLS は既存同様 `school_id` 条件を書かず委譲（ADR-019）。集計は件数のみ返し `client_id` 等の生値は出さない（ルール4）。

### クライアント送信契約（SignageClient）

到達数が**集計時 minute-dedup** である前提に立つと:

- 表示中の広告について `view` を**送りすぎても到達数は膨らまない**（同一 `(client_id, ad_id, 分)` は集約される）。送信過多は延べ表示数のみを膨らませる。
- 逆に**送らなすぎると到達 minute を取りこぼす**。現状の単一広告クラス（マウント中 1 回のみ）は、端末が長時間表示し続けても **1 分ぶんの到達しか記録されない** → 長時間掲示の到達を過少計上する。
- **決定**: 広告到達数スライスの実装時に、クライアントは表示中広告について**分粒度のハートビート `view`**（例: 表示継続中は概ね 1 分ごと、ローテーションの有無・広告枚数に依らず）を送るようにする。これにより複数広告クラス（ローテーションで自然に再送）と単一広告クラスの到達計上が**枚数に依らず公平**になる。延べ表示数（指標1）への影響は許容（engagement の素の量として妥当）。
- 本 ADR 時点では**契約の確定のみ**。ハートビート送信の実装と到達数集計は #265 後続スライス（F09 広告主到達数）で行い、過剰送信によるテレメトリ量増は当該スライスで間隔を調整する。

## 影響

- F08（学校向けダッシュボード）: **変更不要**。延べ表示数の指標であることをラベル/型 doc で明示する追従のみ（後続の軽微 PR）。
- F09（広告主向け月次レポート）: 「到達数」列は**本 ADR の指標2（minute-dedup）**で実装する。素の延べ件数を到達数として出さない。
- F07 クライアント: 到達数スライス時に**ハートビート view** を導入（単一/複数広告の公平性）。それまでは現状維持（延べ表示数は機能、到達数は未提供）。
- 取り込み層（event-ingest）: **変更不要**。dedup は集計時に行うため append-only ベストエフォートを維持（#265 L-1 の実在照合はそのまま）。

## 却下した代替案

- **取り込み時 dedup（INSERT 前に重複 SELECT / UNIQUE 制約）**: append-only の単純さ・ベストエフォート性（「beacon は冪等性なし」）を壊し、ホットパスに SELECT を足す。集計時 DISTINCT なら同じ結果を後段で得られるため不要。却下。
- **延べ件数をそのまま「到達数」と呼ぶ**: 広告主への報告値が表示枚数・ローテ速度・端末稼働時間で膨らみ、ローテーション設計次第で水増し可能。広告主の信頼を損なうため却下。
- **ユニーク端末数のみ（分粒度なし、`(client_id, ad_id)` で DISTINCT）**: 1 か月に 1 回見ても 1,000 回見ても同じ「1」になり、掲示の露出量を反映しない。月次レポートの到達**量**として粗すぎるため、分粒度を採る。

## フォローアップ（#265 / F09）

- [ ] `getAdReach`（minute-dedup 到達数集計）の実装 + RLS テスト。
- [ ] `client_id` NULL イベントの到達数での扱い確定（注記 or 除外）。
- [ ] SignageClient のハートビート `view` 送信（単一/複数広告の公平化）。
- [ ] F08 ダッシュボードの「view」ラベルを「延べ表示数（engagement）」と明示。
