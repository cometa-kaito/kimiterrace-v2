# Storage バケット構造

> **ステータス: 🚧 BLOCKED — 旧プロジェクト未参照**
>
> 参照元 (CLAUDE.md より):
> - `../キミテラス/storage.rules`（あれば）
> - `../キミテラス/firebase.json`（バケット定義）
> - 旧 GCP プロジェクトの Firebase Storage コンソール（実バケット一覧の確認）
> - `../キミテラス/management/src/**/*`（アップロード/ダウンロードコード）
> - `../キミテラス/functions/handlers/*`（サーバー側操作）

## 目的

旧 Firebase Storage のバケット構造とアクセス制御を文書化し、
v2 の Cloud Storage 設計（バケット名・パス規約・IAM・ライフサイクル）に反映する。

## 必要な記載項目（テンプレート）

### バケット一覧

| バケット名 | リージョン | ストレージクラス | 用途 | PII 含有 | v2 移行先 |
|---|---|---|---|---|---|
| `<default>-firebase` | TBD | Standard | TBD | TBD | TBD |
| ... |

### パス規約

各バケット内のオブジェクトキー規則:

- `schools/{school_id}/students/{student_id}/photos/{file_id}.jpg`
- `schools/{school_id}/announcements/{announcement_id}/attachments/{file_id}`
- ...

**`school_id` を必ずパスに含める**（v2 では IAM 条件 or 署名付き URL の scope で強制）。

### `storage.rules` の許可条件

```
// 旧ルールの該当ブロックを抜粋
match /schools/{schoolId}/... {
  allow read: if ...;
  allow write: if ...;
}
```

### コンテンツ種別

| 種別 | MIME | 最大サイズ | 想定総容量 | 保管期間 |
|---|---|---|---|---|
| 生徒写真 | image/jpeg | TBD | TBD | 卒業後 N 年 |
| お知らせ添付 | application/pdf 他 | TBD | TBD | TBD |
| サイネージ素材 | image/*, video/* | TBD | TBD | TBD |

### ライフサイクル

- 何日後に Nearline / Coldline / Archive へ移行するか
- 何日後に削除するか
- 旧バージョンの保持

### 署名付き URL の利用

- 発行している箇所（Function 名）
- 有効期限
- 用途

## v2 設計の方針

- **公立校データ 10 年保管要件**: ライフサイクル設定でクラス遷移を自動化
- バケットは **環境ごと** (`signage-v2-prod`, `signage-v2-staging`) に分離
- IAM 条件で `school_id` プレフィックス強制（テナント分離）
- アップロードは Next.js Server Action → 署名付き URL で client → Storage 直送
- 監査: アクセスログを Cloud Audit Logs に集約
- PII 含有オブジェクトは CMEK + 削除済みオブジェクトのソフトデリート無効化を検討

→ ADR-002 (Cloud Run) / 監査要件 (ルール1) と整合させる。

---

最終更新: BLOCKED 状態 / 旧プロジェクトの参照が必要
