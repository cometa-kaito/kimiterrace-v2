# キミテラス v2 MVP 要件定義

- 状態: **Baseline 確定（個別 F/NFR ファイルを正、本書は横断参照。2026-06-01 ユーザーレビュー完了）**
- 最終更新: 2026-05-28
- 起草者: Claude Code (orchestrator)
- 関連: [docs/STATUS.md](../STATUS.md), [docs/ROADMAP.md](../ROADMAP.md), [CLAUDE.md](../../CLAUDE.md)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12) (機能要件), [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13) (非機能要件), [#14](https://github.com/cometa-kaito/kimiterrace-v2/issues/14) (ADR 群), [#15](https://github.com/cometa-kaito/kimiterrace-v2/issues/15) (DDL)

> このドキュメントは MVP 全体像の **一本化ドラフト**。
> 個別ファイルへ分割済（2026-05-28）:
> - 機能要件: [functional/F01-F12](functional/README.md)
> - 非機能要件: [non-functional/NFR01-NFR07](non-functional/README.md)
>
> 本ファイルは **概観・横断要素（ロール / データモデル / RLS / 安全網詳細 / PII / 関連 ADR）の参照源**として維持する。詳細は個別ファイルを正とする。

---

## 1. 概要

### 1.1 目的

キミテラス v2 は、公立高校におけるサイネージを「単なる掲示物」から「**生徒と対話する AI 主導の情報接点**」に再定義することを目的とする。
教員の働き方改革（紙の掲示物作成・印刷・差し替え工数の削減）と、生徒の情報アクセス改善（自分に関係する情報を能動的に質問できる）を両立する。

### 1.2 MVP スコープ

**含む**:

- 教員によるファイル抽出 + 音声 + チャットからの AI コンテンツ生成（PDF/Word/Excel/画像）
- 即公開フロー + 安全網 4 種（audit_log・1-click rollback・AI 確信度フラグ・公開先明示）
- 生徒のクラス magic link 経由匿名アクセス（個人特定なし、スマホ/タブレット）
- 生徒の音声/チャット Q&A（掲示物に関する質問のみ）
- サイネージ表示エンジンの V1 → Cloud Run 移植（広告階層マージ含む。LiDAR ヒートマップは [F13](functional/F13-presence-sensor-webhook.md) / [ADR-020](../adr/020-presence-sensor-switchbot-webhook.md) で SwitchBot PIR ベースの時間帯ヒートマップに置換）
- 来場検知センサー Webhook（[F13](functional/F13-presence-sensor-webhook.md)）— SwitchBot 人感センサ (PIR) のクラウド Webhook 受信、events 統合、センサ管理 UI
- イベントロギング（タップ・遷移）と効果可視化ダッシュボード
- AI 効果コメント自動生成 + 月次レポート (PDF, **手動配布**)
- CRM 機能（広告主マスタ・契約・コミュニケーション履歴、system_admin のみ）
- ロール管理（system_admin / school_admin / teacher / student）
- 監査ログ（10 年保管、改竄検知）
- PostgreSQL RLS による school_id テナント分離

**含まない（→ Phase 2 / 将来追加）**:

- 学習・進路アドバイス（生徒対話は掲示物 Q&A のみに限定）
- 外部システム自動取込み（Google Calendar / メール / Google Classroom / Classi 等）
- サイネージへの天気予報表示（[F14](functional/F14-weather-forecast-signage.md) / [ADR-021](../adr/021-weather-data-source-jma.md)）— 気象庁 (JMA) 無料 API をバックエンド Job で取得・キャッシュし、端末は自校 DB から表示（外部直叩きなし・非 PII）。外部連携だが outbound のみ・端末非経由のため例外的に許容。**低コスト・高視認性のため PoC 前倒し候補**
- 広告主向け管理画面（広告主はシステム外、月次レポートのみ受信）
- 自動配信パイプライン（月次レポートは手動配布で良い）
- ペネトレーションテスト（2027 年に延期、CI 自動スキャンで代替）

### 1.3 用語

| 用語 | 定義 |
|---|---|
| キミテラス | 公式ブランド名（運営 rebounder.jp）。LP コードに残る "Edix" 表記は誤り |
| 学校テナント | school_id を主キーとする独立テナント。RLS で完全分離 |
| クラス magic link | 1 クラスに 1 つ発行される URL トークン。個人特定なし、有効期限あり |
| 安全網 4 種 | 即公開フローを支えるリスク低減策の総称（後述 §8） |
| 校務管理者 | school_admin ロール。1 校内の全権限 |
| システム管理者 | system_admin ロール。cross-tenant 権限。奥村さんのみ |

---

## 2. 設計原則

1. **セキュリティ最優先**: 「便利だが少しリスクがある」 vs 「やや不便だが安全」 → 必ず安全側を選ぶ ([CLAUDE.md](../../CLAUDE.md) 同じ規律)
2. **自校内完結**: 外部システム連携は MVP では実装しない。攻撃面を最小化する ([memory: feedback_closed_system_security](../../.claude/projects/.../memory/feedback_closed_system_security.md))
3. **AI 主導 + 安全網**: AI による即公開を許容するが、人による事後修正を必ず 1 操作で可能にする
4. **データ単一テナント分離**: PostgreSQL RLS を DB レベルで強制。アプリ層の WHERE 句に依存しない ([CLAUDE.md ルール 2](../../CLAUDE.md))
5. **監査全件**: 全 DB 書込み・全 AI 呼び出し・全公開操作を audit_log に記録 ([CLAUDE.md ルール 1](../../CLAUDE.md))
6. **PII マスキング**: Vertex AI 送信前に氏名/住所/電話/保護者名をトークン化、応答後に逆変換 ([CLAUDE.md ルール 4](../../CLAUDE.md))
7. **コスト天井は意図的に設けない**: ただし不正抑止としての rate limit はセキュリティ要件として必須 ([STATUS.md "コスト天井は当面気にしない方針"](../STATUS.md))

---

## 3. ロール設計

### 3.1 ロール一覧

| ロール | 主体 | スコープ | 主な権限 |
|---|---|---|---|
| `system_admin` | 奥村さん（運営） | cross-tenant | CRM 操作、全学校レポート閲覧、ロール付与 |
| `school_admin` | 各校 1〜数名の校務 IT 担当 | school_id 単一 | teacher アカウント発行、月次レポート閲覧、学校設定 |
| `teacher` | 各校の教員 | school_id 単一 | コンテンツ作成・編集、magic link 発行、AI 利用 |
| `student` | 各校の生徒 | クラス magic link 経由 | 閲覧、Q&A（掲示物範囲のみ） |
| `advertiser` | 広告主企業（システム外） | n/a | システムアクセス**なし**。月次レポートを対面 / メールで受領 |

### 3.2 権限マトリクス（主要操作）

| 操作 | system_admin | school_admin | teacher | student |
|---|:-:|:-:|:-:|:-:|
| 学校マスタ CRUD | ✅ | 閲覧のみ | 閲覧のみ | ❌ |
| 教員アカウント発行 | ✅ | ✅ (自校) | ❌ | ❌ |
| コンテンツ作成・編集 | ✅ | ✅ (自校) | ✅ (自校) | ❌ |
| AI 構造化呼び出し | ✅ | ✅ (自校) | ✅ (自校) | ❌ |
| クラス magic link 発行 | ✅ | ✅ (自校) | ✅ (自校) | ❌ |
| サイネージ閲覧 | ✅ | ✅ (自校) | ✅ (自校) | ✅ (link 経由) |
| 生徒 Q&A 利用 | ❌ | ❌ | ❌ | ✅ (link 経由) |
| イベントログ閲覧 | ✅ | ✅ (自校) | ✅ (自校) | ❌ |
| 効果ダッシュボード | ✅ | ✅ (自校) | ✅ (自校) | ❌ |
| 月次レポート閲覧 | ✅ | ✅ (自校) | ❌ | ❌ |
| CRM (広告主・契約) | ✅ | ❌ | ❌ | ❌ |
| 監査ログ閲覧 | ✅ | ✅ (自校) | ❌ | ❌ |

### 3.3 実装方針

- Identity Platform の custom claims に `role` + `school_id` を保持
- Next.js middleware で JWT を検証し、PostgreSQL 接続時に `SET app.current_user_id`, `SET app.current_school_id`, `SET app.current_user_role` をセット
- RLS ポリシーが `current_setting('app.current_user_role')` を読んで cross-tenant 判定

---

## 4. 機能要件

### F01: 教員ファイル抽出入力

**概要**: 教員が PDF / Word / Excel / 画像をアップロードすると、AI が内容を構造化してコンテンツ草稿を生成する。

**ユーザーストーリー**:
- 教員として、紙の進路だよりをスキャンしてアップロードし、サイネージ用コンテンツが自動生成されてほしい。なぜなら手入力すると時間がかかるから。

**受け入れ条件**:
- [ ] PDF / DOCX / XLSX / PNG / JPEG をアップロード可
- [ ] アップロードファイルは Cloud Storage の `school-{school_id}-uploads/` バケットに保存
- [ ] AI 抽出結果は構造化 JSON (title, body, suggested_publish_scope, suggested_period, confidence_score) として返る
- [ ] 教員 UI で抽出結果を編集してから公開ボタン押下できる
- [ ] アップロードと AI 抽出は全件 audit_log に記録

**関連**: F03 (AI 構造化), F04 (即公開フロー)

---

### F02: 教員音声 / チャット入力

**概要**: 教員が音声 or チャットで「明日 10 時から体育館で○○の説明会」と話しかけると、AI が構造化してコンテンツ草稿を生成する。

**ユーザーストーリー**:
- 教員として、職員室で立ち話のように音声入力して、すぐにサイネージへ反映したい。

**受け入れ条件**:
- [ ] ブラウザの Web Speech API or Cloud Speech-to-Text で音声 → テキスト
- [ ] 教員 UI のチャット欄から直接テキスト入力も可
- [ ] AI が日時・場所・対象クラス・本文を抽出
- [ ] 抽出結果は F01 と同じ編集 UI に流れる
- [ ] 音声データは保存しない（テキスト化後すぐ破棄、PII 漏洩リスク低減）

**関連**: F03, F04

---

### F03: AI 構造化

**概要**: F01 / F02 の入力を Vertex AI Gemini に渡し、構造化 JSON を返す。

**ユーザーストーリー**:
- システムとして、自由形式の入力を機械可読な構造に変換し、後続フローを単純化したい。

**受け入れ条件**:
- [ ] Vertex AI Gemini (asia-northeast1) を使用
- [ ] PII マスキング後にプロンプトを送信、応答後に逆変換 ([CLAUDE.md ルール 4](../../CLAUDE.md))
- [ ] 出力スキーマは Zod で validate。失敗時はリトライ最大 2 回
- [ ] confidence_score (0.0〜1.0) を必ず返す
- [ ] プロンプト・応答・トークン数・確信度を audit_log の `ai_extractions` 系イベントに記録
- [ ] レート制限: school_id あたり 1 分 60 リクエスト

**関連**: NFR03 (PII マスキング), F04 (確信度フラグ)

---

### F04: 即公開フロー + 安全網 4 種

**概要**: 教員が「公開」を押すと承認なしで即公開。代わりに 4 種の安全網で事後対応可能にする。

**ユーザーストーリー**:
- 教員として、承認待ちのフローではなく即公開で動かしたい。間違っていたら 1 操作で巻き戻したい。

**受け入れ条件**:
- [ ] **F04.1 audit_log**: 公開操作 (publish / update / unpublish / rollback) を全件記録。誰が何を何時に公開したか追跡可能
- [ ] **F04.2 1-click rollback**: 各コンテンツに `content_versions` テーブルで全バージョン保管。教員 UI から 1 ボタンで直前バージョンへ巻き戻し
- [ ] **F04.3 AI 確信度フラグ**: confidence_score < 0.7 のコンテンツは UI で「⚠️ 要確認」バッジ表示 + AI 推測の根拠引用表示
- [ ] **F04.4 公開先明示**: 全コンテンツに `publish_scope` (class_id[] or school_id-wide) を必須化。曖昧な「全校」ボタンを設けず、明示選択させる
- [ ] 公開後は即サイネージ + magic link 経由生徒画面に反映 (CDN キャッシュ最大 60 秒)

**関連**: F01, F02, F03, NFR04 (監査), §8 (安全網詳細)

---

### F05: クラス magic link 発行 / 生徒匿名アクセス

**概要**: 教員がクラス単位で 1 つの magic link を発行。生徒は個人ログインせず、その URL からスマホ/タブレットで閲覧する。

**ユーザーストーリー**:
- 教員として、クラス全員に 1 つの URL を配布したい。生徒ごとアカウント発行は運用が重い。
- 生徒として、個人情報を入力せず気軽にアクセスしたい。

**受け入れ条件**:
- [ ] magic_link テーブル: `id (uuid)`, `school_id`, `class_id`, `token (短縮 URL 用)`, `expires_at`, `revoked_at`, 監査カラム
- [ ] 有効期限デフォルト 90 日、教員 UI から短縮/延長/失効可能
- [ ] 生徒アクセス時にセッション cookie を発行（ブラウザ閉じても 24h 保持）。個人特定情報は一切持たない
- [ ] アクセス元 IP・User-Agent は events テーブルに記録（個人特定はしない、集計用）
- [ ] 失効後アクセスは 410 Gone レスポンス
- [ ] QR コード生成機能（教員 UI 上で印刷可能）

**関連**: F06, F07, NFR03 (セキュリティ)

---

### F06: 生徒対話（音声 / チャット）

**概要**: 生徒が magic link 経由でアクセスし、サイネージに表示されている掲示物に関して音声 or チャットで質問できる。

**ユーザーストーリー**:
- 生徒として、「あの説明会、自分のクラスも対象？」とその場で聞きたい。

**受け入れ条件**:
- [ ] 質問範囲は **掲示物に関する Q&A のみ**。学習・進路アドバイスは Phase 2
- [ ] RAG: 自校 (school_id スコープ) の公開中コンテンツのみを embedding 検索対象とする
- [ ] Vercel AI SDK + SSE ストリーミングで応答
- [ ] PII マスキング (生徒名等が掲示物に含まれている場合)
- [ ] 全質問・応答は ai_chat_sessions / ai_chat_messages に保管 (10 年)
- [ ] rate limit: magic_link あたり 1 分 10 質問、1 端末 cookie あたり 1 分 10 質問
- [ ] プロンプトインジェクション対策: system プロンプトを user 入力で上書きさせない構造

**関連**: F03, F05, NFR03, NFR06 (コスト + rate limit)

---

### F07: イベントロギング

**概要**: 生徒のサイネージ閲覧・タップ・遷移を全て記録。効果可視化と AI 改善の基盤データになる。

**ユーザーストーリー**:
- 学校として、どのコンテンツが見られているか定量的に知りたい。
- 広告主として、自社広告の到達数を月次レポートで知りたい。

**受け入れ条件**:
- [ ] events テーブル: `id`, `school_id`, `event_type (view/tap/dwell/ask)`, `content_id`, `magic_link_id`, `client_id (cookie)`, `timestamp`, `metadata (jsonb)`, 監査カラム
- [ ] 個人特定情報は記録しない（client_id は cookie の uuid のみ）
- [ ] 集計クエリは BigQuery 連携で時系列ダッシュボード化
- [ ] イベント送信は beacon API でページ遷移時もロスなく送信

**関連**: F08 (ダッシュボード), F09 (月次レポート)

---

### F08: 効果可視化ダッシュボード + AI 効果コメント自動生成

**概要**: 学校別・コンテンツ別の閲覧・タップ・滞留・Q&A 件数を可視化。AI が「先週比 30% 増、特に体育祭関連の Q&A が多い」のような自然言語コメントを自動生成。

**ユーザーストーリー**:
- 校務管理者として、どのコンテンツが効果的か数値で知りたい。
- システム管理者として、広告主向け月次レポートの素材を効率的に集めたい。

**受け入れ条件**:
- [ ] ダッシュボード（school_admin / teacher 閲覧、school_id スコープ）
- [ ] system_admin 用 cross-tenant ビュー
- [ ] AI コメントは月次バッチで生成、PII マスキング適用
- [ ] グラフ: 時系列、コンテンツ別ランキング、Q&A 件数、滞留時間ヒートマップ（V1 LiDAR データと統合）

**関連**: F07, F09

---

### F09: 月次レポート（PDF, 手動配布）

**概要**: 学校別・広告主別の月次活動サマリーを PDF 出力し、system_admin が対面 / メールで配布する。**自動配信パイプラインは MVP では作らない**。

**ユーザーストーリー**:
- system_admin として、毎月の広告主訪問前にレポート PDF をダウンロードしたい。

**受け入れ条件**:
- [ ] Cloud Run Job (バッチ) で月初に PDF 生成
- [ ] 学校別レポート: 教員向け、サイネージ全体の活動サマリー
- [ ] 広告主別レポート: その広告主の広告だけの到達・タップ・Q&A 件数
- [ ] system_admin UI からダウンロード可能
- [ ] PDF 生成履歴は monthly_reports テーブルで管理

**関連**: F07, F08, F10 (CRM)

---

### F10: CRM（広告主マスタ・契約・コミュニケーション履歴）

**概要**: 広告主はシステム外だが、社内管理用に CRM 機能を持つ。広告主マスタ、契約期間・金額、訪問記録・メールやり取りの履歴を一元管理する。

**ユーザーストーリー**:
- system_admin として、広告主への月次レポート配布前に契約状況・直近の会話を素早く確認したい。

**受け入れ条件**:
- [ ] advertisers テーブル: 会社名、担当者、連絡先、ステータス（見込/契約中/休止）、業種
- [ ] contracts テーブル: 広告主 × 学校 × 期間 × 金額 × 出稿コンテンツ
- [ ] communications テーブル: 訪問記録、メール内容（手動入力 or 貼付け）、添付ファイル
- [ ] system_admin のみアクセス可（school_admin は閲覧不可）
- [ ] 全データはテナント横断（school_id を持たない）

**関連**: F09, NFR04 (監査)

---

### F11: ロール管理

**概要**: system_admin が school_admin を任命、school_admin が teacher を任命する権限階層を実装する。

**受け入れ条件**:
- [ ] system_admin は全ロール付与可
- [ ] school_admin は同 school_id の teacher のみ発行可
- [ ] teacher は他人のロール変更不可
- [ ] ロール変更は全件 audit_log
- [ ] custom claims は Cloud Functions / Cloud Run の特権ロール経由でのみ更新

**関連**: §3 (ロール設計), NFR03

---

### F12: V1 既存機能の移植

**概要**: 旧 Firebase 版で実装済の機能を Next.js 16 + Cloud Run 環境へ移植する。

**移植対象**（[STATUS.md "V1 棚卸し完了"](../STATUS.md) より）:

- [ ] 管理 UI（学校・コンテンツ・端末・ユーザー）
- [ ] サイネージ表示エンジン（`management/src/components/signage/` 一式 → `apps/web` 内に Server Component として）
- [ ] 広告階層マージロジック（system → school → class の優先度マージ）
- [ ] LiDAR センサー連携（滞留時間取得）
- [ ] firmware の API エンドポイント切替（旧 Firebase Functions → Cloud Run）

**新規追加**（V1 未実装）:

- [ ] QR / タップ / 滞留計測 UI（V1 ではバックエンドに記録するだけだった）
- [ ] 広告主エンティティ（V1 では学校マスタに混ざっていた）

**関連**: F07, F10

---

## 5. 非機能要件

### NFR01: 性能

- API p95 レイテンシ < 500ms（Cloud Run cold start 除く）
- AI ストリーミング初回トークン < 2 秒
- サイネージ画面ロード < 1.5 秒（CDN 経由）
- DB クエリ p95 < 100ms (RLS 込み)

### NFR02: 可用性

- SLA 99.5% (月間ダウンタイム 3.6h 以内、計画メンテ除く)
- 全クリティカルパスに Cloud Run の min-instances=1
- Cloud SQL は HA 構成 (regional, automatic failover)

### NFR03: セキュリティ

- 全 school_id 持ちテーブルに **RLS 必須**（[CLAUDE.md ルール 2](../../CLAUDE.md)）
- PII マスキングは Vertex AI 送信前必須（[CLAUDE.md ルール 4](../../CLAUDE.md)）
- シークレットは Secret Manager のみ（[CLAUDE.md ルール 5](../../CLAUDE.md)）
- HTTPS 強制、HSTS 有効
- Cloud Armor で WAF + IP rate limit
- アプリ層 rate limit: F06 (生徒対話) / F03 (AI 抽出) は必須
- MFA 強制（teacher 以上）
- magic_link は短縮 URL で漏洩リスク考慮、漏洩検知時の失効フローを runbook 化

### NFR04: 監査ログ (10 年保管)

- 全テーブルに監査カラム（[CLAUDE.md ルール 1](../../CLAUDE.md)）
- audit_log テーブル: who (user_id, ip, user_agent), what (table, record_id, op, diff), when
- AI 利用は別途 ai_extractions / ai_chat_messages テーブルで全件保管
- ホットストレージ 1 年、コールド (Cloud Storage Archive) 9 年
- 改竄検知: 日次 hash chain で audit_log の整合性検証

### NFR05: アクセシビリティ (WCAG 2.2 AA)

- スクリーンリーダー対応
- カラーコントラスト比 4.5:1 以上
- キーボード操作のみで全機能利用可
- 生徒 UI は片手スマホ操作前提（タップ領域 44pt 以上）

### NFR06: コスト方針

- **コスト天井は意図的に設けない**（[STATUS.md](../STATUS.md)、ユーザー判断 2026-05-28）
- ただし **不正抑止としての rate limit は必須**（NFR03 で実装）
- 月次コストレポートを system_admin に送付（GCP Billing Export → BigQuery）

### NFR07: コンプライアンス

- 個人情報保護法（公立校生徒データの 10 年保管要件）
- 文部科学省「教育情報セキュリティポリシーに関するガイドライン」準拠
- ISMAP 相当の管理策（クラウド事業者は GCP のため Google が ISMAP 取得済、自社運用部分の管理策を文書化）
- データ越境なし: Vertex AI も asia-northeast1 リージョン固定

---

## 6. データモデル概念設計

### 6.1 テーブル分類

```
[テナント分離 (RLS有)]   [システム横断 (RLS無)]   [監査・ログ]
─────────────────       ─────────────────       ─────────────
schools                  system_admins           audit_log
users                    advertisers             ai_extractions
classes                  contracts               ai_chat_sessions
memberships              communications          ai_chat_messages
magic_links              monthly_reports         events
contents
content_versions
publishes
```

### 6.2 主要テーブル（概念レベル）

| テーブル | キー | 主な列 | RLS | 備考 |
|---|---|---|:-:|---|
| schools | id (uuid) | name, code, status, contract_until | - | 全 system_admin がアクセス可、school_admin は自校のみ |
| users | id (uuid) | school_id, email, role, mfa_enabled | ✅ | Identity Platform と同期 |
| classes | id (uuid) | school_id, grade, name | ✅ | クラス単位 magic link 紐付け |
| memberships | (user_id, class_id) | school_id, role | ✅ | teacher → class の担当関係 |
| magic_links | id (uuid) | school_id, class_id, token, expires_at, revoked_at | ✅ | 短縮 URL |
| contents | id (uuid) | school_id, kind (notice/event/ad), publish_scope, current_version_id | ✅ | コンテンツ本体 |
| content_versions | id (uuid) | content_id, school_id, body (jsonb), confidence_score, created_by | ✅ | rollback 用全バージョン保管 |
| publishes | id (uuid) | content_id, version_id, school_id, started_at, ended_at | ✅ | 公開期間管理 |
| events | id (uuid) | school_id, event_type, content_id, magic_link_id, client_id, ts | ✅ | F07 イベントログ |
| ai_extractions | id (uuid) | school_id, source_kind, prompt, response, confidence, tokens | ✅ | F03 監査 |
| ai_chat_sessions | id (uuid) | school_id, magic_link_id, client_id | ✅ | F06 セッション |
| ai_chat_messages | id (uuid) | session_id, school_id, role (user/assistant), content, tokens | ✅ | F06 メッセージ |
| advertisers | id (uuid) | name, industry, status, primary_contact | - | F10 CRM |
| contracts | id (uuid) | advertiser_id, school_id, period_start, period_end, amount | - | F10 |
| communications | id (uuid) | advertiser_id, kind, summary, attachments | - | F10 |
| monthly_reports | id (uuid) | school_id?, advertiser_id?, period, pdf_url, generated_at | - | F09 |
| audit_log | id (bigint serial) | school_id?, user_id, table_name, record_id, op, diff, ip, ua | - | 全件 append-only |
| system_admins | user_id (uuid) | created_at | - | system_admin allowlist |

### 6.3 注意事項

- **全テーブルに監査カラム** (`created_at`, `updated_at`, `created_by`, `updated_by`) 必須（[CLAUDE.md ルール 1](../../CLAUDE.md)）
- audit_log と `system_admins` も例外なし
- 詳細 DDL は `packages/db/schema/*.ts` で確定（Phase 設計の次タスク）

---

## 7. RLS ポリシー設計

### 7.1 基本方針

- **単層モデル**: `school_id = current_setting('app.current_school_id')::uuid`
- **system_admin の cross-tenant**: `current_setting('app.current_user_role') = 'system_admin'` で全行アクセス
- **BYPASSRLS は migration ロールのみ**: アプリケーションロールには付与しない

### 7.2 ポリシー雛形

```sql
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;

-- 通常テナントアクセス
CREATE POLICY tenant_isolation ON schedules
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid);

-- system_admin の cross-tenant アクセス
CREATE POLICY system_admin_full_access ON schedules
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin');
```

### 7.3 接続時設定

Next.js Route Handler 内で接続ごとに以下を実行:

```typescript
await db.execute(sql`
  SET LOCAL app.current_user_id = ${userId};
  SET LOCAL app.current_school_id = ${schoolId};
  SET LOCAL app.current_user_role = ${role};
`);
```

`SET LOCAL` でトランザクション境界に限定（プール再利用時のリーク防止）。

### 7.4 テスト戦略

`__tests__/rls/` に以下を必須追加（[CLAUDE.md ルール 2](../../CLAUDE.md)）:

- 許可ケース: 自 school_id のデータが見える
- 拒否ケース: 別 school_id のデータが見えない
- system_admin: 全 school_id 見える
- 未設定: settings 未セット時はアクセス拒否
- migration ロール: BYPASSRLS で全件アクセス可（管理用途のみ）

Testcontainers で実 PostgreSQL を起動して検証（[ADR-012](../adr/) 想定）。

---

## 8. AI 安全網 4 種（F04 詳細）

### 8.1 audit_log

- 全 publish / update / unpublish / rollback 操作を append-only 記録
- diff は JSONB で前後差分を保持
- 1 年経過後は Cloud Storage Archive へ自動移送（9 年追加保管）
- hash chain で日次整合性検証 (NFR04)

### 8.2 1-click rollback

- content_versions テーブルに全バージョン保管
- 教員 UI のタイムライン表示から「このバージョンに戻す」ボタン
- rollback も新しい version として記録（履歴は失わない）

### 8.3 AI 確信度フラグ

- F03 の confidence_score < 0.7 は UI で「⚠️ 要確認」バッジ
- AI 推測の根拠を併記（「`進路だより_20260601.pdf` の P.2 から抽出」など）
- 教員レビュー後の編集アクションは flag をリセットして audit_log に記録

### 8.4 公開先明示

- contents.publish_scope は **必須カラム**、デフォルト値なし
- UI では「全校公開」を強調しすぎず、クラス選択をデフォルトに
- 公開先と一致しない magic_link 経由のアクセスは 403

---

## 9. PII マスキング戦略（[CLAUDE.md ルール 4](../../CLAUDE.md) 詳細）

### 9.1 対象 PII

- 生徒氏名（フルネーム + 略称）
- 住所、電話番号
- 保護者氏名
- 教員氏名（プロンプト引用時は注意、ただし学校内なので相対的に保護優先度は低い）

### 9.2 マスキングフロー

```
入力テキスト  →  PII 検出 (regex + LLM)  →  トークン化  →  Vertex AI Gemini
                                                              ↓
出力テキスト  ←  逆変換 (token → PII)  ←  応答 JSON  ←  応答ストリーム
```

トークン例: `田中太郎` → `{{STUDENT_001}}`、`090-1234-5678` → `{{PHONE_001}}`

### 9.3 Embedding

- embedding は **マスキング後のテキスト**で生成
- pgvector に保存される時点で PII を含まない
- RAG 検索時も同じマスキング戦略を適用

### 9.4 audit_log への記録

- マスキング前テキスト: 原則保管しない (school_id スコープの contents 本体には残る)
- マスキング後テキスト + LLM 応答: ai_extractions / ai_chat_messages に保管 (10 年)
- マスキング対応表は session 単位で破棄（永続化しない）

---

## 10. 将来追加機能（後送り）

[STATUS.md "将来追加機能（後送り・現フェーズ対象外）"](../STATUS.md) と同期。

- **外部システム自動取込み**: Google Calendar / メール / Google Classroom / Classi 等。攻撃面拡大のため Phase 2 以降
- **生徒の学習・進路アドバイス AI**: 掲示物 Q&A の運用が安定してから
- **広告主向け管理画面**: 現在は対面 / 月次レポートで十分との判断
- **ペネトレーションテスト本番実施**: 2027 年予定（[ROADMAP.md](../ROADMAP.md) 参照）
- **本格的なコスト最適化**: コスト天井設定、Gemini モデル切替（Flash/Pro 自動選択）など

---

## 11. 未決定事項

- **第三者セキュリティ診断の代替策**: ペネトレ不実施の方針だが、SaaS 型診断 / 簡易診断 / バグバウンティの選定が未決定（[STATUS.md "重要な未決定事項"](../STATUS.md)）
- **magic_link の有効期限デフォルト値**: 90 日を仮置きだが、教員ヒアリングで調整
- **生徒 cookie の保持期間**: 24h 仮置き
- **rate limit のしきい値**: F03 1 分 60req / F06 1 分 10req は仮置き、運用開始後に調整
- **AI 確信度のしきい値 (0.7)**: 仮置き、ベータ運用で調整

---

## 12. 関連

### 12.1 既存 ADR

- [ADR-001 PostgreSQL 採用](../adr/001-postgres-vs-firestore.md)（想定）
- [ADR-002 Cloud Run 採用](../adr/002-cloud-run-vs-functions.md)
- [ADR-003 Identity Platform 採用](../adr/003-identity-platform.md)
- [ADR-004 Drizzle 採用](../adr/004-drizzle-vs-prisma.md)
- [ADR-005 Vertex AI 採用](../adr/005-vertex-ai.md)
- [ADR-006 Vercel AI SDK 採用](../adr/006-vercel-ai-sdk.md)
- [ADR-007 pgvector 採用](../adr/007-pgvector.md)
- [ADR-008 Next.js Route Handlers 採用](../adr/008-nextjs-route-handlers.md)

### 12.2 必要な新規 ADR（このドラフト確定後に起票）

- ADR-015: 即公開 + 安全網 4 種（承認フロー非採用の根拠）
- ADR-016: クラス magic link による匿名アクセス
- ADR-017: AI 構造化への Gemini 採用（confidence_score 必須化含む）
- ADR-018: CRM 機能の独自設計（既存 SaaS 連携を採用しなかった理由）
- ADR-019: RLS 二層分離（school_id テナント + system_admin cross-tenant）

### 12.3 関連 issue

- [#11](https://github.com/cometa-kaito/kimiterrace-v2/issues/11) V1 棚卸し（完了）
- [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12) 機能要件ドラフト ← **このドキュメントで充足**
- [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13) 非機能要件ドラフト ← **このドキュメントで充足**
- [#14](https://github.com/cometa-kaito/kimiterrace-v2/issues/14) ADR 群 ← 上記 12.2 の起票が必要
- [#15](https://github.com/cometa-kaito/kimiterrace-v2/issues/15) PostgreSQL DDL ← データモデル概念設計を基に Drizzle スキーマ化
- [#16](https://github.com/cometa-kaito/kimiterrace-v2/issues/16) C4 図 + シーケンス図 ← このドキュメントを基に作成
- [#17](https://github.com/cometa-kaito/kimiterrace-v2/issues/17) STRIDE 脅威モデル ← §3 ロール + §7 RLS を基に作成

---

## レビュー観点（ユーザー向け）

このドラフトをレビューする際、特に以下を確認してください:

1. **機能の漏れ**: F01〜F12 で網羅できているか? 前セッションの議論で出たが書き漏らしている点はないか?
2. **ロール設計**: §3 の権限マトリクスに「これは違う」があるか?
3. **安全網 4 種**: §8 の 4 種で「即公開」のリスクを十分カバーできているか?
4. **データモデル**: §6 のテーブル分類で、CRM 系がテナント分離テーブルに混じっていないか確認
5. **未決定事項**: §11 のうち、すぐ決められるものはレビュー時に確定したい
6. **将来追加機能**: §10 に挙げた「Phase 2 送り」リストで、MVP に戻すべきものはないか?

レビュー後、ユーザーの合意が取れたら以下を実施:

- 個別ファイル分割: `docs/requirements/functional/F01-F12.md`, `docs/requirements/non-functional/NFR01-NFR07.md`
- 新規 ADR 群（12.2）の起票
- Drizzle スキーマ（packages/db/schema/）への着手
- C4 図と STRIDE の作成
