# Phase 検証（受入テスト）戦略 — 大枠設計

> このドキュメントは「開発」と「導入」の間に新設する **Phase 検証** の大枠設計。
> 個別テストケース・閾値・スクリプトは本書では確定せず、各トラックの詳細設計に委ねる。
> 関連: [ROADMAP.md](../ROADMAP.md) / [CLAUDE.md](../../CLAUDE.md) / [STATUS.md](../STATUS.md)

最終更新: 2026-05-31
ステータス: **大枠合意済（詳細設計はこれから）**

---

## 1. なぜ新フェーズが要るか

このプロジェクトは **開発フェーズ内に既に厚いテストが埋め込まれている**（shift-left）。
新しく必要なのは、それら PR 単位のテストでは捕まえられない、**統合された staging に対する
“システム横断・敵対的・要件トレーサブル”な受入ゲート**である。

| 既にあるもの（開発フェーズ内・PR 単位） | 場所 |
|---|---|
| RLS テスト（テナント越境・許可/拒否） | [packages/db/\_\_tests\_\_/rls/](../../packages/db/__tests__/rls/) |
| API / Server Action / component テスト | [apps/web/\_\_tests\_\_/](../../apps/web/__tests__/) |
| AI（PII マスキング・プロンプトインジェクション・抽出） | [packages/ai/src/\_\_tests\_\_/](../../packages/ai/src/__tests__/) |
| E2E golden path（Playwright + 実 PG + Auth emulator） | [apps/web/playwright.config.ts](../../apps/web/playwright.config.ts) |
| CI セキュリティ自動スキャン | [.github/workflows/security.yml](../../.github/workflows/security.yml)（gitleaks / Semgrep / CodeQL / Dependency Review） |

→ **Phase 検証はこの上に積む「受入ゲート」**であって、既存テストの二重化ではない。

---

## 2. ロードマップ上の位置づけ

```
調査 → 設計 → 開発 → 【検証（受入テスト）】 → 導入
                       ↑ 新設・Claude Code 主導   ↑ 人間担当（不変）
```

- **Entry ゲート**: staging が feature-complete（全 F0–F16 が staging で動作、データ移行 dry-run が回る状態）。
- **Exit ゲート**: 後述 5 トラックが合格基準クリア → 人間へ go/no-go レポート提出 → 導入へ。
- **環境**: **staging 限定・合成データのみ**。実生徒データ・本番投入での試験は禁止（CLAUDE.md ルール4 / セキュリティ最優先）。
- **期間目安**: 1.5〜2 週（開発フェーズ末尾と一部オーバーラップ可）。

---

## 3. テストトラック（5 本）

各トラックは「欠陥を見つけて終わり」ではなく、**Claude の開発権限内で
修正 PR → Reviewer（別 spawn）→ 再検証** までクローズする（busy CEO の自律 merge 範囲）。

### ① 機能受入テスト（Functional / System Acceptance）
- **目的**: F01–F16 と V1 互換が、統合 staging で端から端まで成立することを確認。
- **やること**: 要件 ↔ シナリオ ↔ 合否の **トレーサビリティ行列**を作り、Playwright e2e を受入シナリオへ拡張。
- **トレース元**: [docs/requirements/functional/](../requirements/functional/) の各 `F*.md`。

### ② UI/UX/GUI テスト
- **目的**: 3 つの利用文脈（**サイネージ TV / 教員管理画面 / 生徒スマホ**）で使えること。
- **やること**: 実ブラウザでの操作ウォークスルー、アクセシビリティ（WCAG 2.2 AA）、視覚回帰、レイアウト崩れ検証。
- **ツール**: Claude in Chrome / Preview MCP（UI 検証用途で利用許可済）、axe-core、Lighthouse。
- **トレース元**: [NFR05-accessibility](../requirements/non-functional/NFR05-accessibility.md)。

### ③ セキュリティ・ペネトレーションテスト
- **目的**: 敵対的視点で攻める。テナント越境・ロール昇格・magic-link 濫用・
  **プロンプトインジェクション / PII 漏洩**・認可バイパス・OWASP Top 10。
- **やること**: DAST（OWASP ZAP 等）+ 敵対テストスクリプト + 既存 RLS スイート拡張を、
  [threat-model.md](../architecture/threat-model.md) の STRIDE 項目と突き合わせる。
