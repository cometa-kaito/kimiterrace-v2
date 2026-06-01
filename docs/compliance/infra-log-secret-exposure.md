# インフラ・リクエストログにおける URL 内シークレット/トークンの露出統制

公開エンドポイントの一部は、その性質上 **URL（パス/クエリ）に秘匿値を載せざるを得ない**。
Cloud Run（[ADR-002](../adr/002-cloud-run-vs-functions.md)）は各 HTTP リクエストの URL を
`httpRequest.requestUrl` として **自動でリクエストログに記録**するため、当該秘匿値は
Cloud Logging のリクエストログ（`_Default` バケット）に残りうる。

本書はこの「URL 内秘匿値のインフラログ露出」に対する統制の現状・残存リスク・運用方針をまとめ、
調達審査（個人情報・認証情報の流れの説明）とインシデント時の影響範囲特定に供する。
方針の一次ソースは [ADR-029](../adr/029-url-secret-logging-exposure.md)。関連:
`data-flow-diagram.md`、`incident-response-playbook.md`、[CLAUDE.md ルール5（シークレット）](../../CLAUDE.md)。

> **ルール5 の射程はアプリログに留まらない。** アプリ層は token/secret をログに出さない
> （`apps/web/lib/magic-link/token.ts`、`apps/web/app/s/[token]/route.ts` で実装・確認済）が、
> URL に載った値は **Cloud Run 自動リクエストログ**に残る。インフラのアクセスログも
> シークレット管理の射程に含めて統制する。

## 対象経路

| 経路 | 秘匿値の載り方 | 中身 | 関連 |
|---|---|---|---|
| F05 magic-link `GET /s/{token}` | URL **パス**にトークン | クラス公開リンクの bearer token（クリック/QR で開く URL の本体のため path から排除不可） | [#439](https://github.com/cometa-kaito/kimiterrace-v2/issues/439) / [ADR-016](../adr/016-class-magic-link-anonymous-access.md) / F05 |
| SwitchBot Webhook | `?key=<secret>` クエリ（受理経路の一つ） | 共有 Webhook シークレット | [#437 Low-2](https://github.com/cometa-kaito/kimiterrace-v2/issues/437) / [ADR-020 §5](../adr/020-presence-sensor-switchbot-webhook.md) |

いずれも検証フェーズ（[#243](https://github.com/cometa-kaito/kimiterrace-v2/issues/243)）の公開エンドポイント
レビューで **Low（defense-in-depth）** と評価された。テナント分離・データ配信は堅牢で、悪用可能な
脆弱性は検出されていない。

## 採用方針: 情報ある受容 + 補償統制（ADR-029 D）

URL 内秘匿値のインフラログ露出を、以下の補償統制下の **Low 残存リスクとして受容**する。
ログ除外フィルタ（ADR-029 案 A）は運用観測性を喪失し Low リスクに不釣り合いなため不採用。
NFR04 の監査 source of record は `audit_log` テーブル + AI テーブル（アプリ明示書込）であり、
リクエストログは監査要件に含まれないため、除外しなくても監査受入条件は欠けない。

| 補償統制 | 状態 | 実装/参照 |
|---|---|---|
| magic-link: 有効期限（既定 90 日・教員が短縮/失効可）+ クラス単位（漏洩 blast radius = 1 クラスの公開掲示情報のみ・**PII なし**） | ✅ 実在 | ADR-016 / F05 |
| magic-link: 毎リクエスト再解決で即時失効 | ✅ 実在 | `lib/magic-link/student-session.ts` |
| webhook secret: cutover 時に rotate | ✅ 既決 | [[project_switchbot_secret_rotation]] / `runbooks/cutover.md` |
| webhook: 本番設定は `X-Webhook-Key` ヘッダ優先（URL に載せない、ADR-020 §5 のヘッダ受理を活用） | 🔶 運用推奨 | ADR-020 §5 / ADR-029（コードは query/ヘッダ両受理を互換維持） |
| 両経路とも **PII を返さない・Vertex 非経由**、token/secret をアプリログ/レスポンスに反射しない | ✅ 実在 | ルール5 |
| **Cloud Logging 閲覧の最小権限 IAM**（ログ閲覧/データアクセスロールを運用者に限定） | ✅ 実装（雛形, `enabled=false`） | `infrastructure/terraform/modules/logging_iam/`（本 #439） |

### Cloud Logging 閲覧の最小権限 IAM（本 issue の主防壁）

保持ログ内の live token/secret を「Cloud Logging 閲覧権を持つ内部者・委託先」が収集して
生徒ビューになりすます脅威（#439）への主防壁。`logging_iam` モジュールが、ログ閲覧/データアクセス/
管理ロール（`roles/logging.viewer`・`roles/logging.privateLogViewer`・`roles/logging.admin`）を
**authoritative な `google_project_iam_binding`** で運用者プリンシパル（`var.log_viewer_members`）のみに
限定する。additive な付与（`google_project_iam_member`）では列挙外の広域付与を排除できないため、
member 集合を宣言値で「置換」する binding を採る（最小権限の強制、ルール5 / NFR03）。

- **雛形段階は `enabled = false`**（実体生成なし）。Phase 開発で `enabled = true` + `log_viewer_members`
  に運用者グループ（`group:ops@...` 推奨）と **breakglass 管理者**を設定して有効化する。
- **残存（IAM deny policy / org policy の領分・本モジュール範囲外）**: `roles/owner`/`roles/editor` は
  `logging.viewer` 権限を内包するため、本 binding は「直接的な閲覧ロール付与」を絞る統制であり、
  Owner/Editor の暗黙閲覧の遮断は別レイヤで扱う（ADR-029 再検討トリガ参照）。

## 再検討トリガ（ADR-029）

以下が成立したら ADR-029 を見直し、案 B（アプリ自前 redact ログ）/ 案 C（URL からの排除）を再評価する:

- Cloud Logging のログ保持期間が token/secret の有効期間を大きく超える運用になった
- Cloud Logging の閲覧アクセス範囲が拡大した（多テナント・外部委託閲覧等）
- magic-link が PII または個人スコープのデータを返すよう拡張された
- ログの export sink（BigQuery/GCS 等）が増え、保持・閲覧面が拡大した
- SwitchBot 側でヘッダ送信が標準化され、query 経路を ADR-020 §5 改訂で廃止できる見通しが立った

## インシデント時の確認ポイント

- magic-link token / webhook secret の漏洩が疑われる場合、**Cloud Logging のリクエストログも
  露出面**として扱う（保持期間内の `httpRequest.requestUrl` に live 値が残りうる）。対応は
  当該 token の失効（教員 UI）/ secret の rotate と、`log_viewer_members` の棚卸し。
- `incident-response-playbook.md` の影響範囲特定に本経路を含める。
