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

## 再検討トリガ

- Google Calendar API（プライベートカレンダー）連携が要件化した → Workload Identity / OAuth ドメイン委任の別 ADR を起こす（候補 B）。
- 繰返し（MONTHLY/YEARLY/BYDAY/EXDATE）の正確な展開が要件化した → 軽量 iCal ライブラリ採用（Dependency Review CI 通過前提）または展開ロジック拡張。
- 1 校 1 ソースで足りなくなった（複数カレンダー統合表示）→ `unique(school_id)` を外し source 複数化（follow-up）。
- per-school フェーズで天気 Job の 1 サイクルが長くなりすぎた → 分割 / 並列化を再評価。

## 影響

- 新規 `school_calendar_sources` / `school_calendar_events` テーブル（per-school・tenant_isolation・監査）+ 純パーサ `apps/jobs/src/calendar/ical.ts` + 取得 Job の per-school フェーズ相乗り（`weather/run.ts` 拡張）+ クエリ層 `packages/db/src/queries/school-calendar.ts`。**新 Cloud Run Job / Cloud Scheduler / Terraform 変更なし**（既存天気 Job に相乗り＝新規固定費ゼロ、ルール8）。
- 端末閉域は維持（端末は自社 DB のみ読む）。**サイネージ盤面への行事表示の結線・設定 UI（school_admin が ics_url 登録）は follow-up（別 PR）**。prod の `school_calendar_sources` 初期投入は **ops 手順**（公開 iCal URL を ops が登録）。
- ルール4（Vertex マスキング）: 行事は LLM / embedding 経路に **載せない**（送信しないので「マスキング」ではなく「非送信」で対処）。
- ルール5（secret）: **SA JSON 鍵を使わない keyless 設計**。`ics_url` は secret ではない公開 URL。`DATABASE_URL` は従来どおり Secret Manager 経由。
- STATUS.md の「外部取込み」は天気（ADR-021）・鉄道（ADR-035）・警報/熱中症（ADR-044）・ニュース（ADR-043）に次ぐ系統で、**初の per-school（tenant_isolation）外部取込**。
