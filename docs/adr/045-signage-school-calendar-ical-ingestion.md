# ADR-045: 学校行事カレンダーの公開 iCal/ICS 取込（per-school・tenant_isolation・天気 Job 相乗り）

- 状態: Accepted（2026-06-18、ユーザー判断）
- 日付: 2026-06-18（Proposed / Accepted 同日。学校行事カレンダーバックエンドの実装と同時）
- 関連: [ADR-044 keyless 外部データの天気 Job 相乗り（本 ADR の per-school 拡張元）](044-signage-keyless-external-data-relay.md), [ADR-021 サイネージ天気（閉域・JMA の先例）](021-weather-data-source-jma.md), [ADR-043 工学ニュース外部取得（keyless 公開取得の姉妹）](043-signage-engineering-news-external-fetch.md), [ADR-019 RLS 二層分離], [ADR-016 サイネージ匿名コンテキスト], [ADR-009 Terraform / 単一 egress](009-terraform.md), [CLAUDE.md ルール1（監査）/ ルール2（RLS）/ ルール4（PII）/ ルール5（secret・SA JSON 鍵禁止）/ ルール8（Terraform）]

## 文脈

サイネージ盤面に **学校行事カレンダー**（始業式・体育祭・定期試験・保護者会等の公開行事）を出したい（ユーザー要望）。これは天気（ADR-021）・気象警報（ADR-044）・工学ニュース（ADR-043）に続く外部データだが、**性質が決定的に異なる**:

- 天気 / 警報 / ニュースは **学校横断の公開・非 PII・地域単位**の共有キャッシュ（`school_id` 非保持、誰が見ても同じ）。
- **学校行事は「その学校固有のデータ」**（A 高校の体育祭は B 高校に関係ない）。**`school_id` を持ち、テナント分離が必須**。

取得方式には 2 つの論点がある: (1) **どう認証するか**（カレンダー連携は通常 OAuth / API 鍵が要る）、(2) **どう実行基盤を増やすか**（種別ごとに Job/Scheduler を新設すると固定費が線形に膨らむ、ADR-044 の問題意識と同じ）。

## 候補

### 認証方式（どのカレンダーをどう読むか）

| 候補 | 概要 | 評価 |
|---|---|---|
| A. Google Calendar API + サービスアカウント JSON 鍵 | SA 鍵で学校のプライベートカレンダーを読む | **CLAUDE.md ルール5 違反**（SA JSON キーをファイルで配布禁止）。不採用 |
| B. Google Calendar API + Workload Identity（OAuth・ドメイン委任） | keyless で読むが、ドメイン委任・スコープ同意・各校テナントとの OAuth 連携の設計が要る | keyless ではあるが **認証・委任設計が重く、別途 ADR が必要**。MVP には過剰 → **本 PR では見送り**（要件化したら別 ADR で再検討） |
| **C. 公開 iCal/ICS URL（keyless・採用）** | Google カレンダー等の「公開アドレス（iCal 形式）」= 認証不要で誰でも GET できる URL を学校ごとに登録し、その ICS を取得 | **認証不要（keyless）＝ルール5 に最も素直**（鍵も OAuth credentials も持たない）。学校側が「公開行事カレンダー」を公開アドレスで出すだけで連携できる。MVP に最軽量 |
| D. 職員が手入力 | 外部連携しない | 行事は数が多く運用負荷大。ユーザーは自動取込を選好 → 不採用 |

### 実行基盤（どう取得を回すか）

| 候補 | 概要 | 評価 |
|---|---|---|
| A. 学校カレンダー専用 Cloud Run Job + Scheduler 新設 | 独立 Job | **種別ごとに固定費（Scheduler + Job 起動 + egress + 監視）が増える**（ADR-044 と同じ問題）。不採用 |
| **B. 既存「天気」Cloud Run Job に per-school フェーズで相乗り（採用）** | 地域ループの後に「有効ソース列挙 → 各校の ICS 取得 → upsert」フェーズを足す | **新規 Job / Scheduler ゼロ＝新規固定費ゼロ**。egress・User-Agent・タイムアウト・監視・接続を再利用。ADR-044 の relay 思想の **per-school 拡張** |

## 決定

**認証は C（公開 iCal/ICS URL・keyless）、実行は B（既存天気 Job への per-school 相乗り）** を採用する。

1. **公開 iCal/ICS URL のみを扱う（keyless、ルール5）**。学校ごとに 1 件の公開アドレス（iCal 形式）を `school_calendar_sources.ics_url` に登録する。**サービスアカウント JSON 鍵は使わない**（ルール5 が SA JSON キーのファイル配布を禁じる）。Workload Identity で読む **Google Calendar API 連携（候補 B）は別途要 ADR として見送る**（OAuth ドメイン委任の設計が重く、MVP に過剰。要件化したら再検討トリガ）。

