# サイネージ広告クリエイティブの公開 Cloud Storage バケット（#46/#48-F, ルール8）
#
# サイネージ端末（公開 `/signage/{classToken}`）が `ads.media_url` を `<img>` で直接 GET するため、
# 広告クリエイティブ（PNG/JPEG）を **公開 read** で配信する。広告は公開掲示物（企業の認知広告）であり
# 生徒 PII を含まない＝公開しても情報漏えいリスクが無い。教員アップロード素材（upload_storage, 生徒 PII を
# 含みうる）とは正反対の公開ポリシーを **意図的に** 採る点が設計上の差分。
#
# 設計（CLAUDE.md ルール準拠）:
# - ルール8: すべて Terraform 管理。オブジェクト（実画像）は content ゆえ Terraform 管理外（gcloud で upload）。
# - 公開範囲: uniform bucket-level access + `allUsers:objectViewer`（read のみ）。書込みは
#   デプロイ/seed の権限主体（gcloud 実行者 = WIF/管理者）に限り、allUsers に write は付けない。
# - public_access_prevention = "inherited"（"enforced" にすると公開 read 不能）。組織ポリシーで
#   storage.publicAccessPrevention が強制されている場合は apply が失敗するので、その時は配信方式を
#   別途検討する（本モジュールは「公開バケットが許可された環境」前提）。
# - force_destroy は staging/dev で true（recreate 容易性優先・#70 同規律）。prod は false 既定。
# - location は単一リージョン asia-northeast1（NFR07 データ越境ゼロ）。
#
# 雛形段階は enabled=false（count=0）で実体を生成しない（upload_storage / report_storage 同規律）。

locals {
  bucket_name = var.bucket_name != "" ? var.bucket_name : "${var.project_id}-ad-media"
}

resource "google_storage_bucket" "ad_media" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = local.bucket_name
  location = var.location

  # IAM 一本化（ACL でなく IAM）。公開 read は下の iam_member で allUsers に付与する。
  uniform_bucket_level_access = true
  # 公開 read を許可するため "inherited"（"enforced" だと allUsers バインドが拒否される）。
  public_access_prevention = "inherited"

  force_destroy = var.force_destroy

  # 誤上書き時に直前版へ戻せるよう versioning（既定 on）。
  versioning {
    enabled = var.versioning
  }

  # ブラウザ <img> 取得のための CORS（公開掲示ゆえ全 origin 許可・GET/HEAD のみ）。
  cors {
    origin          = ["*"]
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type"]
    max_age_seconds = 3600
  }

  labels = {
    env     = var.env
    feature = "signage-ad-media"
  }
}

# 公開 read（オブジェクト閲覧のみ）。サイネージ端末・ブラウザが認証なしで画像を取得できる。
resource "google_storage_bucket_iam_member" "public_read" {
  count = var.enabled ? 1 : 0

  bucket = google_storage_bucket.ad_media[0].name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}
