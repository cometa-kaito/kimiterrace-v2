# Embedding 生成における PII マスキング統制

F06（生徒対話チャットボット, RAG）は公開掲示物（`content_versions.snapshot`）から embedding を生成し
pgvector に永続する（ADR-007）。**embedding への PII 焼き込みは「Vertex AI への事実上の外部委託 +
永続化」**にあたり、一度焼き込むと回収が困難なため、生 PII を Vertex へ送らない多層防御を敷く
（CLAUDE.md ルール4 / NFR03 / NFR04）。

本書はその統制の現状・カバレッジ・残存リスク・運用手順をまとめ、調達審査（個人情報の流れの説明）と
インシデント時の影響範囲特定に供する。関連: `data-flow-diagram.md`, `vendor-management.md`（Vertex AI 委託）。

## 多層防御（defense-in-depth）

embedding 生成バッチ（`apps/jobs/src/embedding/`、#398/#411/#415/#417）は、テキストを Vertex へ送る前に
以下を順に通す:

1. **確定マスク（roster 由来）** — `maskPII(text, maskEntries)`（#417/#424）
   - `maskEntries` は校スコープの**職員氏名 roster**（`listStaffDisplayNames`、school_admin RLS context で
     自校のみ取得。他校氏名は RLS が構造的に遮断）を `PiiEntry`(STAFF) 化したもの。
   - 該当氏名を `{{STAFF_001}}` 形のトークンへ置換する。
2. **パターン検出** — `maskPII` の正規表現（電話・メール）でトークン化。
3. **fail-closed ゲート** — `findUnmaskedPii(masked, maskEntries)`（#394 Reviewer L3 / #417/#424）
   - マスク後も検出可能な PII（roster 漏れの該当氏名・未対応書式の電話/メール）が残る version は
     **Vertex へ送らず skip** し、件数を `blockedUnmaskedPii` に計上する（バッチ全体は止めない）。
   - `findUnmaskedPii` は `maskOptions` の検出 ON/OFF に**無関係に**電話・メール書式を常時検査するため、
     上流マスク設定を誤っても歯止めになる（embedding は永続するため fail-closed を選好）。

> マスキング → embedding 生成の順序は不変条件（`embedPendingContent`）。テストで pin 済
> （`apps/jobs/src/embedding/__tests__/embed-content.test.ts`、`packages/db/__tests__/rls/users-staff-names.test.ts`）。

## カバレッジ・マトリクス

| PII 種別 | マスク手段 | 状態 |
|---|---|---|
| 職員氏名（教員 / 学校管理者） | roster 確定マスク（自校スコープ） | ✅ マスク |
| 電話番号 | `maskPII` 正規表現 + `findUnmaskedPii` ゲート | ✅ マスク / 残存は skip |
| メールアドレス | `maskPII` 正規表現 + `findUnmaskedPii` ゲート | ✅ マスク / 残存は skip |
| **生徒・保護者の氏名（本文に生で記載）** | — | ⚠️ **未カバー**（下記残存リスク） |

## 残存リスク（生徒・保護者氏名）

生徒・保護者は**匿名設計**（#289 / ADR-003 / ADR-016: 生徒は個別アカウント非保有・magic link 匿名アクセス、
保護者は Phase 2）のため、「学校が保持する正規氏名 roster」の**源泉が構造的に存在しない**。よって:

- 掲示物本文に**生で書かれた**生徒/保護者氏名は確定マスクの対象外。
- 氏名は電話/メールのような書式 PII でないため `findUnmaskedPii` でも捕捉されない。
- → マスクされず Vertex に渡り、embedding に焼き込まれうる。

これは embedding バッチ固有ではなく、`packages/ai` のマスキング設計全体（F03 authoring 時の
`structure.ts` も同様）が共有する既知の限界。

### 受容と緩和（informed acceptance）

| 区分 | 内容 |
|---|---|
| 運用ポリシー | F06 は**掲示物 Q&A 限定**。掲示物は職員が curate するものとし、**個別生徒の PII を本文に記載しない**ことを運用規程に明記する（`personal-info-handling-rules.md` へ反映予定）。|
| 監視 | `blockedUnmaskedPii > 0` を Cloud Logging で WARN ログ化し、書式 PII の残存兆候を検知（生氏名は対象外だが roster 欠落の早期警告になる）。下記 runbook 参照。|
| 残対策（follow-up） | authoring 時の入力ガード（掲示物作成 Server Action で氏名らしき文字列を warn/block）または日本語人名 NER の導入。**issue #426** で追跡。|

## 運用 runbook: `blockedUnmaskedPii > 0`

embedding バッチ（Cloud Run Job `embed-job`）は完了サマリを構造化ログ（`event: embedding.batch.done`）で出し、
**`blockedUnmaskedPii > 0` の場合は WARN（`event: embedding.batch.pii_blocked`）を追加で出す**。

1. WARN を検知したら、該当校の roster（職員氏名）に欠落が無いか確認（`listStaffDisplayNames` が返す範囲）。
2. 新しい PII 書式（既存正規表現が拾えない電話/メール表記）の出現を疑う場合は `@kimiterrace/ai` の
   検出器（`maskPII` / `findUnmaskedPii`）に書式追加を検討。
3. skip された version は embedding 未生成のまま残り、**次回バッチで再処理**される（冪等）。原因解消後の
   再実行で回収できる。生 PII が Vertex へ渡っていないことが fail-closed の主目的であり、未生成のまま
   放置されても漏洩は発生しない。

## 関連

- CLAUDE.md ルール4（PII の Vertex AI 送信前マスキング）/ NFR03（セキュリティ）/ NFR04（監査）
- ADR-007（pgvector / embedding）/ ADR-019（RLS 二層）/ ADR-003・ADR-016（生徒匿名設計）
- 実装: #394（`embedPendingContent` / `EmbeddingBatchPort`）、#411/#415（バッチ）、#417/#424（roster + gate）
- follow-up: #426（authoring 時 生徒氏名ガード / NER）、#289（生徒匿名設計）