2. **per-school = tenant_isolation（ルール2 / ADR-019）**。`school_calendar_sources` / `school_calendar_events` は `school_id` を持つテナント分離テーブル。RLS は `daily_data` / `tv_devices`（0016）と同じ **tenant_isolation（school_id 一致）+ system_admin_full_access**（migrations/0032）。weather_warnings 等の公開参照（`read_all USING(true)`）とは **異なる**。これにより自校コンテキスト（school_admin / teacher / student / guardian、または **匿名サイネージ** = role 未設定で school_id のみ set）は自校行事のみ読め、**他校行事は不可視**になる（本 PR の肝）。

3. **既存の天気 Cloud Run Job に per-school フェーズで相乗り（新 Job / Scheduler なし＝固定費ゼロ、ADR-044 の per-school 拡張）**。地域ループ（天気・警報・熱中症）の **後** に、独立した「カレンダーフェーズ」を回す: system_admin context で `listEnabledCalendarSources` → 各校の `ics_url` を HTTP 取得（timeout / 明示 User-Agent、`fetchWarningFromJma` に倣う）→ `parseIcs` → 各イベントを **school_id を明示して** upsert。取得 Job は session が無いため **system_admin context**（`system_admin_full_access` policy）で cross-tenant に列挙・書込みする（`tv_devices` のポーリング解決と同じ流儀。BYPASSRLS 不使用、ルール2）。**fail-soft**: 1 校の失敗は他校・天気系を壊さない（独立 try/catch・last-known-good 維持）。

4. **PII / サイネージ露出の考慮（ルール4 / セキュリティ最優先）**。接続するカレンダーは **「学校公開行事カレンダー」専用**（公開行事のみ）とし、**生徒氏名・保護者名等を含む私的カレンダーを繋がない運用前提**とする。`summary` / `location` には公開行事名・場所のみが入る想定。取得失敗理由を残す `last_error` には **生 PII を入れない**（HTTP status・パースエラー種別等のみ）。本テーブルは tenant_isolation で他校から不可視であり、行事は **LLM / embedding 経路には載せない**（ルール4 のマスキング対象外＝そもそも外部送信しない）。`ics_url` は推測しにくい公開アドレスでありうるが、それ自体は「学校公開行事カレンダーの在りか」であって PII ではない。

5. **RRULE 等の対応範囲**（手書きパーサのサブセット）。RFC 5545 を完全実装せず、サイネージ表示に要る **防御的サブセット**だけを自前パースする:
   - VEVENT の **UID / SUMMARY / DTSTART / DTEND / LOCATION**、終日（`VALUE=DATE`）/ 時刻付き（`T...` / `Z`）、行折り返し（unfolding）、TEXT エスケープ（`\n` `\,` `\;` `\\`）。
   - **繰返し（RRULE）は `FREQ=DAILY` / `FREQ=WEEKLY` の `COUNT` / `UNTIL` のみ**展開する（安全上限 366 件でクランプ）。`MONTHLY` / `YEARLY` / `BYDAY` 等の複雑規則・`EXDATE` / `RDATE` は **展開せず元の 1 件のみ**を返す（取りこぼしても落とさない）。
   - **TZID（VTIMEZONE）は厳密展開せず JST 暦日に倒す**簡略実装（PoC 規模の学校カレンダーは JST 前提）。
   - すべて **fail-soft**（壊れた VEVENT は skip・throw しない）・原文 `raw` 保全。

   依存方針: 軽量・低依存の iCal ライブラリ（node-ical / ical.js 等）が Dependency Review CI を通れば採用してもよいが、**本 PR は依存を増やさず自前サブセットを採用**した（blast radius 最小化・既存の防御的パーサ流儀 `jma-warning.ts` / `news-parse.ts` と一貫）。繰返しの本格対応が要件化したらライブラリ採用を再検討する（§再検討トリガ）。

