# 管理ビューア(PII 近接データ)の閲覧統制ポリシー — ドラフト

> **status: DRAFT（UIUX-03 / 2026-06-11）**
> 起草: Claude（UIUX-03 実装スレッド）。**policy 値の確定はユーザー / コンプライアンス責任者の領分**
> （UIUX-03 ブリーフ C-2）。確定時に DRAFT 表記を外し、PENDING 項目を埋めて ADR 化を検討する。
> 本ドラフトの規定値は **staging までの実装が従う暫定値**。prod 公開はこのポリシー確定が前提。

## 1. 対象

システム管理者 (`system_admin`) 向け管理ビューアのうち、PII または PII 近接データを表示するもの:

| ビューア | ルート | 表示データ | PII リスク |
|---|---|---|---|
| events 生ログ | `/admin/system/events` | 行動ログ firehose（view/tap/dwell/ask/presence）+ payload jsonb | 中（device_mac・匿名 client 識別子・自由テキスト混入可能性） |
| audit_log | `/admin/system/audit` | 全操作の監査証跡 + diff jsonb | 中（diff の before/after に呼び出し元テーブルの実データ断片） |
| ai_chat 監査 | `/admin/system/ai-chat` | 対話セッション + メッセージ全文 | **高**（生徒の質問文。ただし保存時マスク済み＝下記 2.1） |

## 2. マスキング方式（確定済みの実装事実 + 表示層の暫定値）

### 2.1 保存時マスキング（既存・CLAUDE.md ルール4）
- `ai_chat_messages.content_text` は **PII トークン化後のテキストのみ** が保存されている
  （生徒氏名等 → `{{STUDENT_001}}`）。embedding も同様にマスク後テキスト由来。
- **ビューアは逆変換（トークン → 実名）を一切実装しない**。マスキング辞書へのアクセス経路を
  ビューアに与えない。これは恒久不変条件とする（PENDING ではない）。

### 2.2 表示時マスキング（本実装・`apps/web/lib/system-admin/mask.ts`）
- 識別子系キー（mac / client / session / token / device_id / uid 等）: 中間伏字
  （例 `AA:BB:CC:DD:EE:FF` → `AA:B…E:FF` 相当の両端残し）。
- 自由テキスト値: **120 文字で切り詰め**（全文持ち出しの抑止。全文が必要な調査は DB 直接
  アクセス + 別途承認の領分）。
- ネスト深さ 4 / 配列 20 要素で打ち切り。
- ai_chat メッセージ本文は保存時マスク済みのため切り詰めを緩和（詳細画面で全文表示可、
  一覧では抜粋）— **PENDING: 詳細画面の全文表示可否はコンプラ確認**。

## 3. アクセス可能ロール（暫定）

- **`system_admin` のみ**（`requireRole(SYSTEM_ADMIN_ROLES)` + RLS の system_admin policy）。
- school_admin / teacher には公開しない（学校側 UI 最小の設計軸 [[project_school_dx_no_teacher_burden]] とも整合）。
- **PENDING: 将来の運営スタッフ増員時の細分化**（閲覧専用ロール等）はユーザー判断。

## 4. 閲覧監査（本実装・`apps/web/lib/system-admin/view-audit.ts`）

- 上記 3 ビューアの**ページ描画ごと**に `audit_log` へ append-only 1 行を記録する:
  - `table_name`: 論理 subject `events_view_access` / `audit_log_view_access` / `ai_chat_view_access`
  - `operation`: `insert`（audit_op enum に read が無いため。`reports/download-audit.ts` と同規律）
  - `actor_identity_uid`: 閲覧者 IdP uid（system_admin は users 行が無いため actor_user_id=null でも特定可能に）
  - `diff`: 絞り込み条件・page・総件数のみ（**閲覧された行の中身 = PII は記録しない**）
  - `ip_address` / `user_agent`: リクエストヘッダ由来
- セッション詳細（ai_chat）は `record_id` = session id を記録し、**どの対話を見たか**まで立証可能にする。

## 5. エクスポート統制（2026-06-11 ユーザー決定・確定）

- **生ログ（events / ai_chat / audit_log）の raw エクスポート機能は実装しない**。
- 画面提供する集約は**集計のみ**（type 別件数等）。CSV/JSON ダウンロードボタンを置かない。
- 一括持ち出しが必要な正当な調査は、DB 直接アクセス + 人間の承認 + 別途監査記録の運用で行う。

## 6. 保持期間（PENDING — 全てユーザー / コンプラ責任者の確定待ち）

| データ | 暫定案 | 備考 |
|---|---|---|
| ai_chat_sessions / messages | **提案: 1 年で集計値化（個票削除）** | 効果測定は月次集計で代替可能になった時点で短縮検討 |
| events 生ログ | **提案: 2 年**（効果レポートの前年比較に必要な範囲） | presence の膨張は #616 で別途管理 |
| audit_log | **提案: 10 年**（生徒データ 10 年保管前提と整合・改竄検知 chain は削除と相性が悪いため年次アーカイブ方式） | NFR04 |
| 来校者/生徒呼び出しの個人名行 | 既存 issue #808（ADR-034 follow-up）に従う | 本ポリシーの範囲外 |

> 保持期間の自動パージ実装は本 UIUX-03 スコープ外（ビューアは読み取りのみ）。

## 7. prod 公開ゲート

- 本ポリシーの PENDING 確定（ユーザー / コンプラ責任者）
- Opus 検証スレッドによる RLS / PII / 監査テスト（unit + integration + E2E）
- それまでは **staging 限定**（UIUX-03 ブリーフ実行モデル）
