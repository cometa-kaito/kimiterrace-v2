# Phase 検証 トラック⑤: 移行・監査・コンプライアンス検証 — 詳細設計

> 親: [docs/testing/test-strategy.md](../test-strategy.md)
> トレース元: [NFR04-audit-log](../../requirements/non-functional/NFR04-audit-log.md) / [NFR07-compliance](../../requirements/non-functional/NFR07-compliance.md)
> 関連: [CLAUDE.md ルール1（監査カラム）/ ルール2（RLS）/ ルール4（PII マスキング）](../../../CLAUDE.md) / [docs/runbooks/cutover.md](../../runbooks/cutover.md)（切替）/ [docs/compliance/](../../compliance/)

最終更新: 2026-05-31
ステータス: **詳細設計ドラフト**（個別ケースは代表＋チェックリスト雛形。横断行列は [traceability-matrix.md](../traceability-matrix.md) に集約予定）

---

## 1. 目的とスコープ（in / out）

統合された **staging** 上で、(A) Firestore→PostgreSQL データ移行が正当か、(B) あらゆる変更が `audit_log` に網羅的・改竄不能に記録されるか、(C) 文科省GL / ISMAP / 個人情報保護法のコンプラ要件が証跡を伴って消化されているか、を受入ゲート化する。「移行スクリプトの単体が正しい」（shift-left の transform.test で済）ではなく「**統合された staging で移行・監査・コンプラが要件を満たす**」を判定する。

### In（このトラックが見る）

- **データ移行検証**: 合成 V1 エクスポート → V2 への dry-run で、件数突合 / 参照整合（FK）/ 文字化け・型変換 / 冪等性（再実行で重複ゼロ）/ 欠損ゼロ / 移行後の RLS が効くこと。
- **監査ログ網羅性**: insert/update/delete のあらゆる mutation が同一 tx で `audit_log` に記録されるか、append-only が物理的に効くか、ハッシュチェーン検証 `audit_log_verify_chain()` が通るか、AI 呼び出し（`ai_extractions` / `ai_chat_messages`）が全件記録されるか。
- **コンプライアンス**: 10 年保管（ホット 1 年 + コールド 9 年）/ 委託先（Google・Vertex AI）の扱い / PII 最小化 / 開示・訂正・削除対応 / データ越境回避（asia-northeast1 固定 + Vertex opt-out）の **チェックリスト消化**（証跡 or 人間タスク化）。

### Out（他トラック・他フェーズに委譲）

