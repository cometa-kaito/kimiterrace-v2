# Cloud Logging 閲覧の最小権限 IAM（ADR-029 follow-up / #439）
#
# 公開エンドポイント（F05 magic-link `GET /s/{token}`・SwitchBot Webhook `?key=`）の
# 秘匿値は、Cloud Run が各リクエストを自動記録する request log
# （`httpRequest.requestUrl`、`_Default` バケット）に残りうる（ADR-029）。
# このログから特定フィールドだけをアプリ層で redact することはできない。
#
# 保持ログ内の live token / secret を「Cloud Logging 閲覧権を持つ内部者・委託先」が
# 収集して生徒ビューになりすます脅威（#439）への主防壁として、ログ閲覧/データアクセス
# ロールの付与を運用者（var.log_viewer_members）のみに **authoritative** に限定する。
# これが ADR-029 の補償統制の最後の未実装ピースであり、#439 の close 条件。
#
# なぜ additive(member) でなく authoritative(binding) か:
#   `google_project_iam_member` は付与を「足す」だけで、列挙外の広域付与（例: 別経路で
#   付いた `roles/logging.viewer`）を排除できない。`google_project_iam_binding` はロールの
#   member 集合を宣言値で「置換」するため、最小権限を強制し気付かぬ閲覧付与を取り除ける
#   （CLAUDE.md ルール5 / NFR03）。
#
# ⚠️ 注意（残存・ADR-029 再検討トリガで扱う）:
#   - `roles/owner` / `roles/editor` は logging.viewer 権限を内包するため、本 binding は
#     「直接的な閲覧ロール付与」を絞る統制。Owner/Editor の暗黙閲覧の遮断は IAM deny policy /
#     org policy の領分（本モジュールのスコープ外）。
#   - authoritative binding は member 集合を置換するため、breakglass 用の管理者プリンシパルを
#     var.log_viewer_members に **必ず含める**こと（さもないと閉塞時にログ調査ができない）。

resource "google_project_iam_binding" "log_access" {
  for_each = var.enabled ? toset(var.restricted_roles) : toset([])

  project = var.project_id
  role    = each.value
  members = var.log_viewer_members
}
