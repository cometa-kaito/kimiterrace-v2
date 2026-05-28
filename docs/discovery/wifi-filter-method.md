# 県教委 Wi-Fi フィルタ方式

確認日: 2026-05-28
対象: 岐阜県教育委員会 Wi-Fi（岐南工業高等学校で利用）

## 結論

**ドメインベース（FQDN / SNI）フィルタリング**で許可リストに登録済み。

→ Cloud Run 移行で配信元 IP が変わっても、`app.school-signage.net` のドメイン名で許可されているため、**追加対応は不要**。

## 影響

| 項目 | 影響 |
|---|---|
| Cloud Run 移行 | ✅ ドメイン据え置きで疎通維持 |
| Cloud Load Balancer の静的 IP 取得 | ⏭️ 不要 |
| 県教委への事前ネットワーク連絡 | ⏭️ 不要（ドメイン変更がないため） |
| サブドメイン追加（例: api.school-signage.net） | ⚠️ 別途許可申請が必要になる可能性。**できれば1ドメイン配下で完結させる** |

## 設計への反映

- すべての API・認証エンドポイントを `app.school-signage.net` 配下に統合する
  - 例: `app.school-signage.net/api/...`、`app.school-signage.net/auth/...`
- 外部ドメイン（例: `*.cloudfunctions.net`、`*.run.app`）に直接アクセスさせない
  - Cloud Run のカスタムドメイン設定で `app.school-signage.net` を直接マッピング
- サードパーティ（Sentry、Vertex AI クライアントなど）は**サーバー側経由**にする
  - ブラウザから直接 sentry.io へ送信すると Wi-Fi で弾かれる可能性
  - サーバー側エラーログ → Cloud Logging → Sentry サーバー連携 の経路に

## 関連

- Issue: [#21](https://github.com/cometa-kaito/kimiterrace-v2/issues/21)
- 切替計画: [docs/runbooks/cutover.md](../runbooks/cutover.md) (TBD)
- 制約事項: [docs/requirements/constraints/C01-domain-unchanged.md](../requirements/constraints/C01-domain-unchanged.md) (TBD)
