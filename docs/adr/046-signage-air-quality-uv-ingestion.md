# ADR-046: サイネージ 大気質(PM2.5)/UV指数 の keyless 取得 — 天気 Job 相乗り（ADR-044 の 5 例目・最も脆いソース）

- 状態: Accepted（2026-06-18）
- 日付: 2026-06-18（Proposed / Accepted 同日。大気質バックエンドの実装と同時）
- 関連: [ADR-044 keyless 外部データの天気 Job 相乗り（親方式）](044-signage-keyless-external-data-relay.md), [ADR-021 サイネージ天気（閉域・JMA の先例）](021-weather-data-source-jma.md), [ADR-035 鉄道運行情報（公開参照キャッシュ・スクレイプ相当の先例）](035-railway-operation-status-scraping.md), [ADR-019 RLS 二層 + 公開参照マスタ特例], [ADR-016 サイネージ匿名], [ADR-009 Terraform / 単一 egress](009-terraform.md), [CLAUDE.md ルール1（監査）/ ルール2（RLS）/ ルール4（PII）/ ルール5（secret/log）/ ルール8（Terraform）]

## 文脈

サイネージ盤面に **大気質（PM2.5 / 大気汚染）と紫外線指数(UV)** を出したい（ユーザー要望）。これは ADR-044 が定めた「keyless 公開気象データの天気 Job 相乗り取得方式」の **5 例目**（天気=ADR-021 / 警報=ADR-044 / 熱中症=ADR-044 / 学校カレンダー=ADR-045 に続く）であり、固定費ゼロ自動コンテンツ 5 本目の最終 PR である。

ただし本データは **これまでで最も脆いソース**である:

- **PM2.5（主目的）= 環境省「そらまめくん」**（https://soramame.env.go.jp）。keyless・公開だが、**正規の公開 JSON/CSV API 契約が確認できない JS SPA**。測定局コードベースの内部 API を叩く実質スクレイプ相当で、形式・エンドポイントは非公式・無保証。
- **UV = 気象庁 紫外線情報**。データ配信は **GRIB2 バイナリ**（緯度経度グリッド）が中心で、keyless で府県単位の JSON/CSV を素直に取れる経路が確立していない（分布図 PNG / GRIB2 のみ）。

JMA bosai JSON（天気・警報）や 環境省 熱中症 alert CSV は URL/形式を確認できる準・正規データだったのに対し、本ソースは **取得経路そのものが不確実**である。

## 候補

| 候補 | 概要 | 評価 |
|---|---|---|
| **A. 天気 Job 相乗り + 公開参照キャッシュ（採用）** | ADR-044 標準手順どおり、地域ループに PM2.5 取得を 1 ステップ相乗りさせ `air_quality_index` へ upsert | **新規 Job / Scheduler ゼロ = 固定費ゼロ**（ADR-044 §決定）。脆さは防御的パーサ + fail-soft + raw 保全で吸収 |
| B. PM2.5 専用 Job / 商用 AQI API（キー方式） | キー付き商用 API（AQICN 等）に切替 | キー = ルール5 の管理対象増 + 月額。MVP に重い。keyless 方針から外れる。不採用 |
| C. UV も本 PR で取得（GRIB2 を自前デコード） | GRIB2 を Job 内でデコードして UV を県別集計 | GRIB2 デコード + グリッド→府県集計は本 PR スコープに対し過大。脆さ二重。**列だけ用意し follow-up**（後述） |
| D. 端末直叩き / 手入力 | 端末から環境省を叩く / 職員手入力 | 端末閉域破壊（ADR-021）/ 運用負荷。不採用 |

## 決定

**A（天気 Job 相乗り + 公開参照キャッシュ、ADR-044 標準手順）** を採用する。脆さは設計で囲い込む。

1. **取得は既存の天気 Cloud Run Job（`apps/jobs/src/weather/`）に相乗り**させる。**新しい Cloud Run Job / Cloud Scheduler / egress / Terraform 変更は作らない**（ADR-044 §決定 = 新規固定費ゼロ）。地域ループ（府県予報区コード `resolveJmaAreaCode`）の各地域に対し、天気・警報・熱中症に続けて大気質も取得し `air_quality_index` へ upsert する。

2. **PM2.5 を主目的として取得**する。ソース = 環境省そらまめくん。`area_code` は天気・熱中症と同じ JMA 府県予報区コード体系を再利用する（そらまめくんの測定局コードは取得 Job 側で府県へ畳む。当面は府県予報区コードの上 2 桁＝都道府県コードでスコープした想定 URL を使う）。光化学オキシダント（oxidant）は **列だけ用意し取得は follow-up**（PoC では PM2.5 を出せれば十分）。

