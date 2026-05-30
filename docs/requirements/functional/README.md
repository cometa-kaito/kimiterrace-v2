# 機能要件索引

[v2-mvp.md](../v2-mvp.md) §4 から分割した個別ファイル。

| ID | タイトル | 一言 |
|---|---|---|
| [F01](F01-teacher-file-extraction.md) | 教員ファイル抽出入力 | PDF/Word/Excel/画像をアップロードして AI 構造化 |
| [F02](F02-teacher-voice-chat-input.md) | 教員音声 / チャット入力 | 立ち話のような音声・テキスト入力から構造化 |
| [F03](F03-ai-structuring.md) | AI 構造化 | Vertex AI Gemini で構造化 JSON 生成、confidence_score 必須 |
| [F04](F04-instant-publish-safety-nets.md) | 即公開 + 安全網 4 種 | 承認なし即公開 / audit_log・rollback・確信度・公開先明示 |
| [F05](F05-class-magic-link.md) | クラス magic link | クラス単位 1 つの匿名アクセス URL（90 日デフォルト） |
| [F06](F06-student-qa.md) | 生徒対話 | 掲示物 Q&A 限定、RAG + プロンプトインジェクション対策 |
| [F07](F07-event-logging.md) | イベントロギング | view/tap/dwell/ask を全件記録、LiDAR と統合 |
| [F08](F08-effect-dashboard.md) | 効果ダッシュボード | 可視化 + AI 効果コメント自動生成 |
| [F09](F09-monthly-report.md) | 月次レポート | PDF 生成、手動配布（自動配信なし） |
| [F10](F10-crm.md) | CRM | 広告主・契約・コミュニケーション履歴、system_admin のみ |
| [F11](F11-role-management.md) | ロール管理 | system_admin / school_admin / teacher 階層 |
| [F12](F12-v1-port.md) | V1 機能移植 | 管理 UI・サイネージ表示・LiDAR を Cloud Run へ |
| [F13](F13-presence-sensor-webhook.md) | 来場検知 Webhook | SwitchBot 人感センサ(PIR) Webhook 受信＋集計＋センサ管理UI ([ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md)) |
| [F14](F14-weather-forecast-signage.md) | サイネージ天気予報 | 気象庁(JMA)無料APIをバックエンドJobで取得しキャッシュ、端末は自校DBから表示（外部直叩きなし）([ADR-021](../../adr/021-weather-data-source-jma.md)) |
| [F15](F15-tv-device-management.md) | TVデバイスリモート管理 | Google TV へのポーリング型リモート設定 + 管理画面 ([ADR-022](../../adr/022-tv-remote-config-polling.md)) |
| [F16](F16-tv-uptime-monitoring.md) | TV死活・起動監視 | ポーリング心拍(last_seen)のギャップを定期チェッカで判定し、ダウン/復帰/再起動を通知＋ダウンタイム記録 ([ADR-023](../../adr/023-tv-liveness-monitoring-alerting.md)) |

## 優先度

[v2-mvp.md](../v2-mvp.md) では全 F01-F12 が MVP スコープ。
実装順序の議論は次タスク（Issue 化 + 優先順位付け）で行う。

## テンプレート

新規 F を追加する場合は [../README.md](../README.md) のテンプレートに従う。

## 関連

- 一本化ドラフト: [v2-mvp.md](../v2-mvp.md)
- 非機能要件: [../non-functional/](../non-functional/README.md)
- ADR 群: [../../adr/](../../adr/README.md)
