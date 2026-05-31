# Phase 検証 トラック④: 非機能テスト — 詳細設計

> 親: [docs/testing/test-strategy.md](../test-strategy.md)
> トレース元: [NFR01-performance](../../requirements/non-functional/NFR01-performance.md) / [NFR02-availability](../../requirements/non-functional/NFR02-availability.md) / [NFR06-cost-policy](../../requirements/non-functional/NFR06-cost-policy.md)
> 関連 ADR: ADR-002 (Cloud Run) / ADR-001 (Cloud SQL HA) / ADR-005 (Vertex AI) / ADR-006 (Vercel AI SDK) / ADR-014 (Observability)

最終更新: 2026-05-31
ステータス: **詳細設計ドラフト**

---

## 1. 目的とスコープ（in / out）

性能・負荷・可用性・コストの 4 観点で、staging に統合された全機能が NFR01/02/06 の閾値を満たすことを、
**代表的な負荷プロファイル + 合否閾値 + 測定手法** の粒度で受入ゲート化する。

### In（このトラックで扱う）

- NFR01 の 5 つの性能閾値（API p95 / AI 初回トークン / サイネージロード / DB クエリ p95 / 公開反映 60 秒）の検証
- 現実規模の同時接続負荷プロファイル（通常・ピーク・スパイク・soak）
- 可用性・レジリエンス（cold start 挙動 / DB 接続断 / Vertex AI タイムアウト / 部分障害時の degrade / min-instances 効果）
- 負荷時の課金がコスト想定内かのコスト回帰確認（NFR06 はコスト天井を設けない方針だが、**異常な課金スパイク = 設計欠陥のシグナル**として観測する）

### Out（このトラックで扱わない）

