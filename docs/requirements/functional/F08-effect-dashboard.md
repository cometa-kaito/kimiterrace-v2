# F08: 効果可視化ダッシュボード + AI 効果コメント自動生成

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §4 から分割）
- 関連 ADR: ADR-005 (Vertex AI), ADR-014 (Observability)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

学校別・コンテンツ別の閲覧・タップ・滞留・Q&A 件数を可視化。AI が「先週比 30% 増、特に体育祭関連の Q&A が多い」のような自然言語コメントを自動生成。

## ユーザーストーリー

- **校務管理者として**、どのコンテンツが効果的か数値で知りたい。
- **システム管理者として**、広告主向け月次レポートの素材を効率的に集めたい。
- **教員として**、自分が出した連絡がどれだけ見られたかフィードバックを受けたい。

## 受け入れ条件

- [ ] ダッシュボード（school_admin / teacher 閲覧、school_id スコープ）
- [ ] system_admin 用 cross-tenant ビュー
- [ ] AI コメントは月次バッチで生成、PII マスキング適用
- [ ] グラフ: 時系列、コンテンツ別ランキング、Q&A 件数
- [ ] **人感センサー検知の時間帯別ヒートマップ**（5/15 分バケット × 平日/休日、データ源 `events.type='presence'`）。詳細仕様は [F13 §3.2](F13-presence-sensor-webhook.md) を参照
- [ ] 「カメラ非使用」バッジを常時表示（[ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md) 公開透明性）
- [ ] 旧 LiDAR 由来の「滞留時間ヒートマップ」は **採用しない**。PIR 方式は瞬間検知のため滞留秒数は計測できない（[ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md) トレードオフ参照）
- [ ] グラフは Recharts または Visx を採用（React Server Component で SSR 描画）
- [ ] WCAG 2.2 AA（[NFR05](../non-functional/NFR05-accessibility.md)）に従い、色だけに依存しない凡例

## 関連

- 前段: [F07 (イベントログ)](F07-event-logging.md)
- 後段: [F09 (月次レポート)](F09-monthly-report.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md)（system_admin cross-tenant は RLS 経由）
- テスト: `__tests__/ui/dashboard/`, `__tests__/ai/effect-comment/`