- **トレース元**: [threat-model.md](../architecture/threat-model.md) / [NFR03-security](../requirements/non-functional/NFR03-security.md)。
- **位置づけ**: 第 5 節の「ペネトレ方針の更新」を参照。

### ④ 非機能テスト
- **目的**: 性能・負荷・可用性・コストが要件を満たすこと。
- **やること**: 負荷試験（k6 / autocannon）、障害注入、Cloud Monitoring での観測、コスト想定の検算。
- **トレース元**: [NFR01-performance](../requirements/non-functional/NFR01-performance.md) /
  [NFR02-availability](../requirements/non-functional/NFR02-availability.md) /
  [NFR06-cost-policy](../requirements/non-functional/NFR06-cost-policy.md)。

### ⑤ 移行・監査・コンプライアンス検証
- **目的**: データ移行の正当性、監査ログの網羅性、文科省GL / ISMAP チェック。
- **やること**: 移行 dry-run の突合検証、`audit_log` の網羅性確認、コンプラ チェックリスト消化。
- **トレース元**: [NFR04-audit-log](../requirements/non-functional/NFR04-audit-log.md) /
  [NFR07-compliance](../requirements/non-functional/NFR07-compliance.md)。

---

## 4. Claude にできること / 人間に残すこと

| 区分 | 内容 |
|---|---|
| **Claude 主導** | 上記 5 トラックの自動化・敵対テスト・修正ループ。トラック別サブエージェント並列 + Reviewer 別 spawn（客観性）+ worktree 隔離。 |
| **人間 / 外部に残す** | ① ISMAP 等で要る**第三者による正式ペネトレ認証**、② **実機・実環境**での検証（岐南工業フィールド、本番負荷）、③ 本番データ・本番デプロイに対する一切のテスト。 |

---

## 5. ペネトレ方針の更新（2026-05-31）

旧 ROADMAP は「ペネトレは 2027 実施に延期（確定）、開発内は CI 自動スキャンで代替」としていた。
ユーザー判断（2026-05-31）により以下へ更新:

- **Phase 検証で Claude Code 駆動の内部ペネトレ（敵対的セキュリティテスト）を導入前ゲートとして実施する。**
- 第三者による**正式（外部）ペネトレの要否・時期は見直し**とする（旧「2027 確定」は撤回）。
- Claude の内部ペネトレは、外部第三者ペネトレ認証の**代替ではなく前段**。認証が要る場合は人間が別途手配。

---

## 6. 実行体制（busy CEO オーケストレーション）

- Desktop Claude が orchestrator + Worker を兼任。トラック別に Worker/Agent を並列 spawn。
- **Reviewer は必ず別 spawn**（self-review 制約 + 客観性、[CLAUDE.md] worker-review-discipline）。
- 検出欠陥は defect-log に集約 → 修正 PR → Reviewer → 再検証で閉じる。
- 最終 Exit はトラック横断の **go/no-go レポート**として人間へ提出。

---

## 7. 成果物（このディレクトリの構成）

```
docs/testing/
├── test-strategy.md          # 本書（大枠）
├── tracks/
│   ├── 01-functional-acceptance.md      # ① 機能受入（FUN-001〜023）
│   ├── 02-ui-ux-gui.md                  # ② UI/UX/GUI（UX-001〜020）
│   ├── 03-security-pentest.md           # ③ セキュリティ・ペネトレ（SEC-001〜029、STRIDE 対応）
│   ├── 04-non-functional.md             # ④ 非機能（PERF/LOAD/RESIL/COST）
│   └── 05-migration-audit-compliance.md # ⑤ 移行・監査・コンプラ（MIG/AUD/CMP）
├── traceability-matrix.md    # 要件・脅威 ↔ トラック ↔ ケースID ↔ 状態（横断）
├── defect-log.md             # 検出欠陥 → 修正 PR → 再検証 追跡（実行時）
└── go-no-go-report.md        # 導入判断用 最終レポート（Exit ゲート）
```

**詳細設計は完了**（各トラックに代表ケース・合否基準・トレーサビリティ・Claude/人間境界を記載）。
個別テストケースの全列挙・実値・スクリプトは Phase 検証の**実行時**に各トラックを起点に展開する。