- 監査ログの **生成側ハンドラの正常系機能**（公開で audit が出るか等）→ 機能としての通しは **トラック①**（FUN-001/006/018 等）。本トラックは「**あらゆる mutation を漏れなく**」という網羅性・改竄不能性に集中。
- 監査基盤への **敵対的攻撃**（actor 詐称・チェーン破壊の攻め）の網羅 → **トラック③ セキュリティ**（本トラックは既存 `audit-log-actor-spoofing.test.ts` の結果を**証跡として参照**するに留め、新規の攻めは③へ渡す）。
- PII マスキングの **単体検証** → 既存 `packages/ai/src/__tests__/`。本トラックは「AI 呼び出しが**全件記録**されているか」の網羅側のみ見る。
- **本番 Firestore からの実移行・実データでの突合** → 導入フェーズ（人間、[§7](#7-claude--人間の境界)）。
- **最終的な法務・コンプラ判断、委託先契約（DPA）の締結、規程・保険** → 人間 / 導入フェーズ（[§7](#7-claude--人間の境界)）。Claude は initial draft とチェックリスト消化の証跡収集まで。

---

## 2. 前提・環境（合成移行データでの dry-run、本番移行は人間）

- **環境は staging 限定・合成データのみ**（test-strategy.md §2 / CLAUDE.md セキュリティ最優先）。**実 Firestore 本番データでの移行試験は禁止**。Claude は「合成 Firestore エクスポート相当 JSON」で dry-run 検証を設計・実行する。
- **入力契約**: 移行ジョブは [apps/jobs/src/migration/types.ts](../../../apps/jobs/src/migration/types.ts) の `V1Export`（整形済み正規化 JSON）を入力に取る。Firestore 生エクスポート → この形への取り出しは前段スクリプトの責務で、本ジョブは「整形済み JSON → PostgreSQL の冪等インポート」に専念する。合成エクスポートはこの契約に**意図的なエッジ**（マルチバイト / 絵文字 / NULL / 省略フィールド / 2 校以上 / 同一データの再投入分）を仕込んだ固定 fixture とする（[§5](#5-手法ツール)）。
- **接続ロール**: 移行ジョブは **migrator（BYPASSRLS）** で接続する（全テナント横断書込のためで、ルール2 の唯一の許容例外。[import.ts](../../../apps/jobs/src/migration/import.ts) のドキュメント）。**移行後の検証クエリ（突合・RLS 確認）は非 BYPASSRLS（`kimiterrace_app`）で実行**し、移行されたデータに対し RLS が実際に効くことを確認する。
- **dry-run の定義（本トラック）**: staging の隔離スキーマ or 使い捨て staging DB に対し、合成エクスポートを投入して突合する一連を「dry-run」と呼ぶ。ROADMAP の「dry-run 3 回」は導入直前の本番移行リハーサル（人間）を指し、本トラックの合成 dry-run はその**前段の機能・整合検証**（[§7](#7-claude--人間の境界)）。
- **監査・コンプラ検証の母体**: 監査検証は staging の実構成（`0003_audit_trigger.sql` 等の append-only / hash chain トリガが有効）に対して実施。コンプラは [docs/compliance/](../../compliance/) と staging の実設定（リージョン・Vertex opt-out）を証跡源にする。

---

## 3-A. データ移行検証（MIG-NNN）

合成エクスポートを staging へ dry-run 投入し、**検証内容 → 合格条件 → トレース元**で示す。突合は移行後の SQL クエリ（件数・FK・値）で機械判定する。

| ID | 検証内容 | 合格条件 | トレース元 |
|---|---|---|---|
| **MIG-001** | **件数突合**: 合成エクスポートの各エンティティ件数（schools / departments / grades / classes / school_configs / daily_data / ads）と、移行後 V2 各テーブルの行数を突き合わせる | エクスポート上の論理件数と V2 行数が**全エンティティで一致**（欠損ゼロ・余剰ゼロ）。`ImportSummary` の試行件数と実 SELECT COUNT が整合 | NFR04（監査カラム前提）/ ルール1 |
| **MIG-002** | **参照整合（FK）**: 移行後の階層リンク（`grades.department_id` / `classes.grade_id` / 全子テーブルの `school_id`、scope 行の `*_id`）が有効な親を指す | dangling FK ゼロ（孤児行なし）。`grade.department_id` / `class.grade_id` が決定論 UUID で正しい親に結線（transform.test の結線規約を実 DB で再確認） | NFR04 |
| **MIG-003** | **型変換・文字化け**: マルチバイト（日本語校名・学科名）/ 絵文字 / 記号 / 長文 caption / 数値（`durationSec` / `captionFontScale` / `displayOrder`）/ JSONB（`school_configs.value`・`daily_data.schedules/notices`）が正しく変換される | UTF-8 が mojibake なく保持、数値が型どおり、JSONB が構造保持。省略フィールドの既定値（`prefecture="不明"` / `durationSec=5` / `captionFontScale=1` / `displayOrder=index`）が仕様どおり | NFR04 |
| **MIG-004** | **冪等性（再投入で重複ゼロ）**: 同一エクスポートを **2 回以上**連続投入する | 2 回目以降は `onConflictDoNothing` で全件スキップ、行数・id が 1 回目と完全一致（決定論 UUID v8 ＋ 移行マーカーも重複しない）。差分ゼロ | [import.ts](../../../apps/jobs/src/migration/import.ts) 冪等性 / [ids.ts](../../../apps/jobs/src/migration/ids.ts) |
| **MIG-005** | **クラッシュ後 resume**: 投入を途中で中断（部分挿入状態）させ、同一エクスポートで再開する | 中断後の再実行で残りが挿入され、既挿入分は重複せず、最終状態が無中断時と同一（resume 安全性。トランザクション境界と冪等の合わせ技） | [import.ts](../../../apps/jobs/src/migration/import.ts) |
| **MIG-006** | **移行後 RLS**: 移行で投入した 2 校以上のデータに対し、**非 BYPASSRLS（`kimiterrace_app`）**で `SET app.current_school_id` を片校に設定して横断 SELECT する | 自校行のみ返り、別校行は 0 件（移行データにもテナント分離が効く）。RLS 無効化されたまま移行されていない（ルール2） | NFR04 / ルール2 |
| **MIG-007** | **移行マーカー監査**: 学校ごとに `audit_log` へ移行マーカー（`operation=insert` / `table_name=schools` / `diff` に `{migration:"firestore-to-pg"}`）が 1 行記録される | 学校数ぶんのマーカー行が存在、`created_by/updated_by=NULL`（システム移行）、`prev_hash/row_hash` がトリガで計算済（client placeholder が上書きされている） | NFR04 / ルール1 |
| **MIG-008** | **欠損・取りこぼし検知 + スコープ網羅監査**: (a) 合成エクスポートに「全 scope（school/department/grade/class）」「クラスを持たない学年（`hasClasses=false`）」「空配列フィールド」を仕込み各 scope の ads/configs/daily_data が落ちないこと、(b) **移行対象コレクション自体の網羅性**を [v1-v2-mapping.md](../../architecture/v1-v2-mapping.md) と突合（設計レビュー） | (a) 各 scope の子データが scope 列正しく（CHECK 制約整合）移行され `hasClasses=false` 学年・空配列も欠損なく反映、silent drop ゼロ。(b) **v1-v2-mapping.md に列挙された全コレクションが移行対象に含まれる**（実装の行レベル突合では拾えない『対象外コレクション漏れ』はこのマッピング監査で担保 = 「欠損ゼロ」ゲートの二重化） | NFR04 |

> 推奨: MIG 6〜8 ケース（上記で 8）。MIG-001/002/004/006 は移行の中核（欠損・整合・冪等・テナント分離）で必須 pass。

---

## 3-B. 監査ログ網羅性検証（AUD-NNN）

「個別ハンドラで audit が出る」は機能トラック①の責務。ここは **あらゆる mutation を漏れなく・改竄不能に**を網羅側で確認する。既存 RLS スイート（`audit-log-*.test.ts`）の結果を**証跡として引き、統合 staging で再確認 + 網羅カバレッジを足す**。

| ID | 検証内容 | 合格条件 | トレース元 |
|---|---|---|---|
| **AUD-001** | **全 mutation 記録（網羅カバレッジ）**: 監査対象テーブル（`AUDITED_TABLES`: users / classes / memberships / magic_links / contents / content_versions / publishes / events / ai_* / monthly_reports / schools / advertisers / contracts / communications / system_admins / audit_log）で代表 insert/update/delete を staging 経由で発生させ、各操作が `audit_log` に対応行を生む | 監査対象テーブルの insert/update/delete が**全テーブル × 全 operation で `audit_log` に記録**される。記録漏れ（mutation あって audit なし）ゼロ。網羅は table_name × operation のカバレッジ表で可視化 | NFR04 / ルール1 |
| **AUD-002** | **同一トランザクション性**: 業務 mutation と audit 記録が同一 tx。業務側 mutation を意図的にロールバックさせる | mutation が rollback されたとき audit 行も残らない（業務行だけ消えて audit が残る／audit だけ残るの**乖離ゼロ**）。部分コミットによる監査と実体の不整合がない | NFR04 |
| **AUD-003** | **append-only（物理強制）**: `audit_log` に対し UPDATE / DELETE / TRUNCATE を試行（**BYPASSRLS スーパーユーザーでも**） | すべて BEFORE トリガで拒否（`/append-only|insufficient_privilege/`）。INSERT のみ成功。`audit-log-append-only.test.ts` の結果を staging 実構成で再確認 | NFR04「append-only」/ ルール1 |
| **AUD-004** | **ハッシュチェーン整合**: N 行 INSERT 後に `audit_log_verify_chain()` を実行。先頭 `prev_hash=NULL`、後続が直前 `row_hash` を引き継ぐ | verify が**空配列（=整合）**を返す。`row_hash` は 64 hex、連続行で重複しない。`audit-log-hash-chain.test.ts` を staging で再確認 | NFR04「日次 hash chain」 |
| **AUD-005** | **改竄検知**: トリガ DISABLE → 行改竄 → ENABLE（superuser のみ可能な攻撃を模擬）後に verify を実行 | verify が**不整合を検出**（改竄行 + 以降の prev_hash 不一致行が `broken_id` に出る）。改竄が必ず検知に至る。検知時に Sentry 通知 + system_admin メールの配線が存在することを確認（NFR04 改竄検知条項） | NFR04「検知時は Sentry + メール」 |
| **AUD-006** | **client 値の上書き（入力改竄対策）**: INSERT 時に `prev_hash` / `row_hash` / `actor_user_id` に偽値を渡す | トリガ／WITH CHECK がハッシュを再計算で上書きし、actor 詐称（自分以外の uuid / テナント内ロールの NULL）を拒否。`audit-log-actor-spoofing.test.ts` の結果を参照（攻めの網羅は③へ） | NFR04 / ルール1 |
| **AUD-007** | **AI 全件記録**: F03 構造化・F06 生徒 Q&A を staging で実行し、`ai_extractions` / `ai_chat_sessions` / `ai_chat_messages` に全件記録されるか。プロンプト・応答・トークン数・確信度・session_id が残るか | AI 呼び出し回数と AI テーブル行数が一致（**書き漏れ＝ルール4 破壊 → 即 fail**）。記録は PII マスキング後テキストで、生 PII がプロンプト/応答ログに残らない（マスキング往復の証跡） | NFR04「AI 利用は全件保管」/ ルール4 |
| **AUD-008** | **監査受入抽出**: 「誰がどのデータにアクセス/変更したか」を `school_id × user_id × 期間` で `audit_log` から抽出できるか（教育委員会監査要求の想定） | 指定 school × user × 期間で操作履歴を抽出するクエリが成立し、結果がテナント分離（別校混入なし）。抽出が NFR07「監査受入」の要件を満たす | NFR07「監査受入」/ NFR04 |

> 推奨: AUD 5〜8 ケース（上記で 8）。AUD-001（記録漏れゼロ）/ AUD-004（チェーン pass）/ AUD-007（AI 全件）は必須 pass。

---

## 3-C. コンプライアンス検証（CMP-NNN チェックリスト雛形）

NFR07 の受け入れ条件を **チェックリスト化**し、各項目を「証跡（staging 設定 / docs / クエリ結果）で消化」または「人間タスク化（導入フェーズ・法務）」のいずれかに必ず帰着させる。Claude は **証跡収集 + initial draft** まで。最終法務判断は人間。

| ID | チェック項目 | 証跡 / 判定方法 | 帰着区分 | トレース元 |
|---|---|---|---|---|
| **CMP-001** | 個情法: 生徒データ 10 年保管要件を満たす（ホット 1 年 + コールド 9 年） | retention 設計（NFR04）と移送バッチ・Cloud Storage Archive 設定の存在を staging/IaC で確認 | Claude 証跡 + 人間（保管方針最終承認） | NFR07「個情法 10 年保管」/ NFR04 |
| **CMP-002** | 10 年保管の**移送実装**: 1 年経過分のコールド移送バッチ、移送後 1 時間以内取得可 | 移送 Job の存在・dry-run 動作、移送後の取得経路を staging で確認（実データ移送は本番運用） | Claude 証跡（合成）+ 人間（本番運用） | NFR04「日次バッチ移送」 |
| **CMP-003** | データ越境回避: 全 GCP リソースが asia-northeast1 固定 | Terraform / staging リソースのリージョン設定を確認（`infrastructure/terraform/`） | Claude 証跡 | NFR07「asia-northeast1 固定」/ ルール8 |
| **CMP-004** | Vertex AI も asia-northeast1、**data usage opt-out** 設定済 | Vertex 呼び出しのリージョン + opt-out 設定（ADR-005）を staging 設定で確認 | Claude 証跡 + 人間（契約面確認） | NFR07 / ADR-005 |
| **CMP-005** | PII 最小化: LLM 送信前マスキング・embedding はマスク後テキスト | AUD-007 の証跡（生 PII がプロンプト/応答/embedding に残らない）+ 既存 `packages/ai` マスキングテスト参照 | Claude 証跡 | NFR07 / ルール4 |
| **CMP-006** | PII 最小化（計測）: events の client_id は cookie UUID のみ、生徒個人特定情報を持たない | events スキーマ・記録内容を staging で確認（PII 列なし） | Claude 証跡 | ルール4 / NFR07 |
| **CMP-007** | 委託先（Google）DPA 確認・締結 | docs/compliance/ の委託先管理表に GCP DPA の状態を記録（締結は契約行為） | **人間 / 導入フェーズ** | NFR07「GCP DPA」 |
| **CMP-008** | 委託先管理表の維持・サブプロセッサ変更通知フロー | docs/compliance/ に管理表 + 通知フロー定義の存在を確認（draft は Claude） | Claude draft + 人間（運用） | NFR07「委託先管理」 |
| **CMP-009** | 文科省「教育情報セキュリティポリシーGL」準拠の管理策文書化 | docs/compliance/ に GL 対応表（自社運用部分の管理策）が存在し、本トラックの監査/RLS/暗号化証跡と紐づく | Claude draft + 人間（最終判断） | NFR07「文科省GL」 |
| **CMP-010** | ISMAP 相当: GCP は Google が ISMAP 取得済、自社運用部分の管理策を文書化 | docs/compliance/ に自社管理策の文書、Google 側取得状況の記録 | Claude draft + 人間（正式認証は外部） | NFR07「ISMAP 相当」 |
| **CMP-011** | 監査受入: audit_log / 設計書を教育委員会監査に提供可能な状態 | AUD-008 の抽出クエリ成立 + 設計書（本 docs 群）の整備 | Claude 証跡 | NFR07「監査受入」/ AUD-008 |
| **CMP-012** | 開示・訂正・削除（本人/保護者請求）対応の経路 | 開示=AUD-008 抽出、訂正=audit を伴う更新経路、削除=保管義務との整合（10 年保管中の削除可否）を draft 整理 | Claude draft + **人間（法務判断: 保管義務 vs 削除請求の優先）** | NFR07 / 個情法 |
| **CMP-013** | GDPR / CCPA は対象外（国内サービス、EU/US 居住者データを扱わない）方針の明文化 | docs/compliance/ に対象外方針と根拠を記録 | Claude draft + 人間（方針承認） | NFR07「GDPR/CCPA 対象外」 |
| **CMP-014** | 規程・契約・保険（個人情報取扱規程 / プライバシーポリシー / SaaS 契約 / サイバー保険） | NFR07 が「Phase 導入で人間が確定」と明記する項目。本トラックはチェックリストに「人間タスク」として登録 | **人間 / 導入フェーズ** | NFR07「規程・契約」 |
| **CMP-015** | 漏洩時の追跡可能性（誰がどこまで見たか）: 監査 + ハッシュチェーンで立証可能 | AUD-003〜005 + AUD-008 の証跡が揃い、改竄検知込みで立証経路が成立 | Claude 証跡 | NFR04 概要 / NFR07 |

> 推奨: CMP 10〜15 項目（上記で 15）。各項目は**必ず「証跡で消化」か「人間タスク化」のいずれかに帰着**させ、宙ぶらりんを残さない。

---

## 4. 合否基準

### ケース単位

- **pass**: 検証内容が staging 上で再現し、合格条件を満たす（移行: 突合一致 / 監査: 記録・チェーン成立 / コンプラ: 証跡 or 人間タスク化に帰着）。
- **fail**: 突合不一致・記録漏れ・チェーン破綻・コンプラ項目が宙ぶらり（証跡も人間タスク化もされていない）。

### 観点単位（ブロッキング判定）

| 観点 | 合格ライン | ブロッキング（no-go 直結） |
|---|---|---|
| 移行（MIG-001〜008） | **欠損 0 / 重複 0 / FK 整合 100% / 冪等性成立 / 移行後 RLS 有効** | MIG-001 欠損あり / MIG-004 再投入で重複 / MIG-006 別校混入は**ブロッキング**（移行の信頼性 = 切替可否の根幹） |
| 監査（AUD-001〜008） | **記録漏れ 0 / append-only 物理強制 / `audit_log_verify_chain()` pass / AI 全件記録** | AUD-001 記録漏れ / AUD-003 append-only 破れ / AUD-004 チェーン不整合 / AUD-007 AI 書き漏れ（ルール4 破壊）は**ブロッキング** |
| コンプラ（CMP-001〜015） | **全項目が証跡で消化 or 人間タスクとして明示登録**（宙ぶらりゼロ） | 証跡も人間タスク化もされず未追跡の項目が残る場合はゲート未達（項目自体の「人間タスク」帰着は no-go ではない） |

### Exit 合格条件（go/no-go 集約用）

1. **移行ゲート**: 合成 dry-run で MIG-001〜008 が全 pass — **欠損 0 / 重複 0 / FK 整合 100% / 冪等性（再投入で差分 0）/ 移行後の RLS テナント分離が有効**。
2. **監査ゲート**: AUD-001〜008 が全 pass — **mutation 記録漏れ 0 / append-only が BYPASSRLS でも物理強制 / `audit_log_verify_chain()` が整合（空配列）/ AI 呼び出し全件記録（書き漏れ 0 = ルール4 維持）**。
3. **コンプラゲート**: CMP-001〜015 が全項目「証跡で消化」または「人間/導入フェーズタスクとして明示登録」に帰着し、**未追跡（宙ぶらり）ゼロ**。最終法務・契約判断（DPA / 規程 / 保険）は人間タスクとして go/no-go レポートに引き継ぐ。
4. 残存欠陥は [defect-log.md](../defect-log.md) で追跡され、未修正分・人間タスク分は go/no-go レポートに明記済み（隠さない）。

---

## 5. 手法・ツール

- **移行 dry-run 突合**: 合成 `V1Export` fixture（[transform.test.ts](../../../apps/jobs/src/migration/__tests__/transform.test.ts) の fixture を母体に、2 校以上 / マルチバイト・絵文字 / 全 scope / `hasClasses=false` / 空配列 / 再投入分を拡張）を、staging の使い捨て DB に migrator ロールで投入。突合は SQL（COUNT 突合・FK 孤児検出・値比較）と `ImportSummary` の照合で機械判定。冪等性は同一 fixture を 2 回投入し全 id 一致を確認。新規 migration を足したら `__tests__/_setup/global-setup.ts` の loader 配列にも登録（migration-loader-pattern 厳守）。
- **移行後 RLS 確認**: 投入後に**非 BYPASSRLS（`kimiterrace_app`）**で `SET app.current_school_id` を設定して横断 SELECT し、別校 0 件を確認（RLS スイートの接続方式を踏襲）。
- **audit_log 集計クエリ**: (1) mutation 網羅カバレッジ表（`table_name × operation` のヒートマップを `audit_log` 集計で生成、未カバー table/operation を可視化）、(2) `audit_log_verify_chain()`、(3) 監査受入抽出（`school_id × actor_user_id × occurred_at 範囲`）、(4) AI 呼び出し数 vs `ai_*` 行数の突合。既存 `audit-log-*.test.ts` を staging 実構成での再確認に流用。
- **AI 全件記録の確認**: F03/F06 を staging で実行（Vertex 実呼び出し）し、呼び出し回数と AI テーブル行数を突合、マスキング往復で生 PII がログに残らないことを確認。
- **コンプラ チェックリスト**: NFR07 の受け入れ条件 = CMP 項目に 1:1 対応させ、各項目に「証跡（設定 / docs / クエリ結果へのリンク）」または「人間タスク（担当・期日）」を必ず付す。docs/compliance/ を draft 置き場にする。

---

## 6. トレーサビリティ

本トラックのケース ↔ NFR の対応（**横断行列は [traceability-matrix.md](../traceability-matrix.md) に集約**。本表はトラック内の局所ビュー）。

| ケースID | トレース元 | 受け入れ条件（要件側） |
|---|---|---|
| MIG-001〜008 | NFR04 / ルール1・2 | 監査カラム前提の移行 / 移行後テナント分離 / 移行マーカー監査 |
| AUD-001 | NFR04 / ルール1 | 全 mutation を audit_log に記録 |
| AUD-002 | NFR04 | 業務 mutation と audit の同一 tx 整合 |
| AUD-003 | NFR04 | append-only（UPDATE/DELETE/TRUNCATE 不可） |
| AUD-004 | NFR04 | 日次 hash chain で整合検証 |
| AUD-005 | NFR04 | 改竄検知 → Sentry + system_admin メール |
| AUD-006 | NFR04 / ルール1 | client 値上書き / actor 詐称防止 |
| AUD-007 | NFR04 / ルール4 | AI 利用全件保管（プロンプト/応答/トークン/確信度/session_id） |
| AUD-008 | NFR07 / NFR04 | 監査受入（school × user × 期間抽出） |
| CMP-001〜015 | NFR07 | 10 年保管 / 越境回避 / 委託先 / PII 最小化 / 監査受入 / 開示訂正削除 / 規程契約 |

- **cutover.md との関係**: 本トラックの合成 dry-run は、[docs/runbooks/cutover.md](../../runbooks/cutover.md)（本番切替手順）の**前段の機能・整合検証**。ROADMAP の「dry-run 3 回」は cutover 直前の本番リハーサル（人間）を指し、本トラックはそのリハーサルが回る前提（移行スクリプトが整合・冪等・テナント分離を満たす）を staging 合成で保証する。cutover.md 自体の整備状況は [§8](#8-未決事項) に未決として残す。
- 抜け検出方針: NFR04 / NFR07 の各受け入れ条件チェックボックスに対し最低 1 つの MIG/AUD/CMP ケースが紐づくこと。紐づかない条件は matrix で「未カバー」として可視化する。

---

## 7. Claude / 人間の境界

| 区分 | 内容 |
|---|---|
| **Claude 主導** | 合成 V1 エクスポートでの移行 dry-run と突合（MIG）、staging 実構成での監査網羅性・append-only・ハッシュチェーン・AI 全件記録の検証（AUD）、コンプラ チェックリストの**証跡収集 + initial draft**（CMP）、検出欠陥の修正 PR → Reviewer 別 spawn → 再検証ループ。 |
| **人間 / 導入フェーズに残す** | ① **本番 Firestore からの実移行**と実データでの突合（ROADMAP「dry-run 3 回」= cutover リハーサル）、② **最終的な法務・コンプラ判断**（個情法解釈 / 文科省GL・ISMAP の正式適合性 / 保管義務 vs 削除請求の優先）、③ **委託先契約（GCP DPA）の締結**・規程・プライバシーポリシー・サイバー保険、④ ISMAP 等の**第三者による正式認証**、⑤ 本番データ・本番環境に対する一切の検証。 |

> 本トラックの Exit レポートは「合成 dry-run で移行は整合・冪等・テナント分離 OK、監査は網羅・改竄不能 OK、コンプラは証跡 or 人間タスクに全項目帰着」を示すに留まる。**本番移行の実行と最終法務判断は人間が導入フェーズで実施**（test-strategy.md §4 と整合）。

---

## 8. 未決事項

- ~~**cutover.md 未整備**~~ **解消**: [docs/runbooks/cutover.md](../../runbooks/cutover.md) 整備済（ROADMAP「切替 runbook 完成」）。本トラックの dry-run 設計と cutover 手順の接続点（並行運用 / 旧 Firebase 停止判断 / ロールバック）は runbook §1/§3/§5 で確定。残る環境隔離方式は下記「dry-run 環境の隔離方式」に集約。
- **AI mutation の audit_log 二重記録の切り分け**: AI 記録は `ai_*` テーブル（全件保管）と `audit_log`（mutation 記録）のどちらを真実源に網羅判定するか。AUD-001 の網羅表と AUD-007 の AI 全件突合の責務境界を実装到達度に合わせて確定。
- **コールド移送の staging 検証可否**: CMP-002 の Cloud Storage Archive への日次移送を staging で dry-run できるか（バケット・IAM 整備状況）。未整備なら合成 + 設計レビューで代替し、実移送は本番運用へ。
- **docs/compliance/ の現況**: CMP-007〜014 の draft 置き場（委託先管理表 / 文科省GL 対応表 / ISMAP 自社管理策 / GDPR 対象外方針）の整備状況を確認し、未着手項目を Issue 化。
- **移行スコープの完全性**: 現行 migration ジョブは schools / departments / grades / classes / school_configs / daily_data / ads を対象とする。**スコープ網羅性は MIG-008(b) の合格条件としてマッピング監査（[v1-v2-mapping.md](../../architecture/v1-v2-mapping.md) 突合）に組み込み済**（行レベル突合では拾えない「対象外コレクション漏れ」を担保）。残課題は v1-v2-mapping.md 自体の最新性確認（V1 に新規コレクションが増えていないか）を実行着手前に行うこと。
- **dry-run 環境の隔離方式**: 使い捨て staging DB か隔離スキーマか（再投入・resume 検証で DB をリセットする手段）を staging 構成に合わせて確定。
