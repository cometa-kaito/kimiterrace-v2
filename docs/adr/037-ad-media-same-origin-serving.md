# ADR-037: サイネージ広告メディアの同一オリジン配信（`/ad-media/<key>` proxy）

- 状態: Accepted（2026-06-11、ユーザー判断「フル実装（推奨）」）
- 日付: 2026-06-11（Proposed / Accepted 同日。`/admin` からの広告アップロード自己完結化に伴う配信設計）
- 関連: [ADR-008 Route Handlers](008-nextjs-route-handlers.md), [ADR-009 Terraform / 単一 egress](009-terraform.md), 公開 ad-media バケット（`infrastructure/terraform/modules/ad_media`・#46/#48-F）, [CLAUDE.md ルール5（secret/log・最小権限）/ ルール8（Terraform）], [docs/discovery/wifi-filter-method.md（県教委 Wi-Fi FQDN 許可リスト）], 月次レポート DL の proxy-stream 先例（`api/reports/[id]/download`）

## 文脈

`/admin` から広告クリエイティブを**アップロードして自校サイネージに流す**自己完結フローを作る（#46、ユーザー要望「prod の UI から設定できるようにしたい」）。クリエイティブは公開 ad-media バケット（`infrastructure/terraform/modules/ad_media`・allUsers:objectViewer）に保存する。問題は **`ads.media_url` に何の URL を保存し、サイネージ実機がどこから GET するか**。

- サイネージ実機は **県教委 Wi-Fi の FQDN 許可リスト**下にあり、**`app.school-signage.net` のみ到達可・`.run.app` は遮断**（prod main.tf のカスタムドメイン節 / wifi-filter-method.md 制約 C01）。
- GCS 直 URL（`https://storage.googleapis.com/<bucket>/<key>`）は **`storage.googleapis.com` ホスト**で、許可リストに含まれる保証が無い（含まれていなければ実機で画像が出ない）。現に既存岐南広告（seed-ginan-ads）は staging バケットの GCS 直 URL を `media_url` に持つ。
- 広告は **公開掲示物（企業の認知広告・PII を含まない）**。月次レポート（生徒データを含みうる→認証付き proxy + `no-store`）とは**正反対の公開ポリシー**を取れる。

## 候補

| 候補 | 概要 | 評価 |
|---|---|---|
| A. GCS 直 URL を `media_url` に保存 | `storage.googleapis.com/<bucket>/<key>` | 実装ゼロだが **FQDN 許可リスト次第で実機表示不可**。許可ドメインを増やす運用は県教委依存で不確実 |
| B. 署名 URL | V4 signed URL を保存 | 短命 or 露出。公開掲示物に署名は過剰、かつ host は依然 storage.googleapis.com で FQDN 問題は不変 |
| **C. 同一オリジン proxy（採用）** | `media_url = /ad-media/<key>`。web が ADC でバケットから読み stream | **`app.school-signage.net` 1 ドメインで完結**＝FQDN 許可リストを通る。reports DL の proxy-stream 先例あり |
| D. Cloud CDN + カスタムドメイン経路 | LB + バックエンドバケットで配信ドメインを張る | 最も堅いが **インフラが重い**（LB/証明書/経路）。MVP には過剰、後日 C から移行可 |

## 決定

**C（web 自身による同一オリジン proxy 配信）** を採用する。

1. **`ads.media_url` には相対パス `/ad-media/<key>` を保存**する（`adMediaServingPath`）。サイネージの `<img>`/`<video>` は同一オリジン `app.school-signage.net` から GET し、FQDN 許可リストを通る。
2. **配信は無認証・公開**（`app/ad-media/[...key]/route.ts`）。広告は公開掲示物（PII 無し）ゆえ、月次レポート（認証 + `no-store`）と異なり**無認証配信が安全側**。読み取りは Workload Identity（ADC）でバケットから stream（reports の `ReportDownloadPort` と対の `AdMediaDownloadPort`）。
3. **汎用バケットプロキシ化を構造的に防ぐ**: 接頭辞 `ads/` + 安全文字 + `..`/空セグメント不可を `isValidAdMediaKey` で強制してから fetch する（path traversal・接頭辞外参照を拒否）。**外部 URL を一切受けない**（key のみ）ため SSRF 面が無い。
4. **キャッシュ可**: 保存キーはサーバ生成 UUID で内容不変ゆえ `Cache-Control: public, max-age=31536000, immutable`（reports の `no-store` と対）。
5. **バケット名は env `AD_MEDIA_BUCKET`**（ハードコード禁止・ルール5）。web Cloud Run への env 注入 + web runtime SA へのバケット限定 `objectAdmin`（書込）/ 読取は別 PR で Terraform 化（ルール8）。

## 残存リスク

- ① **web が配信経路に入る**: サイネージは画像取得のたびに web を経由する（従来は CDN 直）。ただし `immutable` 長期キャッシュで実取得は初回のみ。負荷が問題化したら **D（Cloud CDN + バックエンドバケット）へ移行**（`media_url` の host だけ変える後方互換移行が可能）。
- ② **既存岐南広告（GCS 直 URL）は本方式に未移行**: 本 ADR は新規アップロード分に適用。既存 seed 広告の `media_url` 書換は別途（非ブロッカー。岐南実機で現状映っている＝当該環境では storage.googleapis に到達できている観測と整合）。
- ③ **公開バケットのまま**: proxy 経路を主としても、バケットは allUsers:read を維持（GCS 直 URL も生きる）。将来 proxy 専一にするなら公開 read を外す選択肢があるが、現状は後方互換のため維持。
