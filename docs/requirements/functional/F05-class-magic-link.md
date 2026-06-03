# F05: クラス magic link 発行 / 生徒匿名アクセス

- 状態: 実装済（基盤）/ 一部未実装 — DB 基盤・発行/失効 API・生徒匿名アクセス（24h cookie / 410 Gone / IP·UA ロギング）は動作。QR コード・既存リンクの短縮/延長・漏洩 runbook が残（[#143](https://github.com/cometa-kaito/kimiterrace-v2/pull/143)/[#149](https://github.com/cometa-kaito/kimiterrace-v2/pull/149)/[#160](https://github.com/cometa-kaito/kimiterrace-v2/pull/160)/[#198](https://github.com/cometa-kaito/kimiterrace-v2/pull/198)/[#209](https://github.com/cometa-kaito/kimiterrace-v2/pull/209)/[#285](https://github.com/cometa-kaito/kimiterrace-v2/pull/285)）
- 関連 ADR: [ADR-016 (magic link 匿名アクセス)](../../adr/016-class-magic-link-anonymous-access.md), ADR-003 (Identity Platform)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#41](https://github.com/cometa-kaito/kimiterrace-v2/issues/41)

## 概要

教員がクラス単位で 1 つの magic link を発行。生徒は個人ログインせず、その URL からスマホ/タブレットで閲覧する。

## ユーザーストーリー

- **教員として**、クラス全員に 1 つの URL を配布したい。**なぜなら**生徒ごとアカウント発行は運用が重く、卒業・転入で破綻するから。
- **生徒として**、個人情報を入力せず気軽にアクセスしたい。

## 受け入れ条件

- [x] magic_link テーブル: `id (uuid)`, `school_id`, `class_id`, `token (短縮 URL 用)`, `expires_at`, `revoked_at`, 監査カラム — 実装済（[#143](https://github.com/cometa-kaito/kimiterrace-v2/pull/143)、[#209](https://github.com/cometa-kaito/kimiterrace-v2/pull/209) composite FK、`packages/db/src/schema/magic-links.ts`）。token は平文非保存で `token_hash` 化、`auditColumns` 込み、`(class_id, school_id)` composite FK で cross-tenant 防止
- [~] 有効期限デフォルト 90 日、教員 UI から短縮/延長/失効可能 — 部分実装（[#149](https://github.com/cometa-kaito/kimiterrace-v2/pull/149) 発行/一覧/失効 API、[#285](https://github.com/cometa-kaito/kimiterrace-v2/pull/285) 発行/失効 UI、`apps/web/app/api/magic-links/`、`apps/web/app/admin/editor/[classId]/magic-link/_components/MagicLinkManager.tsx`）。デフォルト 90 日（schema default）+ 発行時に期限指定（1〜365 日）+ 失効は実装済。残: **既存リンクの短縮/延長**（expiry を後から変更する update/PATCH 経路が無く、発行時のみ指定可）
- [x] 生徒アクセス時にセッション cookie を発行（ブラウザ閉じても 24h 保持）。個人特定情報は一切持たない — 実装済（[#160](https://github.com/cometa-kaito/kimiterrace-v2/pull/160)、`apps/web/lib/magic-link/student-session.ts`／`apps/web/app/s/[token]/route.ts`）。httpOnly cookie に token のみ格納（school_id 等は埋めず毎リクエスト再解決）、maxAge=24h
- [x] アクセス元 IP・User-Agent は events テーブルに記録（個人特定はしない、集計用）— 実装済（[#160](https://github.com/cometa-kaito/kimiterrace-v2/pull/160)、`apps/web/lib/magic-link/student-access.ts`）。`/s/{token}` 到達時に `recordStudentAccess` が `events`（type=view）へ IP/UA を payload で記録（userId 非載・ベストエフォート）
- [x] 失効後アクセスは 410 Gone レスポンス — 実装済（[#160](https://github.com/cometa-kaito/kimiterrace-v2/pull/160)、[#198](https://github.com/cometa-kaito/kimiterrace-v2/pull/198) 期限境界、`apps/web/app/s/[token]/route.ts`）。`resolve_magic_link` が失効/期限切れ/不明を 0 行で返し route が 410 Gone を返す
- [x] QR コード生成機能（教員 UI 上で印刷可能）— 実装済（#41、`MagicLinkManager` が発行直後の平文 URL を `qrcode.react` で SVG にクライアント側エンコードして表示＋「QR を印刷」。token は URL コピーと同一露出範囲で外部送信なし）
- [ ] 漏洩検知時の即時失効フロー (runbook 化) — 未実装（失効 API/UI `revokeMagicLink` は存在するが、漏洩検知→失効の runbook 文書が `docs/runbooks/` に無い）

## 関連

- 後段: [F06 (生徒対話)](F06-student-qa.md), [F07 (イベントログ)](F07-event-logging.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md)
- テスト: `__tests__/api/magic-links/`, `__tests__/e2e/student-access/`
