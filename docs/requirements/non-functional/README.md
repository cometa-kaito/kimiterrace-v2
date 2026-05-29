# 非機能要件索引

[v2-mvp.md](../v2-mvp.md) §5 から分割した個別ファイル。

| ID | タイトル | 一言 |
|---|---|---|
| [NFR01](NFR01-performance.md) | 性能 | API p95 < 500ms、AI 初回トークン < 2s |
| [NFR02](NFR02-availability.md) | 可用性 | SLA 99.5%、Cloud SQL HA、CDN フォールバック |
| [NFR03](NFR03-security.md) | セキュリティ | RLS 強制、MFA、PII マスキング、Secret Manager |
| [NFR04](NFR04-audit-log.md) | 監査ログ | 10 年保管、ホット 1y / コールド 9y、hash chain 改竄検知 |
| [NFR05](NFR05-accessibility.md) | アクセシビリティ | WCAG 2.2 AA、生徒スマホ片手操作 44pt |
| [NFR06](NFR06-cost-policy.md) | コスト方針 | 天井なし + rate limit、月次コストレポート |
| [NFR07](NFR07-compliance.md) | コンプライアンス | 個人情報保護法、文科省 GL、ISMAP 相当、データ越境回避 |

## 関連

- 一本化ドラフト: [v2-mvp.md](../v2-mvp.md)
- 機能要件: [../functional/](../functional/README.md)
- ADR 群: [../../adr/](../../adr/README.md)
- コンプライアンス文書: [../../compliance/](../../compliance/README.md)
