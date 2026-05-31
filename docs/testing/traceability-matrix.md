# Phase 検証 トレーサビリティ行列（横断）

> 要件・脅威 ↔ 検証トラック ↔ ケースID ↔ 状態 の対応を一望する横断表。
> 各ケースの詳細（前提・操作・期待・合否）は各トラック詳細設計に置く。本書は「漏れなく要件が検証対象に割り当たっているか」を保証する。
> 親: [test-strategy.md](test-strategy.md)

最終更新: 2026-05-31 / ステータス: 詳細設計ドラフト（全ケース「設計済・実行待ち」）

## 状態の凡例

| 記号 | 意味 |
|---|---|
| 設計済 | 詳細設計でケース化済み、実行待ち |
| 実行中 | Phase 検証で実行中 |
| pass / fail | 実行結果 |
| 部分 | 一部のみ対象（残りは別トラック or 人間/導入フェーズ） |

トラック詳細:
[①機能受入](tracks/01-functional-acceptance.md) /
[②UI/UX/GUI](tracks/02-ui-ux-gui.md) /
[③セキュリティ・ペネトレ](tracks/03-security-pentest.md) /
[④非機能](tracks/04-non-functional.md) /
[⑤移行・監査・コンプラ](tracks/05-migration-audit-compliance.md)

---

## 1. 機能要件 (F01–F16) → 検証トラック

主担当は ①機能受入。セキュリティ・性能・アクセシビリティの側面は該当トラックが併せて担う。

| 要件 | 内容 | 主トラック / ケース | 併行トラック | 状態 |
|---|---|---|---|---|
| F01 | 教員ファイル抽出 | ① FUN（抽出→構造化導線） | ③ SEC(PII), ② UX | 設計済 |
| F02 | 教員 音声/チャット入力 | ① FUN | ③ SEC(role gate), ② UX | 設計済 |
| F03 | AI 構造化 | ① FUN | ③ SEC(prompt injection/PII), ④ PERF(初回トークン) | 設計済 |
| F04 | 即公開＋安全網 | ① FUN(golden path) | ③ SEC(改竄/即公開固有 P), ④ PERF(公開反映60s) | 設計済 |
| F05 | クラス magic-link | ① FUN(匿名閲覧) | ③ SEC(token予測/漏洩/失効) | 設計済 |
| F06 | 生徒 Q&A | ① FUN | ③ SEC(injection cross-tenant), ④ PERF, ② UX(音声入力) | 設計済 |
| F07 | イベントロギング | ① FUN | ⑤ AUD(記録網羅性) | 設計済 |
| F08 | 効果ダッシュボード | ① FUN | ② UX, ④ PERF | 設計済 |
| F09 | 月次レポート | ① FUN | ⑤ AUD/CMP | 設計済 |
| F10 | CRM | ① FUN | ③ SEC(I-05 school_admin 越境) | 設計済 |
| F11 | ロール管理 | ① FUN(ロール別到達) | ③ SEC(昇格/claims), ⑤ AUD(role_changes) | 設計済 |
| F12 | V1 移植 | ① FUN(V1互換導線) | ② UX, ④ PERF | 設計済 |
| F13 | 在席センサ webhook | ① FUN | ③ SEC(webhook認証) | 設計済 |
| F14 | 天気予報サイネージ | ① FUN | ② UX(サイネージ表示) | 設計済 |
| F15 | TV 端末管理 | ① FUN | ③ SEC(端末認証/mTLS) | 設計済 |
| F16 | TV 死活監視 | ① FUN | ④ RESIL | 設計済 |

---

## 2. 非機能要件 (NFR01–07) → 検証トラック

| 要件 | 内容 | トラック / ケースID | 状態 |
|---|---|---|---|
| NFR01 | 性能 | ④ PERF-001〜005（API p95<500ms / AI TTFT<2s / サイネージ<1.5s / DB p95<100ms / 公開反映≤60s）, LOAD-001〜004 | 設計済 |
| NFR02 | 可用性 | ④ RESIL-001〜005（cold start / DB断 / AIタイムアウト / 部分障害 degrade） | 設計済 |
| NFR03 | セキュリティ | ③ SEC-001〜029（全攻撃面） | 設計済 |
| NFR04 | 監査ログ | ⑤ AUD-001〜008（全mutation記録 / append-only / ハッシュチェーン / AI全件） | 設計済 |
| NFR05 | アクセシビリティ | ② UX-001〜020（WCAG 2.2 AA / 3文脈 × 4観点） | 設計済 |
| NFR06 | コスト方針 | ④ COST-001〜003（負荷時課金が想定内） | 設計済 |
| NFR07 | コンプライアンス | ⑤ CMP-001〜015（文科省GL / ISMAP / 個情法） | 設計済（一部は人間/導入フェーズ） |

---

## 3. 脅威モデル STRIDE → ペネトレケース (③)

[threat-model.md](../architecture/threat-model.md) の全脅威 ID を ③ SEC-001〜029 が網羅。詳細マップは [tracks/03](tracks/03-security-pentest.md) §8。

| STRIDE | 脅威ID | 主な攻撃面 | 影響度 | 状態 |
|---|---|---|---|---|
| Spoofing | S-01〜04 | 認証バイパス / magic_link予測 / claims偽造 | Critical 多 | 設計済 |
| Tampering | T-01〜04 | DB直書換 / リプレイ / SET LOCAL漏れ / 公開改竄 | Critical 多 | 設計済 |
| Repudiation | R-01〜04 | audit_log削除 / チェーン改竄 / AI記録漏れ / role履歴 | Critical/High | 設計済 |
| Info Disclosure | I-01〜07 | RLSバイパス / injection cross-tenant / ログPII / embedding inversion | Critical 多 | 設計済 |
| DoS | D-01〜04 | レート制限 / リソース枯渇 | (③ §4 参照) | 設計済 |
| Elevation | E-01〜04 | 権限昇格経路 | (③ §4 参照) | 設計済 |
| 即公開固有 P | P-01〜02 | 教員即公開判断のプロダクト固有リスク | (③ §4 参照) | 設計済 |

---

## 4. データ移行 → 検証ケース (⑤)

| 観点 | ケースID | 合格条件 | 状態 |
|---|---|---|---|
| 件数突合 / 参照整合 / 型変換 / 冪等 / 欠損 / 移行後RLS | ⑤ MIG-001〜008 | 欠損0 / 重複0 / FK整合100% / 再投入差分0 / 別校混入0 | 設計済 |

---

## 5. カバレッジ自己点検

- [x] 全 F01–F16 に主トラックが割当済
- [x] 全 NFR01–07 にトラック + ケースID 範囲が割当済
- [x] threat-model 全カテゴリ S/T/R/I/D/E/P が ③ にマップ済
- [x] データ移行が ⑤ にマップ済
- [ ] 各ケースの実行・結果記入（Phase 検証 実行時に本表の「状態」列を更新）

> 実行フェーズでは、本表の「状態」列を pass/fail で更新し、fail は [defect-log.md](defect-log.md) に起票する。