- **本番インフラへの負荷試験**（コスト/リスク。本番負荷は導入フェーズの人間判断 → [§11](#11-claude--人間の境界)）
- 機能正当性（→ トラック①）/ UI/UX・アクセシビリティ（→ トラック②）/ 敵対セキュリティ（→ トラック③）
- rate limit の**機能的正当性**（429 が返るか等）の単体検証は既存 `__tests__/api/rate-limit/` の責務。
  本トラックは rate limit が**負荷時に課金暴走を抑制する効果**のみを扱う。
- SLA 99.5% の**長期実測**（月間ダウンタイム集計は本番運用フェーズの観測対象。本トラックは構成の妥当性のみ確認）

---

## 2. 前提・環境・想定規模（現実的な負荷前提）

| 項目 | 値 | 根拠 |
|---|---|---|
| 環境 | **staging 限定・合成データのみ** | test-strategy.md §2 / CLAUDE.md ルール4 |
| 本番負荷試験 | **禁止** | コスト/リスク。導入フェーズで人間判断 |
| Cloud Run | min-instances=1（critical path）、asia-northeast1 | NFR01 / ADR-002 |
| Cloud SQL | HA 構成（regional, automatic failover） | NFR02 / ADR-001 |
| Gemini モデル | Pro 固定（MVP） | NFR06 |

### 想定規模（PoC 現実規模に接地。過大な負荷を仮定しない）

PoC は **岐南工業 3 クラス**。将来は複数校・複数クラスのサイネージ同時配信。
負荷プロファイルは「現実規模 × 安全係数」で設計し、机上の最悪値は積まない。

| アクター | 現実規模（PoC） | 将来拡張の上限想定（負荷試験の天井） |
|---|---|---|
| サイネージ端末（firmware ポーリング） | 3 台（1 クラス 1 台） | 30 台（10 校相当） |
| 教員（同時編集） | 3〜5 名 | 30 名 |
| 生徒（magic-link 閲覧 / AI 質問） | 1 クラス 40 名 × 3 = 120 名、同時アクティブ ~30% | 同時 ~360 名（3 校 × 360 在籍の 30%） |
| AI 質問レート（F06） | magic_link あたり 1 分 10 質問が rate limit 上限 | 同 |

> 安全係数: 将来上限は PoC 現実規模の約 **10 倍**を天井とする。これ以上の負荷は導入後の実測 + キャパシティプランで扱う（机上で過大に積まない）。

---

## 3. 観点の分類（性能 / 負荷 / 可用性・レジリエンス / コスト）

| 観点 | 問い | ケースID 接頭辞 | 主ツール |
|---|---|---|---|
| 性能 | 単一/低負荷でレイテンシ閾値を満たすか | `PERF-` | k6 / autocannon / Lighthouse / Cloud Trace |
| 負荷 | 現実規模の同時負荷でも閾値を維持するか | `LOAD-` | k6（VU ramp / スパイク / soak） |
| 可用性・レジリエンス | 障害注入時にフェイルセーフ・degrade するか | `RESIL-` | 障害注入（接続断/タイムアウト注入）+ Cloud Monitoring |
| コスト | 負荷時の課金が想定内・暴走しないか | `COST-` | GCP Billing Export → BigQuery / Cloud Monitoring |

---

## 4. 性能ケース設計

NFR01 の 5 閾値を**個別ケース化**。すべて Cloud Run cold start を除いた warm 状態（min-instances=1 起動済）で測定。

| ケースID | 対象 | 閾値（合格） | 測定方法 | トレース元 |
|---|---|---|---|---|
| **PERF-001** | API レイテンシ（代表 Server Action / Route Handler、例: スケジュール更新・一覧取得） | **p95 < 500ms**（cold start 除く） | k6 で warm 後 ~50 req/s を 2 分、p95 を集計。Cloud Trace で内訳（DB/外部呼）確認 | NFR01「API p95 < 500ms」 |
| **PERF-002** | AI ストリーミング初回トークン（F03 構造化 / F06 生徒対話） | **TTFT < 2 秒** | k6 + SSE 計測（リクエスト送信→最初の token chunk 受信までの実測）。PII マスキング往復込み | NFR01「AI 初回トークン < 2 秒」 |
| **PERF-003** | サイネージ画面ロード（firmware 表示、CDN 経由） | **< 1.5 秒**（LCP 相当） | Lighthouse（モバイル/低速プロファイル）+ 実機ブラウザで CDN ヒット時の load。CDN cold/miss は別途記録 | NFR01「サイネージロード < 1.5 秒」 |
| **PERF-004** | DB クエリ（RLS 込みの代表クエリ: テナントスコープ select / join） | **p95 < 100ms** | `__tests__/perf/` の pg ベンチ + Cloud SQL Insights / `pg_stat_statements` で p95。`SET app.current_school_id` 設定済セッションで測定 | NFR01「DB クエリ p95 < 100ms（RLS 込み）」 |
| **PERF-005** | 公開 → サイネージ反映（教員公開操作 → firmware 画面に反映） | **最大 60 秒以内** | e2e 計時: 公開 API 成功時刻 → firmware ポーリングで新データ取得・描画した時刻の差分。CDN キャッシュ TTL 込み | NFR01「公開反映 最大 60 秒」 |

> PERF-001/002 は §5 の負荷プロファイル下でも閾値維持を確認する（負荷時 = LOAD ケースで再測）。

---

## 5. 負荷プロファイル設計

すべて k6 で記述、staging に対し合成データで実行。各プロファイルは
「教員編集（書込）」「生徒 magic-link 閲覧 + AI 質問」「firmware ポーリング（読込）」の混合シナリオ。

| プロファイル | ケースID | 規模・形状 | 持続 | 合格条件 |
|---|---|---|---|---|
| **通常負荷** | **LOAD-001** | PoC 現実規模: 教員 5 VU 書込、生徒 30 VU 閲覧/質問、firmware 3 端末 30 秒間隔ポーリング | 5 分 | PERF-001/002/004 閾値を維持、エラー率 < 0.5%、429 が AI 質問 rate limit 以外で出ない |
| **ピーク負荷** | **LOAD-002** | 将来上限（約 10×）: 教員 30、生徒 360、firmware 30 端末 | 5 分 | p95 劣化が閾値の **+20% 以内**（API < 600ms、TTFT < 2.4s）、エラー率 < 1%、min-instances 効果で cold start 起因の外れ値が支配的でない |
| **スパイク（朝の一斉アクセス）** | **LOAD-003** | 0 → ピーク到達を **30 秒で急増**（朝 HR 前後に生徒/firmware が一斉接続）。到達後 2 分維持 | ~3 分 | スパイク立ち上がりで 5xx を出さない（rate limit 429 は許容、ただし正常閲覧トラフィックは 200）、Cloud Run のオートスケールが追従、回復後 1 分以内に p95 が定常へ復帰 |
| **soak（持続）** | **LOAD-004** | 通常負荷を**長時間**維持（運用 1 日 7:00-19:00 を圧縮した 30〜60 分） | 30〜60 分 | メモリ/コネクションリーク無し（Cloud Monitoring でメモリ右肩上がりなし、DB コネクション枯渇なし）、p95 がドリフトしない、エラー率が時間で増加しない |

実行ノート:
- k6 シナリオは `__tests__/perf/k6/` 配下に置く（プロファイルごとに 1 ファイル + 共通ヘルパ）。
- AI 質問 VU は rate limit（magic_link あたり 1 分 10 質問）に整合させ、**意図的な 429 と障害由来 429 を区別**してメトリクス化。
- 各 LOAD 実行と並行して Cloud Trace を有効化し、ボトルネック（DB / Vertex AI / CDN）を内訳で特定できるようにする。

---

## 6. 可用性・レジリエンステスト

障害注入は **staging のみ**。アプリ/インフラの degrade 設計（NFR02 のフェイルセーフ条項）が実際に働くかを検証する。

| ケースID | 障害シナリオ | 注入方法（staging） | 期待挙動（合格条件） | トレース元 |
|---|---|---|---|---|
| **RESIL-001** | Cloud Run cold start | min-instances=0 に一時設定 or 長時間無アクセス後の初回リクエスト | cold start レイテンシを実測・記録。**critical path は min-instances=1 で cold start を回避**できていることを対照で確認（warm 経路に cold 由来の外れ値が出ない） | NFR01 / NFR02「全クリティカルパスに min-instances=1」 |
| **RESIL-002** | DB 接続断 / failover | Cloud SQL の手動 failover トリガ（HA regional）or 接続プール強制切断 | failover 中の書込はエラーでも、**自動 failover 後に復旧**。接続プールが再接続し、データ不整合なし。エラー時はユーザーに 5xx を垂れ流さず再試行/明示エラー | NFR02「Cloud SQL HA, automatic failover」 |
| **RESIL-003** | Vertex AI タイムアウト / 失敗 | Vertex 呼び出しに人工遅延 or エラー注入（モック/プロキシ層） | AI 機能（F03/F06）は**タイムアウトでハングせず**、明示エラー or graceful degrade（質問はエラー表示、構造化はリトライ/手動フォールバック）。**サイネージ表示・教員の非 AI 機能は無影響** | NFR02 / NFR01（degrade 境界） |
| **RESIL-004** | API 全断時のサイネージ表示継続 | staging API を停止 / firmware から到達不能化 | **CDN キャッシュで最大 60 秒は表示継続**、かつ **firmware が localStorage の直近 1 日分でフォールバック表示**を継続。画面が白画面/エラーにならない | NFR02「CDN 60 秒継続」「firmware localStorage キャッシュ」 |
| **RESIL-005** | 部分障害時の degrade（依存単位） | AI のみ断 / DB read-replica のみ断 等、依存を個別に落とす | 1 依存の障害が**全機能停止に波及しない**（bulkhead）。健全な機能は閾値内で稼働継続、障害機能のみ degrade | NFR02（クリティカルパス分離） |

> RESIL-001〜005 は test-strategy.md が想定する `__tests__/chaos/` の chaos engineering に対応。注入は可逆な手段に限定し、実行後に staging を元構成へ戻すことをチェックリスト化する。

---

## 7. コスト検証

NFR06 は**コスト天井を意図的に設けない**方針。したがって本トラックは「上限超過の合否」ではなく、
**負荷量に対する課金が線形・想定内で、暴走（指数的・想定外スパイク）していないか**のコスト回帰として扱う。

| ケースID | 対象 | 観点（合格条件） | 測定方法 | トレース元 |
|---|---|---|---|---|
| **COST-001** | 負荷時の Cloud Run / Cloud SQL / Vertex AI 課金の線形性 | LOAD-001（通常）と LOAD-002（ピーク 約10×）で、**課金が負荷量にほぼ比例**（桁外れの非線形増加がない）。Vertex AI トークン課金が質問数 × Pro 単価の想定内 | GCP Billing Export → BigQuery で実行前後の日次コスト差分、school_id 別集計（NFR06 の集計機構を流用） | NFR06「コスト可視化」「school_id 別集計」 |
| **COST-002** | rate limit のコスト抑止効果 | rate limit 超過分が **429 で確実に遮断**され、超過リクエストが Vertex AI 課金に到達しない（不正/暴走時の課金天井として機能） | LOAD-003 スパイク中に rate limit 超過を意図的に発生させ、Vertex 呼び出し回数 ≤ rate limit 許容回数であることを Cloud Monitoring で確認 | NFR06「不正抑止 rate limit」 |
| **COST-003** | min-instances の常時課金が想定内 | min-instances=1（critical path のみ）の**アイドル課金**が、無負荷時間帯でも想定単価内で、対象が critical path に限定されている（全サービス常時起動になっていない） | Cloud Monitoring の instance count 時系列 + Billing で min-instance 起因コストを切り分け | NFR01/NFR02 / ADR-002 |

> 本トラックの COST は「設計が課金暴走を構造的に防いでいるか」の確認であり、**月次予算判断は人間/導入フェーズの責務**（§11）。

---

## 8. 合否基準

### 閾値表（Exit に必要な合格ライン）

| 観点 | 合格ライン | p95 超過/未達の扱い |
|---|---|---|
| 性能（PERF-001〜005） | 全 5 ケースが §4 の閾値を **warm 状態で達成** | 1 件でも閾値超過 → 欠陥として defect-log へ。原因（DB/AI/CDN/コード）を Cloud Trace で特定し、修正 PR → Reviewer → 再測。再測で閾値内なら合格、構造的に未達なら no-go 候補として人間へエスカレーション |
| 負荷（LOAD-001〜004） | 通常負荷で性能閾値維持 / ピークで劣化 +20% 以内 / スパイクで 5xx なし / soak でリーク・ドリフトなし | ピーク劣化が +20% 超 or soak でリーク検出 → 欠陥。スパイク 5xx は**ブロッキング**（朝の一斉アクセスは必達運用シナリオ） |
| 可用性（RESIL-001〜005） | 全シナリオで期待 degrade/フェイルセーフが成立、白画面・ハング・全断波及がない | フェイルセーフ不成立（特に RESIL-003 ハング / RESIL-004 サイネージ白画面）は**ブロッキング** |
| コスト（COST-001〜003） | 課金が負荷量に対し線形、rate limit 遮断有効、min-instance 課金が限定的 | 非線形な課金暴走 or rate limit がコスト遮断にならない → 欠陥。設計反映が要る場合は no-go 候補 |

### Exit 合格条件（go/no-go 集約用）

- **PERF-001〜005 の 5 性能閾値が staging warm 状態で全て達成**（API p95 < 500ms / AI TTFT < 2s / サイネージ < 1.5s / DB p95 < 100ms / 公開反映 ≤ 60s）。
- **負荷プロファイル 4 種を完走**し、通常負荷で閾値維持・ピーク劣化 +20% 以内・**スパイクで 5xx ゼロ**・soak でリーク/ドリフトなし。
- **レジリエンス 5 シナリオでフェイルセーフ/degrade が成立**（ハング・サイネージ白画面・障害の全断波及がいずれも発生しない）。
- **コスト回帰で課金が負荷量に対し線形**かつ rate limit によるコスト遮断が有効。
- 上記いずれかの**ブロッキング項目（スパイク 5xx / RESIL ハング / サイネージ白画面）が未解決の場合は no-go** とし、人間へエスカレーション。

---

## 9. 手法・ツール

| 用途 | ツール | 配置 / 備考 |
|---|---|---|
| HTTP 負荷・スパイク・soak | **k6**（VU ramp / scenarios / thresholds 機能） | `__tests__/perf/k6/`。k6 の `thresholds` に §8 合格ラインを記述し pass/fail を機械判定 |
| 軽量レイテンシ計測（単一エンドポイント） | **autocannon** | PERF-001 の補助・ローカル素早い確認用 |
| 分散トレース（ボトルネック内訳） | **Cloud Trace** | 各 PERF/LOAD 実行と紐付け、DB/Vertex/CDN の内訳特定（ADR-014） |
| SLO/メトリクス・リソース監視 | **Cloud Monitoring** | instance count / メモリ / DB コネクション / エラー率 / Vertex 呼出数。soak のリーク検知とコスト切り分け |
| サイネージ画面ロード（フロント性能） | **Lighthouse**（モバイル/低速プロファイル）+ 実機ブラウザ | PERF-003。CDN ヒット/ミスを区別して記録 |
| DB クエリ p95 | **pg ベンチ + Cloud SQL Insights / pg_stat_statements** | PERF-004。RLS セッション変数設定済で測定 |
| コスト集計 | **GCP Billing Export → BigQuery** | NFR06 のコスト可視化機構を流用、school_id 別差分 |

実行体制: test-strategy.md §6 に従い、本トラックは Worker/Agent spawn で実行、検出欠陥は defect-log へ → 修正 PR → **Reviewer 別 spawn** → 再検証で閉じる。

---

## 10. トレーサビリティ

本トラックのケース ↔ NFR の対応（**横断行列は [traceability-matrix.md](../traceability-matrix.md) に集約**。本表はトラック内の局所ビュー）。

| ケースID | トレース元 NFR | 受け入れ条件（NFR 側） |
|---|---|---|
| PERF-001 | NFR01 | API p95 < 500ms |
| PERF-002 | NFR01 | AI 初回トークン < 2 秒 |
| PERF-003 | NFR01 | サイネージロード < 1.5 秒 |
| PERF-004 | NFR01 | DB クエリ p95 < 100ms（RLS 込み） |
| PERF-005 | NFR01 | 公開反映 最大 60 秒 |
| LOAD-001〜004 | NFR01 | 負荷時の性能閾値維持（同時接続・スパイク・soak） |
| RESIL-001 | NFR01 / NFR02 | min-instances=1 で cold start 回避 |
| RESIL-002 | NFR02 | Cloud SQL HA automatic failover |
| RESIL-003 | NFR01 / NFR02 | AI タイムアウト時の degrade |
| RESIL-004 | NFR02 | CDN 60 秒継続 + firmware localStorage キャッシュ |
| RESIL-005 | NFR02 | 部分障害の非波及（クリティカルパス分離） |
| COST-001〜003 | NFR06 | コスト可視化 / rate limit 不正抑止 / school_id 別集計 |

---

## 11. Claude / 人間の境界

| 区分 | 内容 |
|---|---|
| **Claude 主導** | staging に対する性能/負荷/レジリエンス/コスト回帰の自動化、k6 シナリオ・障害注入の実装、Cloud Trace/Monitoring による測定、検出欠陥の修正 PR → Reviewer → 再検証ループ。 |
| **人間 / 導入フェーズに残す** | ① **本番インフラへの負荷試験**（実トラフィック規模・本番課金）、② **SLA 99.5% の最終 go/no-go 判断**と本番 SLO アラート閾値の確定、③ **月次コスト予算の事業判断**（NFR06 は天井を設けない方針のため、判断は事業側）、④ 岐南工業フィールドでの実機・実回線での体感性能確認。 |

> 本トラックの Exit レポートは「staging 合成負荷では閾値達成」を示すに留まる。**本番規模での最終確認は人間が導入フェーズで実施**（test-strategy.md §4 と整合）。

---

## 12. 未決事項

- **代表エンドポイントの確定**: PERF-001 / LOAD の「代表 API」を具体的な Server Action / Route Handler 名で固定する（機能トラック①のシナリオ確定後に紐付け）。
- **障害注入の具体手段**: RESIL-002（Cloud SQL failover トリガ）/ RESIL-003（Vertex エラー注入をモック層かプロキシ層か）の実装方式を staging 構成に合わせて確定。
- **k6 と CI の統合**: 負荷試験を CI に常設するか（コスト/実行時間）、Phase 検証時のみ手動/オンデマンド実行とするかを決定。
- **CDN 構成の確定**: PERF-003 / RESIL-004 が前提とする CDN（Cloud CDN 想定）の TTL・キャッシュキー設計が staging で確定しているか確認。
- **soak 時間の確定**: LOAD-004 の圧縮時間（30 分 / 60 分）を staging のコスト許容と検出力のトレードオフで決定。
- **コスト線形性の判定基準**: COST-001 の「非線形 = 暴走」を定量化する閾値（例: 負荷 10× で課金 15× 超を異常とする等）を Billing データの実測後に確定。
