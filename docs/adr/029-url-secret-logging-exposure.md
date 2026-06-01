# ADR-029: 公開エンドポイントの URL 内シークレット/トークンのロギング露出方針

- 状態: Accepted（2026-06-02）
- 日付: 2026-06-02
- 関連: [#437 Low-2](https://github.com/cometa-kaito/kimiterrace-v2/issues/437), [#439](https://github.com/cometa-kaito/kimiterrace-v2/issues/439), [#243](https://github.com/cometa-kaito/kimiterrace-v2/issues/243)（検証フェーズ）, [ADR-020 §5 (SwitchBot Webhook 認可)](020-presence-sensor-switchbot-webhook.md), [F05 magic link](../requirements/functional/F05-class-magic-link.md), [NFR03 セキュリティ](../requirements/non-functional/NFR03-security.md), [NFR04 監査](../requirements/non-functional/NFR04-audit-log.md), [CLAUDE.md ルール1/ルール5]

## 文脈

検証フェーズ（#243）の公開エンドポイント レビューで、**URL 内に秘匿値が載りそれが Cloud Run の自動リクエストログに残る** 2 件の Low が挙がった。

- **#437 Low-2**: SwitchBot Webhook は共有シークレットを `?key=<secret>` クエリでも受理する（[ADR-020 §5](020-presence-sensor-switchbot-webhook.md) が `?key=` と `X-Webhook-Key` ヘッダの**両方を正規選択肢として許容**）。クエリで来ると secret が URL に載る。
- **#439**: F05 クラス magic link は `/s/{token}` の **パスにトークン**を持つ（クリック/QR で開く URL の性質上、トークンは URL に載らざるを得ない）。

**根本原因**: Cloud Run（[ADR-002](002-cloud-run-vs-functions.md)）は各 HTTP リクエストの URL（パス + クエリ文字列）を `httpRequest.requestUrl` として **自動でリクエストログに記録**する。この自動ログから特定フィールド（クエリの 1 パラメータ等）だけをアプリ層で redact することはできない。よって「URL に秘匿値が載る経路」がある限り、その値は Cloud Logging のリクエストログに残りうる。

両件とも検証レビューで **Low** と評価された（テナント分離・データ配信は堅牢で悪用可能な脆弱性はなく、可用性/露出の小欠陥）。本 ADR はこの「URL 内秘匿値のログ露出」に対する**一貫した方針**を決め、両 issue を解決する。

### 候補

| 候補 | 概要 | NFR04 監査への影響 | 実装コスト | 残存リスク |
|---|---|---|---|---|
| A. ログ除外フィルタ | 該当ルートの request log を Cloud Logging から**丸ごと除外**（`google_logging_project_exclusion`） | ◯ 影響なし（NFR04 source は `audit_log`、両ルートはアプリ層で events/監査を独立記録） | 低（Terraform）| secret は消えるが**運用観測性**を喪失 |
| B. アプリ自前リクエストログ + redact | Cloud Run 自動ログを抑止し、アプリで URL を redact した構造化ログを自前出力 | △ 自前実装の正確性に依存（抜け穴リスク）| 高（全公開ルート横断）| 実装漏れ時に再発 |
| C. URL から秘匿値を排除 | webhook=ヘッダのみに寄せる / magic-link=トークンを path から除く | ◎ | webhook: 中（要 SwitchBot のヘッダ送信可否確認）/ magic-link: 高（クリック/QR の UX 根本変更）| UX・互換性 |
| D. 情報ある受容 + 補償統制 | 秘匿値の URL 露出を許容しつつ、補償統制で残存リスクを Low に保つ | ◎ 維持 | ~0 | Low（補償統制下）|

### 評価

**A. ログ除外** — 却下。**ただし NFR04 が理由ではない（訂正）**: NFR04 の監査 source of record は `audit_log` テーブル + AI テーブル（アプリ明示書込）であり、Cloud Run 自動 request log は監査要件に含まれない。さらに両ルートは既にアプリ層で「誰がいつ」を独立記録する（magic-link → events、webhook → events + 同 tx 監査）。よって request log を除外しても **NFR04 受入条件は 1 つも欠けない**。A を却下する正しい論拠は (1) **運用観測性の喪失**（当該ルートのアクセス調査・障害解析が当該経路で困難になる）、(2) **Low リスクのために logging 除外フィルタという infra を増やす複雑性**。秘匿値露出は D の補償統制で Low に保てるため、観測性を犠牲にしてまで A を採る利得が薄い。

**B. アプリ自前 redact ログ** — MVP では過剰。全公開ルート横断で Cloud Run 自動ログを抑止し自前ログに置換するのは実装コストが大きく、自前実装の抜け穴が新たなリスクになる。将来オプションとして温存。

**C. URL からの排除**:
- webhook: ADR-020 §5 はヘッダを許容済。SwitchBot がカスタムヘッダ送信可能なら **本番設定でヘッダを使えば URL に secret が出ない**。ただし SwitchBot 側のヘッダ送信可否が未確認のため、コードで query 経路を削除（= ADR-020 §5 違反）するのではなく、**運用推奨**として「本番はヘッダ優先」を残す（C の部分採用）。
- magic-link: トークンはクリック/QR で開く URL の本体であり、path から排除できない。不採用。

**D. 情報ある受容 + 補償統制** — 採用。補償統制で残存リスクを Low に維持する:
- **webhook secret**: cutover 時に rotate（[[project_switchbot_secret_rotation]] で既決）。加えて本番設定はヘッダ優先（C-webhook の部分採用）。
- **magic-link token**: 有効期限あり（F05 既定 90 日・教員が短縮/失効可能）+ クラス単位（漏洩 blast radius は **1 クラスの公開掲示情報のみ・PII なし**）。
- 両ルートとも **PII を返さない**・Vertex 非経由。
- secret/token は **アプリのログ/レスポンスには反射しない**（ルール5、既存実装で確認済）。URL に残るのは Cloud Run 自動 request log のみ。
- Cloud Logging への閲覧アクセスを **最小権限 IAM**（ログ閲覧ロールを運用者に限定）で囲う。**⚠️ この統制は現状未実装**（#439 が要求する具体策）。保持ログ内の live token を内部者/委託先が収集してなりすます脅威（#439）への主防壁であり、**#439 の close にはこの IAM 実装が前提**（下記 follow-up・必須）。他の補償統制（rotate・期限・失効・PII なし・ログ非反射）は実在するが、本統制が揃うまで magic-link 側の残存リスクは「Low（補償統制下）」を完全には満たさない。

## 決定

**D（情報ある受容 + 補償統制）を採用**する。公開エンドポイントの URL 内シークレット/トークンが Cloud Run 自動リクエストログに残る露出は、上記補償統制下の **Low 残存リスクとして受容**する。

加えて C-webhook の部分採用として、**本番の SwitchBot Webhook 設定はシークレットを `X-Webhook-Key` ヘッダで渡すことを推奨**する（SwitchBot がヘッダ送信可能な場合）。コードは ADR-020 §5 に従い query/ヘッダ両受理のまま維持する（互換のため query 経路は削除しない）。

A（ログ除外）は、当該ルートの**運用観測性を喪失**し、Low リスクに不釣り合いな infra 複雑性を増やすため **不採用**（NFR04 監査は `audit_log` で担保され A でも欠けない）。

## 再検討トリガ

以下のいずれかが成立したら、本 ADR を見直し B（アプリ自前 redact ログ）または C（URL からの排除）を再評価する:

- Cloud Logging のログ保持期間が、トークン/シークレットの有効期間を大きく超える運用になった
- Cloud Logging の閲覧アクセス範囲が拡大した（多テナント・外部委託閲覧等）
- magic-link が PII または個人スコープのデータを返すよう拡張された
- SwitchBot 側でヘッダ送信が標準化され、query 経路を ADR-020 §5 改訂で廃止できる見通しが立った
- ログの export sink（BigQuery / GCS 等）が増え、ログの保持・閲覧面が拡大した

## 影響

- **#437 Low-2 は本 ADR で解決・close 可**: 補償統制（cutover rotate + 本番ヘッダ優先）がいずれも既決/実在し、webhook secret の残存リスクは Low に保たれる。
- **#439 は close しない（継続）**: 残存リスクを Low に保つ補償統制のうち **Cloud Logging 閲覧の最小権限 IAM が未実装**であり、これは #439 が具体策として要求する項目（保持ログ内 live token の内部者/委託先による収集→なりすまし脅威への主防壁）。本 ADR は方針（情報ある受容の枠組み + 採否）を確定するが、**#439 の close には下記 follow-up（必須）の実装が前提**。
- NFR04 監査は当該ルートでも維持（request log は監査 source ではなく `audit_log` が担保。A を採らないため運用観測性も保持）。
- webhook route の query/ヘッダ両受理は現状維持（ADR-020 §5 不変）。

## follow-up

- **（必須・#439 の close 条件）** Cloud Logging 閲覧の最小権限 IAM を Terraform で明文化（ログ閲覧/データアクセスロールを運用者に限定）。infra ログがトークン/シークレットの射程に入ることを compliance doc / runbook に明記。
- **（推奨）** 運用 runbook（cutover / TV 設定手順）に「本番 Webhook はシークレットを `X-Webhook-Key` ヘッダで渡す」を追記。

## 検討した代替案の要約

- **A ログ除外**: 運用観測性喪失 + Low リスクに不釣り合いな複雑性で却下（NFR04 は `audit_log` で担保され A でも欠けない）。
- **B 自前 redact ログ**: 実装コスト大・抜け穴リスクで MVP 見送り（将来オプション）。
- **C URL 排除**: magic-link は UX 上不可、webhook は運用推奨として部分採用。