3. **UV は列だけ用意し、本 PR では取得しない**。理由は keyless で府県単位の JSON/CSV を取れる経路が無い（GRIB2 のみ）ため。`uv_index` / `uv_band` 列・`air_quality_source` enum の `jma_uv` 値は **予約**し、将来 keyless 経路（または GRIB2 デコード）が確立したら同方式で upsert する（**follow-up**）。盤面 UV 表示も follow-up。

4. **最も脆いソース前提の多層防御**（JMA / 熱中症 CSV 以上に強める）:
   - **完全防御的パーサ** `parseSoramameAir`（`apps/jobs/src/weather/env-air.ts`）: 入力は形が不確実な `unknown`。フィールド名・型・存在を一切前提にせず、PM2.5 の複数候補キー（`pm25` / `PM25` / `pm2_5` / `'PM2.5'` 等）を順に当て、数値化できなければ **null**。**throw しない**（壊れていても全 null の安全な既定を返し last-known-good を壊さない）。負値・欠測コード（`-` / `***` / 空）も自然に null。
   - **fail-soft 相乗り**（`run.ts`）: 大気質取得は天気・警報・熱中症と **独立 try/catch**。大気質の失敗が他指標を巻き込まない。失敗地域はその地域の大気質だけ skip し、既存キャッシュ（last-known-good）を消さない。
   - **原文 `raw` 保全**: 取得層が渡した生オブジェクトを `raw` に残す（非公式・無保証ゆえ後追い解析・障害調査用）。
   - **代表 fixture + 単体テスト**: パーサ正常 / 候補キー違い / 欠落 / 壊れ / 区分境界、相乗り fail-soft、HTTP 取得を fixture で固定（ネットワーク非依存）。

5. **`air_quality_index` は school_id 非保持の公開・非 PII キャッシュ**。RLS は天気系（0017）/ 熱中症（0030）と同じ **`read_all USING(true)`（全ロール + 匿名サイネージ SELECT 可）+ 書込みは system_admin のみ**（ADR-019 §公開参照マスタ特例）。**生 PII を列に入れない**（地域コード・名称・大気/紫外線の数値・原文のみ）。取得 Job は system context で upsert する。よってルール4（Vertex マスキング）非接触（LLM / embedding 経路に入れない）。

6. **端末（サイネージ）は DB キャッシュを SELECT するだけ**で環境省・気象庁を直叩きしない（端末閉域を維持＝ADR-021 と同思想）。盤面表示の結線は **follow-up（別 PR）**。

## WebFetch 確証点 vs 想定

- ✅ **確証**: そらまめくんは **keyless・公開**であり、API マニュアルページ（`https://soramame.env.go.jp/apiManual`）と地域別データ参照（測定局コードベース、例 `/preview/chart/01108010/7day/PM25/-`）が存在する。
- ✅ **確証**: そらまめくんの公開ページは **JS SPA で、サーバサイド fetch では中身（API 契約・JSON フィールド名）を確認できなかった**（WebFetch は title のみ取得）。よって **エンドポイント形式・JSON フィールド名は不確実**。
- ⚠️ **想定（初版・2026-06-18 PR #1060）**: 取得 URL（`soramameAirUrl`）・PM2.5 のフィールド名は **想定値**。形式が想定外でもパーサが全 null に倒し、その地域は skip（last-known-good 維持）。実エンドポイント確定は **follow-up**。
- ✅ **確証（fix・2026-06-19）**: 実 keyless エンドポイントを確定した（後述「実エンドポイント確定」節）。想定 URL（`/data/sokutei/code/{prefCode}.json`）は **実在せず SPA の index.html（HTTP 200 / `text/html`）を返す**ため `res.json()` が throw し、本番 weather Job が `airFailed=1` に倒れていた。SPA バンドル解析で **実データ URL** を確認し、`soramameAirUrl`（想定 URL）を撤去して metadata→全国 CSV 経路に切替えた。
- ✅ **確証**: 気象庁 UV は **GRIB2 バイナリ配信**が中心で、keyless で府県単位 JSON/CSV を取れる経路が無い → **UV は本 PR 未取得・列予約 + follow-up**。

## 実エンドポイント確定（2026-06-19 fix）

初版の想定 URL（`/data/sokutei/code/{prefCode}.json`）は実在せず SPA の HTML を返していた（本番 `airFailed=1`）。SPA バンドル（`/js/app.*.js`）の `calDataOptions` を解析し、SPA 自身が叩く **実データ URL** を実取得（HTTP 200 + パース可能）で確証した:

1. **鮮度メタ**: `GET https://soramame.env.go.jp/data/sokutei/noudoAll/metadata.json`
   → `{"latest":"2026/06/19 09:00:00","oldest":"2021/01/25 00:00:00","interval":"3600"}`（`Content-Type: application/json`）。