6. **SSRF 緩和（半信頼 `ics_url` の取得を内部到達から守る・セキュリティ最優先）**。`ics_url` は school_admin（将来の設定 UI / ops 投入）が登録する **半信頼の外部入力**であり、取得は weather Cloud Run Job 上で **egress=ALL_TRAFFIC（VPC コネクタ経由）** で走る。この Job は Cloud SQL プライベート IP（10/8 等）・**GCP メタデータサーバ `169.254.169.254`（SA トークン窃取に直結）**・他内部サービスに **到達できる**ため、素の `fetch(ics_url)` は **ブラインド SSRF** 面になる（任意内部 URL を踏ませて応答有無・タイミングで内部を探索 / メタデータ窃取）。これを防ぐため、iCal 取得を専用ユーティリティ `apps/jobs/src/calendar/safe-fetch.ts`（`fetchPublicIcs`）に隔離し、**多層防御**を強制する。JMA / 環境省（天気・警報・熱中症）は **コード内固定 URL** なので本ガードの対象外（カレンダーのみ semi-trusted URL を扱う）:
   - **scheme は https のみ**許可（`http` / `file` / `ftp` / `data` 等は拒否）。
   - **ホスト検証**: IP リテラルはそのまま、ホスト名は **DNS 解決（A/AAAA 全件）して解決された全 IP** を検査し、プライベート/予約レンジを 1 つでも含めば拒否。対象レンジ — IPv4: `0/8`, `10/8`, `100.64/10`(CGNAT), `127/8`, **`169.254/16`（メタデータ含む）**, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`, `255.255.255.255`; IPv6: `::1`, `::`, `::ffff:0:0/96`（IPv4-mapped は内側 v4 を再検査）, `fc00::/7`(ULA), `fe80::/10`(link-local)。`localhost` / `*.localhost` / `*.internal` / `metadata.google.internal` 等の **ホスト名**も明示拒否。
   - **リダイレクト安全**: `redirect:"manual"` で自前処理し、**各ホップの `Location` を再度 scheme + 解決 IP で検証**してから次へ進む（公開ホストから内部 IP へ誘導する 30x 攻撃を塞ぐ）。最大 `maxRedirects`（既定 3）超過・`Location` 欠落・検証失敗は拒否。
   - **レスポンスサイズ上限** `maxBytes`（既定 5MB）。ストリームで読み、超過は読み取り中断 + 拒否（巨大 body による DoS / メモリ枯渇回避）。
   - **認証情報を送らない**（`credentials:"omit"`・cookie 無し）、明示 User-Agent、`AbortController` で timeout。
   - **fail-soft**: 検証違反・取得失敗はいずれも throw し、`run.ts` のカレンダーフェーズが **当該校だけ skip**（他校・天気/警報/熱中症は継続・last-known-good 維持）。
   - **テスト容易性**: DNS resolver と fetch を **依存注入**できる（既定は実体）。SSRF ガードは `apps/jobs/src/calendar/__tests__/safe-fetch.test.ts` で http 拒否・各種内部 IP（v4/v6/IPv4-mapped）拒否・公開許可・リダイレクト内部誘導拒否 / 公開追従・サイズ超過・timeout を網羅。

7. **取込上限（巨大 iCal の行量産 / DoS 抑制・MINOR）**。1 ソースあたり upsert する VEVENT 総数を `MAX_EVENTS_PER_SOURCE`（= 2000）でクランプする。超過分は **切り捨てつつ構造化 WARN ログ**（`event: "calendar.ingest.truncated"` に `sourceId` / `parsed` / `kept` / `dropped` 件数）で明示する（**沈黙の切り捨て禁止** = 何件落としたか必ずログに出す）。既存の RRULE 1 イベントあたり 366 件上限（`MAX_RECURRENCE_OCCURRENCES`）はそのまま（こちらは 1 VEVENT の展開上限、`MAX_EVENTS_PER_SOURCE` は 1 ソース全体の上限で二段防御）。

## keyless per-school データ追加の標準手順（本 ADR が定める拡張パターン）

ADR-044（地域単位・公開参照）に対し、本 ADR は **per-school・tenant_isolation** 版の標準手順を定める:

1. per-school テーブルを追加（`school_id` 保持・tenant_isolation + system_admin_full_access・監査カラム・原文 `raw` 保全・`(school_id, key)` で一意）。
2. 純パーサを追加（防御的・I/O 非依存・fail-soft）。
3. **既存の天気 Job に per-school フェーズで相乗り**させる（新 Job / Scheduler を作らない）。system_admin context で列挙 → 各校 school_id を明示して upsert。fail-soft で他校・他種別を壊さない。
4. クエリ層（取得 Job = system context の列挙 / upsert / 掃除、read = tenant_isolation 委譲）を追加。
5. 端末は自社 DB を SELECT するだけ（直叩き禁止・閉域維持）。

## 残存リスク

- ① **公開 iCal の私的化リスク**: 運用前提（公開行事カレンダー専用）が破られ、PII を含む私的カレンダーが登録されると、サイネージに生徒氏名等が露出しうる。→ 設定 UI（follow-up）に注意書き + ops 手順で「公開行事専用」を明記。tenant_isolation で **他校露出は防げる**が、**自校サイネージへの自校 PII 露出**は運用規律で防ぐ（本テーブルは LLM/embedding には載せない）。
- ② **iCal フォーマットの実装差**: Google / Outlook / 各種ツールで VEVENT の表現が揺れる。→ 防御的パース + 原文 `raw` 保全 + fail-soft（壊れた VEVENT は skip）。
- ③ **RRULE 取りこぼし**: 対応外の繰返し（MONTHLY 等）は初回 1 件しか出ない。→ MVP では許容。要件化したらライブラリ採用 / 展開拡張（再検討トリガ）。
- ④ **更新頻度**: Job の起動間隔（30〜60 分）に律速。行事は即時性が低いので許容。
- ⑤ **相乗りで天気 Job の 1 サイクルが延びる**: per-school で HTTP が校数ぶん増える。PoC（1 校）では無視できる。校数増で長くなったら分割を再検討（ADR-044 §再検討トリガと共通）。
- ⑥ **DNS リバインディング（SSRF の TOCTOU 残余）**: `safe-fetch.ts` は「DNS 解決 → 解決 IP を検査 → fetch」の順だが、**検査時に解決した IP と、その後 fetch 内部で OS が再解決する IP がズレうる**（攻撃者が短い TTL で公開 IP → 内部 IP に差し替える古典的 DNS リバインディング）。完全に塞ぐには **検証済み IP への接続ピンニング**（undici custom dispatcher / `lookup` フックで解決 IP を固定し、その IP に直接接続しつつ TLS SNI/Host だけ元ホスト名を使う）が要る。**本 PR スコープ外**とし、現状は (a) https 限定で MITM を難しくし、(b) リダイレクトの各ホップを再検証し、(c) 解決された全 IP を検査することで、実務上の主要面（直接内部 URL・リダイレクト内部誘導・部分的に内部へ向く DNS）を塞ぐ。IP ピンニングは要件化したら follow-up（脅威モデル上、攻撃者は登録 `ics_url` を自由に選べる school_admin 相当の半信頼アクタであり、メタデータ窃取の主要経路は本ガードで遮断済み）。

## 再検討トリガ

- Google Calendar API（プライベートカレンダー）連携が要件化した → Workload Identity / OAuth ドメイン委任の別 ADR を起こす（候補 B）。
- 繰返し（MONTHLY/YEARLY/BYDAY/EXDATE）の正確な展開が要件化した → 軽量 iCal ライブラリ採用（Dependency Review CI 通過前提）または展開ロジック拡張。
- 1 校 1 ソースで足りなくなった（複数カレンダー統合表示）→ `unique(school_id)` を外し source 複数化（follow-up）。
- per-school フェーズで天気 Job の 1 サイクルが長くなりすぎた → 分割 / 並列化を再評価。
- SSRF の脅威モデルが上がった（外部公開の登録 UI 等で攻撃者が任意 `ics_url` を入れやすくなった）→ **DNS リバインディング対策の IP ピンニング**（undici dispatcher で解決済み IP に固定接続）を導入（残存リスク⑥）。

## 影響

- 新規 `school_calendar_sources` / `school_calendar_events` テーブル（per-school・tenant_isolation・監査）+ 純パーサ `apps/jobs/src/calendar/ical.ts` + **SSRF セーフ取得ユーティリティ `apps/jobs/src/calendar/safe-fetch.ts`（`fetchPublicIcs`・https 限定 / プライベート IP 拒否 / リダイレクト各ホップ再検証 / サイズ上限 / 認証情報不送信、DI で単体検証）** + 取得 Job の per-school フェーズ相乗り（`weather/run.ts` 拡張・`fetchIcs` は `fetchPublicIcs` 経由 + `MAX_EVENTS_PER_SOURCE` クランプ）+ クエリ層 `packages/db/src/queries/school-calendar.ts`。**新 Cloud Run Job / Cloud Scheduler / Terraform 変更なし**（既存天気 Job に相乗り＝新規固定費ゼロ、ルール8）。
- 端末閉域は維持（端末は自社 DB のみ読む）。**サイネージ盤面への行事表示の結線・設定 UI（school_admin が ics_url 登録）は follow-up（別 PR）**。prod の `school_calendar_sources` 初期投入は **ops 手順**（公開 iCal URL を ops が登録）。
- ルール4（Vertex マスキング）: 行事は LLM / embedding 経路に **載せない**（送信しないので「マスキング」ではなく「非送信」で対処）。
- ルール5（secret）: **SA JSON 鍵を使わない keyless 設計**。`ics_url` は secret ではない公開 URL。`DATABASE_URL` は従来どおり Secret Manager 経由。
- STATUS.md の「外部取込み」は天気（ADR-021）・鉄道（ADR-035）・警報/熱中症（ADR-044）・ニュース（ADR-043）に次ぐ系統で、**初の per-school（tenant_isolation）外部取込**。
