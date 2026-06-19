# ADR-044: サイネージ keyless 外部データの「天気 Job 相乗り」取得方式 — 気象警報・注意報を初回適用

- 状態: Accepted（2026-06-18、ユーザー判断）
- 日付: 2026-06-18（Proposed / Accepted 同日。気象警報・注意報バックエンドの実装と同時）
- 関連: [ADR-021 サイネージ天気（閉域パターン・JMA の先例）](021-weather-data-source-jma.md), [ADR-035 鉄道運行情報（公開参照キャッシュ 2 例目）](035-railway-operation-status-scraping.md), [ADR-043 工学ニュース外部取得（同じ keyless 公開参照キャッシュの姉妹 ADR・見出し+出典のみ転載回避）](043-signage-engineering-news-external-fetch.md), [ADR-019 RLS 二層 + 公開参照マスタ特例], [ADR-009 Terraform / 単一 egress](009-terraform.md), [CLAUDE.md ルール1（監査）/ ルール2（RLS）/ ルール5（secret/log）/ ルール8（Terraform）], F14（天気取得 Job）

## 文脈

サイネージ盤面に **気象警報・注意報**（例: 大雨警報・暴風警報・特別警報・各種注意報）を出したい（ユーザー要望）。これは天気（ADR-021）に続く 2 つ目の **keyless（API キー不要）な気象系外部データ**である。さらに将来、**熱中症警戒アラート / WBGT（暑さ指数）・大気汚染 / UV** など、同種の「公開・非 PII・地域単位・keyless」な外部データを追加したい見込みがある。

これらに共通する性質:

- **keyless**: 気象庁（JMA）bosai の公開 JSON は API キー不要で取得できる（天気と同じ）。
- **公開・非 PII**: 地域の気象情報であり、学校・生徒・端末の識別子を含まない。誰でも JMA から取得できる。
- **地域単位の cross-tenant 共有**: 同一府県の全校が同じ予報区コードの 1 行を共有する（school_id 非保持）。
- **低頻度更新**: JMA の更新頻度に合わせ、30〜60 分間隔程度で十分。

問題は **取得の実行基盤をどう増やすか**。素朴には「データ種別ごとに Cloud Run Job + Cloud Scheduler を新設する」が、これは**種別が増えるたびに新しい常駐ジョブ定義・スケジュール・egress 許可・監視が増え、固定費（Cloud Scheduler のジョブ課金 + Job の最小起動コスト + 運用面の追跡対象）が線形に膨らむ**。MVP 規模（PoC 1 校）でこの増分は割に合わない。

## 候補

| 候補 | 概要 | 評価 |
|---|---|---|
| A. データ種別ごとに新 Cloud Run Job + Cloud Scheduler | 警報用・熱中症用… と独立 Job を都度新設 | 関心分離は綺麗だが、**種別ごとに固定費（Scheduler ジョブ + Job 起動 + egress + 監視）が増える**。MVP に重い・ルール8 の追跡対象が線形増 |
| **B. 既存「天気」Cloud Run Job に相乗り（採用）** | 同じ地域ループの中で、同じ府県予報区コードに対し警報も取得して別テーブルへ upsert | **新規 Job / Scheduler ゼロ＝新規固定費ゼロ**。地域 dedup・egress・User-Agent・タイムアウト・監視を再利用。種別追加は同一ループへの 1 ステップ追加で済む |
| C. サイネージ端末が JMA を直叩き | 端末から警報 JSON を直接取得 | **端末閉域（ADR-021 / [[closed-system-security]]）を壊す**。端末ごとに JMA へ N 接続。不採用 |
| D. 職員が手入力 | 外部連携しない | 警報は即時性が要る・運用負荷大。ユーザーは自動取得を選択済 → 不採用 |

## 決定

**B（既存「天気」Cloud Run Job に相乗り）+ 天気と同じ閉域・公開参照キャッシュパターン（ADR-021）** を採用する。これを **keyless 外部データの共通取得方式**とし、**気象警報・注意報を初回適用**する。熱中症 / WBGT・大気 / UV も**同方式（同一 Job への相乗り + 専用の公開参照キャッシュテーブル）で将来追加**する。

1. **取得は既存の天気 Cloud Run Job（`apps/jobs/src/weather/`）に相乗りさせる。新しい Cloud Run Job も Cloud Scheduler も作らない（＝新規の月額固定費ゼロ・ルール8 の新規追跡対象ゼロ）**。地域ループの各府県予報区コードに対し、天気取得に続けて警報も取得し、別テーブル `weather_warnings` へ upsert する。府県予報区コード（`resolveJmaAreaCode`）は天気と**完全に同じものを再利用**する（警報 JSON も同じ予報区コードでアクセスできる）。

2. **端末（サイネージ）は DB キャッシュ `weather_warnings` を SELECT するだけ**で、**JMA を直叩きしない**（端末閉域を維持＝ADR-021 と同思想）。盤面の他要素と同じ tx 内で RLS 越しに読む（サイネージ表示の結線は別 PR）。