2. **全国 1 時間値 CSV（全測定局 1 ファイル）**: `GET …/noudoAll/{YYYY}/{MM}/{DD}/{HH}.csv`（SPA の `rule:"{YYYY}/{MM}/{DD}/{HH}.csv"` と一致、`Content-Type: text/csv`、約 1626 行 / 約 260KB）。
   ヘッダ: `測定局コード,SO2,NO,NO2,NOX,CO,OX,NMHC,CH4,THC,SPM,PM2.5,SP,WD,WS,TEMP,HUM,測定局名称,住所,問い合わせ先,局種別,地域コード,都道府県コード,市区町村名`。
   1 行 = 1 測定局・当該 1 時間の実測値。`PM2.5` 列（idx 11, µg/m³）・`都道府県コード`列（idx 22, JIS 2 桁）を使う。**全 47 都道府県に PM2.5 値が存在**することを実取得で確認（例: 岐阜 '21' で PM2.5 を持つ局 18 / 24）。

決定:
- **未公開時刻の CSV は 404 ではなく HTTP 200 + HTML を返す**（SPA fallback）。よって時刻を当てに行かず、**必ず `metadata.json` の `latest` を読んでから**その時刻の CSV URL を組む（多層防御として、HTML を掴んでもパーサが該当府県行を見つけられず全 null に倒れる）。
- 取得 Job は CSV を府県（area_code 上 2 桁）でフィルタし **PM2.5 中央値**を `air_quality_index` に upsert する（残存リスク② 決着）。
- OX（光化学オキシダント）は ppm 配信（ppb 換算・代表値選定が別途必要）のため本 fix も取得しない（列予約のまま）。UV も引き続き未取得（GRIB2、列予約）。
- schema / RLS / Terraform は不変（取得層のパース・URL のみ変更）。

## 残存リスク

- ① **そらまめくんは非公式・無保証（最も脆い）**: 実 URL は確定（後述）したが、列順・公開時刻・配信形式は依然予告なく変わりうる。→ 完全防御的パーサ（定数列インデックス + 欠測/列ずれ/HTML fallback 耐性）+ raw 保全 + fail-soft（壊れても last-known-good・他指標・盤面は維持）。実形式が変われば PM2.5 は当面 null（盤面は大気質ウィジェットを出さない）。
- ② **PM2.5 は測定局単位 ⇄ 本キャッシュは府県単位（決着済）**: 全国 CSV を府県（area_code 上 2 桁＝都道府県コード）でフィルタし、府県内観測局の **PM2.5 中央値**を代表値に採る（中央値は自排局の高め値・欠測の歪みに平均より頑健）。集計に用いた局数・サンプルは `raw` に保全して後追い解析できる。
- ③ **UV 未取得**: 盤面 UV は出せない（列は null）。GRIB2 デコード or 別 keyless 経路の確立が follow-up。
- ④ 相乗りで天気 Job の 1 サイクルが地域あたり HTTP 1 本増（ADR-044 §残存リスク② と同じ。低頻度・地域 dedup 済で許容）。

## 再検討トリガ

- ~~そらまめくんの実 API 契約を確認できた / 商用 keyless AQI が使える → `soramameAirUrl` + 候補キーを実形式へ確定~~ → **2026-06-19 fix で実エンドポイント確定済**（noudoAll 全国 CSV、上記節）。今後そらまめくんが列順・配信形式を変えた場合は `parseSoramameNoudoAllCsv` の列定数・`fetchAirFromEnv` の URL 経路を実形式へ追従（schema は不変で済む構造）。
- UV の keyless 府県取得経路が確立した（または GRIB2 デコードを別 Job で行う判断）→ `jma_uv` ソースで `uv_index` / `uv_band` を upsert。
- 大気質の即時性 / 精度が SLA 化した → 商用 API（キー方式）への移行を ADR で再評価。

## 影響

- 新規 `air_quality_index` テーブル（公開・非 PII・RLS `read_all`・監査・`air_quality_source` enum・`pm25` / `pm25_band` / `oxidant` / `uv_index` / `uv_band` / `raw`）+ 純パーサ `env-air.ts` + 取得 Job 相乗り（`run.ts` 5 例目）+ クエリ層 + RLS migration（0033）。**新 Cloud Run Job / Cloud Scheduler / Terraform 変更なし**（既存天気 Job 相乗り = 新規固定費ゼロ）。
- 端末閉域は維持（端末は DB のみ読む）。**サイネージ盤面への大気質 / UV 表示の結線は follow-up（別 PR）**。oxidant 取得・UV 取得・代表局選定も follow-up。
- ルール4（Vertex マスキング）非接触（大気質・UV は公開・非 PII で LLM / embedding 経路に入れない）。
- STATUS.md の「外部取込み」は天気（ADR-021）・鉄道（ADR-035）・ニュース（ADR-043）・警報/熱中症（ADR-044）・カレンダー（ADR-045）に次ぐ keyless 公開参照キャッシュ。固定費ゼロ自動コンテンツ 5 本の最終本。
