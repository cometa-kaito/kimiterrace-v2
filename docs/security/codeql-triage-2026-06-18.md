# CodeQL / Semgrep アラート トリアージ記録（2026-06-18）

ADR-042（magic-link）作業中に判明した、**本機能とは無関係の既存 open アラート**のトリアージ記録。
いずれも対象 PR で新規導入したものではない（後述の通り全ファイルが ADR-042 着手前の commit が最終更新）。
CodeQL「集計チェック」がこれらの open アラートで FAILURE になっていたため、各々を誤検知／受容可能リスクと
判定し、理由付きで dismiss する。**本記録 = dismiss の根拠の単一ソース**（GitHub Security タブの dismiss
コメントは 280 字制限のため、本ファイルへポインタを張る）。

判定方針: CLAUDE.md ルール5（秘匿）／ルール4（PII）／「迷ったら安全側」に照らし、**実バグは修正・誤検知は
理由付き dismiss**。今回は精査の結果、いずれもコード側は既に安全（無害なシンク or 既存のサニタイズ済）で、
**振る舞いを変える修正は不要**と判断した（共有部品・サイネージ描画経路への不要改変はかえって退行リスク）。

## 由来の確認（ADR-042 とは無関係 = 既存）

| ファイル | 最終更新 commit | ADR-042 commit 群 (`c198b23`..`dc66e1b`, 06-17〜18) との関係 |
|---|---|---|
| `apps/web/app/_components/AdThumbnail.tsx` | `4394ec9` (#936, 06-15) | 前 |
| `apps/web/app/ops/tv-devices/[deviceId]/edit/_components/TvConfigEditForm.tsx` | `9251998` (#899, 06-14) | 前 |
| `packages/db/src/seed-staging-cli.ts` | `6618708` (#954, 06-15) | 前 |
| `infrastructure/terraform/modules/cloud_sql/main.tf` | `bcf09ee` (#755, 06-08) | 前 |

## アラート別 判定

### #15 — `terraform … gcp-sql-database-ssl-insecure-value` (Semgrep, warning)
`infrastructure/terraform/modules/cloud_sql/main.tf:39` `ssl_mode = "ENCRYPTED_ONLY"`

- **判定: 受容可能リスク（won't fix）。**
- ルールは mTLS（`TRUSTED_CLIENT_CERTIFICATE_REQUIRED`）を要求するが、`ENCRYPTED_ONLY` は
  **全接続に TLS を必須化済**（非 SSL/平文接続を拒否）。instance は **private-IP only・in-VPC** で、
  生徒 PII の転送経路は保護される（ルール5 / NFR03）。
- mTLS は NFR03/ADR で mandate されておらず、クライアント証明書基盤（Cloud Run 配線）が未整備。
  今 mandate すると**接続不能**になる。app 接続方式確定時のハードニング候補（README「スコープ外（Phase 後半）」）。
- 既に `main.tf:33-39` に詳細コメント＋ `# nosemgrep:` を付与済、security Reviewer が PR#578 で安全と判定済。

### #17 — `js/clear-text-logging` (CodeQL, error / high)
`packages/db/src/seed-staging-cli.ts:152` — `console.log(JSON.stringify({ … signageToken … }))`

- **判定: 受容可能リスク（won't fix）。** ルール5 の趣旨（**本番の system secret** をログ/コード/env に
  出さない）には抵触しない。
- 本ファイルは **staging 専用の E2E フィクスチャ seed**（on-demand Cloud Run Job）。出力されるのは
  `SIGNAGE_TOKEN` で、**staging 合成データ・PII ゼロ・失効可能・90 日期限**。`SEED_SCHOOL_ID` は合成校
  (`e2e51111-…`／"E2Eテスト高校") に固定で、本番クラスや実在 PII を露出しない。
- このトークンは検証者が URL/QR を得る**唯一の手段**で、設計上 stdout に 1 度だけ出す必要がある（DB には
  SHA-256 hex のみ保存。`seed-staging-cli.ts:50-53, 149-150` に根拠コメント・ADR-029 の Cloud Run
  リクエストログ露出と同水準と明記）。
- CodeQL は env(`SEED_SIGNAGE_TOKEN`)→`console.log` の flow を機械的に検出しただけで、staging 合成・
  意図的出力という文脈を判別できない。

### #28 — `js/xss-through-dom` (CodeQL, high)
`apps/web/app/ops/tv-devices/[deviceId]/edit/_components/TvConfigEditForm.tsx:207` — `<a href={previewHref}>`

- **判定: 誤検知（false positive）。** `previewHref` は `TvConfigEditForm.tsx:97` で
  `/^https?:\/\//i.test(composedSignageUrl) ? composedSignageUrl : null` により **http(s) のみ**に制限済。
  `javascript:` / `data:` 等は href に載らず、非 http(s) は赤字注記で「開けません」表示にフォールバック。
- フォーム入力（特権ユーザーの self-XSS 面）も明示的に塞いでいる旨、同 97 行のコメントに記載済。
  CodeQL はこの正規表現ガードをサニタイザとして認識しない。

### #29 / #30 — `js/xss-through-dom` (CodeQL, high)
`apps/web/app/_components/AdThumbnail.tsx:62` `<video src={mediaUrl}>` / `:70` `<img src={mediaUrl}>`

- **判定: 誤検知（false positive）。** `<img>` / `<video>` の `src` は**スクリプトを実行しないシンク**
  （`javascript:` URL を入れても発火しない。実行系は `<a href>` / `<iframe src>` 等のみ）。React は
  属性値をエスケープして埋め込むため属性インジェクションも不可。
- `mediaUrl` の出所は同一オリジン `/ad-media/…`（学校アップロード）か外部 https（運営入稿）で、本番サイネージ
  `SignageClient` と同作法。XSS 経路にならない。
- 本コンポーネントはサイネージ描画を含む共有部品のため、無害なシンクへのサニタイズ追加（退行リスク）より
  誤検知 dismiss が適切と判断。

### #32 — `js/xss-through-dom` (CodeQL, high) ※ ADR-042 PR3 (#1038) 由来
`apps/web/app/ops/tv-devices/new/_components/TvDeviceCreateForm.tsx:280` — `<Link href={`/ops/schools/${schoolId}`}>`

- **判定: 誤検知（false positive）。** 他5件と違いこのアラートは ADR-042 PR3（#1038・本日 merge）で
  surfaces したが、**実バグではない**ため同様に dismiss する。
- href は **`/ops/schools/` というリテラル前置のテンプレート**で、結果は常に**単一 `/` 始まりの同一オリジン
  相対パス**。`schoolId` に何が入っても先頭が `/ops/schools/` のため `javascript:` / `data:` /
  プロトコル相対 `//host` には**構造上なり得ない**。React が属性値をエスケープするため属性インジェクションも不可。
- `schoolId` は権限内の学校ドロップダウン（`e.target.value`）由来の UUID で自由入力ではない。Next.js `<Link>`
  の相対パス遷移はスクリプトを実行しない。CodeQL は select 値→href の flow を機械検出しただけ。

### #31 — `js/xss-through-dom` (CodeQL, high)
`apps/web/app/_components/AdThumbnail.tsx:77` — `<a href={href}>`

- **判定: 誤検知（false positive）。** `href` は `safeHttpOrRelative(mediaUrl)`（同 107-117 行）を通した値
  のみ。**http(s) 絶対 URL または単一 `/` 始まりの同一オリジン相対パス**だけを採用し、`javascript:` /
  `data:` / プロトコル相対 `//host`（オープンリダイレクト）を弾く。null 時は `<a>` 化せず素の `<span>`。
- `SignageClient.safeHttpUrl` と同方針。CodeQL はこのサニタイザを barrier と認識しない。
- **フォローアップ（後日対応・dismiss 判定は不変）**: 精査の side note として、相対パス分岐が
  `/\evil.com`（先頭 `/` 直後がバックスラッシュ）を verbatim 通過させる点を発見。一部ブラウザが
  `\`→`/` 正規化で `//host`（protocol-relative）相当に解釈し得る理論上のオープンリダイレクト。
  `mediaUrl` は信頼済の `/ad-media/…` キー or 運営入力で攻撃者到達面でないため**現状非悪用**だが、
  安全側に倒し `safeHttpOrRelative` の相対パス分岐で `\`（index 1）も弾くよう修正済（単体 +
  描画両テスト追加）。`SignageClient.safeHttpUrl` は相対パスを採らず絶対 http(s) のみのため同種の穴なし。

## 対応

- 上記 7 件すべてを GitHub code-scanning で dismiss（#15/#17 = won't fix、#28/#29/#30/#31/#32 = false positive）。
  各 dismiss コメントは本ファイルを参照。#15〜#31 の6件は ADR-042 着手前の既存分、#32 のみ ADR-042 PR3
  (#1038) で surfaces したが同じ誤検知クラス（リテラル前置の同一オリジン相対 `<Link>` href）。
- 振る舞いを変えるコード修正は行わない（コード側は既に安全）。`AdThumbnail.tsx` の `src` 箇所に、無害シンクで
  ある旨の 1 行コメントのみ追加（ドキュメント目的・挙動変更なし）。
- 本番デプロイは別ゲート（本 PR はトリアージ記録 + dismiss のみ）。
