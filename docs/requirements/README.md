# 要件定義

## 構成

- `functional/` — 機能要件 F01〜FNN
- `non-functional/` — 非機能要件 NFR01〜NFRNN
- `constraints/` — 制約事項 C01〜CNN

## 命名規則

- `F01-school-management.md`（機能要件）
- `NFR01-performance.md`（非機能要件）
- `C01-domain-unchanged.md`（制約）

## テンプレート

各要件ファイルは以下のセクションを必須:

```markdown
# F01: 学校管理

## 概要
何を実現するか。

## ユーザーストーリー
- ロール「〜」として、「〜」したい。なぜなら「〜」だから。

## 受け入れ条件
- [ ] 検証可能な条件

## 関連
- 関連 ADR
- 関連 issue
- 関連テスト
```
