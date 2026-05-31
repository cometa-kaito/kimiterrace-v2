# Phase 検証 go/no-go レポート（Exit ゲート）

> Phase 検証の最終成果物。5 トラックの結果を集約し、Phase 導入（人間担当）へ進んでよいかの判断材料を人間に提出する。
> **判断主体は人間**。Claude は証跡を揃え、推奨を添えるところまで。
> 親: [test-strategy.md](test-strategy.md) / 欠陥: [defect-log.md](defect-log.md) / 行列: [traceability-matrix.md](traceability-matrix.md)

最終更新: 2026-05-31 / ステータス: 雛形（実行前。判定は未確定）

---

## 1. Entry ゲート確認（実行開始の前提）

- [ ] staging が feature-complete（全 F01–F16 が staging で動作）
- [ ] データ移行 dry-run が staging で回る
- [ ] CI 自動スキャン（Semgrep / CodeQL / gitleaks / Dependabot / RLS）が継続 green
- [ ] 環境は staging 限定・合成データのみであることを確認

---

## 2. トラック別 合否サマリ

各トラックの詳細合否基準は各詳細設計の「合否基準」節を参照。

| トラック | Exit 合格条件（要約） | 結果 | ブロッカー有無 |
|---|---|---|---|
| ① 機能受入 | golden path 全 pass / ロール別到達・代表 deny 全 pass / 各 F 主要受入条件トレース済 / セキュリティ直結の重大欠陥 open 0 | _未_ | _未_ |
| ② UI/UX/GUI | 3文脈 axe-core で critical/serious 0 / キーボード完遂 / 24px・コントラスト・44pt・縦横・reduced-motion 充足 / 手動SR 主要3画面OK | _未_ | _未_ |
| ③ セキュリティ・ペネトレ | **Critical 0 かつ High 0（ゲートブロッカー）** / Critical 脅威対応ケース全 pass(=攻撃失敗) / 全欠陥 defect-log 追跡 | _未_ | _未_ |
| ④ 非機能 | 性能5閾値 達成 / 負荷4プロファイル完走（スパイク 5xx 0）/ レジリエンス degrade 成立 / コスト線形 | _未_ | _未_ |
| ⑤ 移行・監査・コンプラ | 移行: 欠損0/重複0/整合100%/冪等 / 監査: 記録漏れ0/append-only/チェーンpass/AI全件 / コンプラ: 全項目に証跡or人間タスク化 | _未_ | _未_ |

---

## 3. 全体ゲート判定基準

**go の必要条件（すべて満たす）**:

1. ③ セキュリティ: Critical = 0 かつ High = 0（[defect-log §4](defect-log.md) で確認）
2. ⑤ 監査: 記録漏れ 0 / append-only 物理強制 / ハッシュチェーン整合 / AI 全件記録
3. ⑤ 移行: 欠損 0 / 重複 0 / 別校混入 0 / 移行後 RLS 有効
4. ① 機能: golden path 全 pass、セキュリティ直結の重大欠陥 open 0
5. ② UI/UX: axe-core critical/serious 0
6. ④ 非機能: 性能5閾値達成、スパイクで 5xx 0、レジリエンスでハング/全断波及なし
7. 残存 Medium/Low はすべて [defect-log.md](defect-log.md) で追跡され、go-with-conditions のものはフォロー issue 化済（隠蔽ゼロ）

**no-go 直結（1件でも該当で no-go）**:

- Critical または High の脆弱性が open
- テナント越境（cross-tenant 読み/書き）が再現
- 監査ログの記録漏れ / append-only 破れ / ハッシュチェーン不整合
- データ移行で欠損・重複・別校混入
- 非機能のブロッキング（スパイク 5xx / レジリエンスでハング / サイネージ白画面）

---

## 4. 判定（実行完了時に記入）

- 総合判定: ☐ go ／ ☐ go-with-conditions ／ ☐ no-go
- 判定日:
- 判定根拠（上記 §3 への対応）:

### 既知制約（go-with-conditions の場合に列挙）

| # | 内容 | 影響度 | 暫定回避 | フォロー issue |
|---|---|---|---|---|

---

## 5. Phase 導入（人間）への引き継ぎ事項

Phase 検証の Claude 範囲外で、導入フェーズに人間が担う残課題:

- 第三者による正式（外部）ペネトレ認証の要否・手配（③ 内部ペネトレ結果を入力として渡す）
- 実機・実環境での確認（岐南工業フィールド、本番サイネージ視認、実生徒端末）
- 本番負荷試験・本番 SLO の最終判断（④）
- 本番データでの移行実行（⑤ は合成データ dry-run まで）
- 最終法務・コンプラ判断、DPA・個人情報取扱規程・サイバー保険・委託先管理（⑤ CMP）

---

## 6. 添付・証跡

- トレーサビリティ行列: [traceability-matrix.md](traceability-matrix.md)
- 欠陥ログ: [defect-log.md](defect-log.md)
- 各トラック実行ログ / axe レポート / Lighthouse スコア / 負荷試験結果 / ペネトレ結果（実行時に添付）
