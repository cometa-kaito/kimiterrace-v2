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

### 2.1 Entry ゲートの現状と段階実行（2026-06-03 追記）

全16機能の feature 実装は完了したが（[STATUS](../STATUS.md)、#556）、**Entry ゲートの「staging が feature-complete で動作」は現時点で未充足**:

- [infrastructure/terraform/envs/staging/main.tf](../../infrastructure/terraform/envs/staging/main.tf) は全モジュール `enabled = false`（雛形＝実体未生成）。
- staging への Cloud Run デプロイ経路（CI ワークフロー）が未整備。
- → staging の Cloud SQL / Vertex 実呼び出し / デプロイ済への DAST / k6 負荷を**前提とする検証は staging が立つまで実行できない**。staging 構築（Terraform `enabled=true` + デプロイ）は **infra デプロイ＝ルール8 の人間/CI ゲート**であり、検証フェーズの前段。

**段階実行**: 検証トラックを「staging 必須」と「ローカル統合環境で前倒し可能」に仕分け、後者を staging 構築を待たず先行する。ローカル統合環境 = 既存 e2e の **実 PG（非 BYPASSRLS）+ Auth emulator**（[playwright.config.ts](../../apps/web/playwright.config.ts) / [global-setup.ts](../../apps/web/e2e/global-setup.ts)）。

| トラック | ローカル統合で前倒し可 | staging が律速（後段） |
|---|---|---|
| ① 機能受入 | 受入 e2e 拡張・ロール別到達性（実 PG + emulator） | Vertex 実呼び出しの通し、デプロイ反映時間 |
| ② UI/UX | axe-core / Lighthouse / 視覚回帰 / ブラウザ ウォークスルー（`next start`） | 実機解像度・実回線（→ 導入フェーズ） |
| ③ セキュリティ | RLS 拡張・LLM injection・認可マトリクス・JWT 攻撃・SQLi（実 PG） | デプロイ済への DAST、GCS IAM、Cloud Logging PII、組織ポリシー |
| ④ 非機能 | （ローカルは Cloud Run 挙動を再現しない＝原則不可） | 性能/負荷/cold start/failover/コスト = **全面 staging 必須** |
| ⑤ 移行・監査・コンプラ | 移行 dry-run 突合・監査網羅・append-only・ハッシュチェーン・AI 全件（実 PG） | asia-northeast1 固定 / Vertex opt-out 等の実設定証跡 |

→ **③⑤の大半と①②は staging を待たず着手できる**。staging が本質的に律速するのは④と③の DAST 系のみ。

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

### 6.1 並列実行の chokepoint と直列化規律

「トラック別に並列 spawn」は**並列の単位を誤ると衝突する**。並列の単位は「トラック」ではなく「**統合環境（staging or 統合 DB）を破壊的に占有するか否か**」で切る。[parallel-lanes.md](../parallel-lanes.md) のファイル所有境界 × chokepoint トークンを検証フェーズに適用する。

**4 つの chokepoint と規律**:

| chokepoint | 衝突理由 | 規律 |
|---|---|---|
| **単一 staging / 統合 DB**（最大） | ③の破壊的攻撃（トリガ DISABLE・`audit_log` への UPDATE/DELETE 試行・連投）、④の負荷/failover/エラー注入、⑤ MIG の DB リセットが**同一環境を同時に叩くと相互汚染**（③のトリガ無効化中に⑤が監査チェーン検証＝誤判定、④負荷中の①/④測定＝flaky） | **env トークン**（[parallel-lanes.md](../parallel-lanes.md) の infra-token 同思想）で破壊的トラックを排他・直列化。非破壊 read 主体は並列可 |
| **k6 二重利用** | ③ SEC-021〜023（DoS 遮断攻撃）と ④ LOAD/COST が同一環境に負荷＝測定が混ざる（③ §11 / ④ §7 が「分担未決」と認識するも未解決） | env トークン下で直列。k6 シナリオは共有し責務分離（③=遮断の有効性 / ④=課金線形性） |
| **共有合成シード** | ①§7・③§3・⑤§5 が `global-setup.ts` を各自拡張＝loader 配列 + RLS 真実ソースが [parallel-lanes.md](../parallel-lanes.md) の schema-token chokepoint | **先に 1 レーンで受入用合成シードを land → 各トラックは read のみ**（migration-loader-pattern 厳守） |
| **共有台帳** | matrix（状態列）/ defect-log（起票）/ go-no-go（寄稿）を全 5 トラックが更新＝`STATUS.md` ヘッダ上書きレースと同型 | 欠陥は **GitHub Issue 駆動**（defect = issue、状態 = PR/issue）。markdown 台帳は**実行完了後の集約スナップショット**に役割を限定 |

**並列可 / 直列の仕分け**:

- **並列可（非破壊・read 主体、env トークン不要）**: ② UI/UX、⑤ CMP（証跡収集）、①の read 系シナリオ、③④⑤の**実装・スクリプト整備**段階（攻撃/負荷/突合コードを書く）。
- **直列必須（env トークン保持時のみ実行）**: ③の破壊的攻撃**実行**、④の負荷・障害注入**実行**、⑤ MIG の投入/リセット**実行**。同時 1 トラックが env を占有し、終わったら解放して次へ。
- ローカル統合環境（§2.1）なら**トラックごとに使い捨て DB を分けて並列**できる（単一 staging より並列度が出る＝前倒しの利点）。

→ 「トラックを並列 spawn」の前に、**そのトラックが env を破壊的に占有するか**を判定し、占有するものは env トークンで直列化する。これを欠くと並列起動が相互汚染で flaky になる。

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