3. **fail-soft（その地域だけ skip / last-known-good 維持）**: 警報取得の失敗は**天気取得を壊さない**（独立 try/catch で吸収）。失敗した地域は警報のみ skip し、既存の警報キャッシュ行（last-known-good）は消さない。天気・警報のいずれかが取れればその地域は前進する。全体は例外を投げず summary に件数を積み、entrypoint が WARN ログ化する（既存の天気 fail-soft と同方針・NFR02）。

4. **`weather_warnings` は school_id 非保持の公開・非 PII キャッシュ**。RLS は weather_forecasts（0017）/ railway_status（0025）と同じ **`read_all USING(true)`（全ロール + 匿名サイネージが SELECT 可）+ 書込みは system_admin のみ**（ADR-019 §公開参照マスタ特例・ルール6）。**生 PII を列に入れない**（地域コード・警報コード/名称・本文ヘッドライン・原文 JSON のみ）。取得 Job は system context で upsert する。

5. **派生値 `max_level`** を `warning_level` enum（`none` < `advisory`(注意報) < `warning`(警報) < `emergency`(特別警報)）で持つ。盤面の存在判定・強調表示を、jsonb の中身を端末側で再集計させずに済ませる（表示ロジックを単純化し、色非依存の段階表現を可能にする・NFR05）。導出は取得 Job 側のパーサで一元化する（単一ソース）。

6. **外部 egress は既存の天気 Job の単一経路を共有**（VPC connector → Cloud NAT、ADR-009）。**Terraform 変更なし**（新 Job / Scheduler / egress を増やさない）。

## keyless 外部データ追加の標準手順（本 ADR が定める共通方式）

新しい keyless 公開気象データ（熱中症 / WBGT・大気 / UV 等）を足すときは:

1. 公開参照キャッシュテーブルを 1 つ追加（school_id 非保持・公開型 RLS `read_all` + system 書込み・監査カラム・原文 `raw` 保全・`(area_code, source)` 等で一意）。
2. 純パーサを `apps/jobs/src/weather/` に追加（防御的・I/O 非依存）。
3. **既存の天気 Job の地域ループに 1 ステップ相乗りさせる**（新 Job / Scheduler を作らない）。fail-soft で天気・他種別を壊さない。
4. クエリ層（upsert = system context / read = RLS 委譲）を `packages/db/src/queries/` に追加。
5. 端末はそのテーブルを SELECT するだけ（直叩き禁止）。

## 残存リスク

- ① **JMA bosai の警報 JSON は非公式・無保証**（構造が予告なく変わりうる）。→ 防御的パース + 原文 `raw` 保全 + fail-soft（壊れても last-known-good・盤面は他要素を維持）。
  - **熱中症（環境省 alert CSV）の発表時刻依存**: 環境省は 05:00 / 17:00 JST に発表しファイル名が `alert_{発表日}_{HH}.csv`。Job が 17 時前に走ると当日 17 時ファイルが未生成で 404 → 熱中症だけ失敗していた（prod 実測）。→ **公開時刻(HH)非依存フォールバック**（最新順候補 `今日17 → 今日05 → 昨日17` を順に試行し最初の 2xx を採用、`heatAlertCandidates`）で時刻非依存化。全候補不発時のみ throw（fail-soft 維持）。
- ② **相乗りで天気 Job の 1 サイクル所要時間が増える**（地域あたり HTTP 1 本増）。→ 地域 dedup 済みで本数は地域数に比例。低頻度起動なので許容。天気と警報は独立 try/catch なので片方の遅延・失敗が他方を巻き込まない。
- ③ **更新頻度と即時性**: 警報は本来即時性が高いが、Job の起動間隔（30〜60 分）に律速される。MVP では許容し、即時性が要件化したら専用の高頻度トリガを別途検討（再検討トリガ）。

## 再検討トリガ

- 警報の即時性が SLA 化した → 警報だけ高頻度トリガ（Pub/Sub push 等）を別途検討。
- keyless 種別が増えて 1 Job の 1 サイクルが長くなりすぎた → 種別ごとの並列化 / Job 分割を再評価（その時点で固定費とのトレードオフを再計算）。
- JMA が警報の公式 API（キー方式・SLA 付き）を提供した → そちらへ移行。

## 影響

- 新規 `weather_warnings` テーブル（公開・非 PII・RLS `read_all`・監査・`warning_level` enum）+ 純パーサ `jma-warning.ts` + 取得 Job 相乗り（`run.ts` 拡張）+ クエリ層。**新 Cloud Run Job / Cloud Scheduler / Terraform 変更なし**（既存天気 Job に相乗り＝新規固定費ゼロ）。
- 端末閉域は維持（端末は DB のみ読む）。サイネージ盤面への警報表示の結線は **follow-up（別 PR）**。
- ルール4（Vertex マスキング）非接触（警報は公開・非 PII で LLM / embedding 経路に入れない）。
- STATUS.md の「外部取込み」は天気（ADR-021）・鉄道（ADR-035）に次ぐ 3 例目の外部取得。いずれも公開・非 PII・端末閉域維持の枠内。
