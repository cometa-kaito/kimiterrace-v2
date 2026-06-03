# ADR-030: 掲示物 authoring 時の生徒/保護者氏名（ロスター無し PII）検出ガード方針

- 状態: Accepted（2026-06-03）
- 日付: 2026-06-02（Proposed）／ 2026-06-03（Accepted: 検出器 #474 + publish soft-gate 配線で実装着地）
- 関連: [#426](https://github.com/cometa-kaito/kimiterrace-v2/issues/426), [#417](https://github.com/cometa-kaito/kimiterrace-v2/issues/417) / [PR #424](https://github.com/cometa-kaito/kimiterrace-v2/pull/424), [#289](https://github.com/cometa-kaito/kimiterrace-v2/issues/289), [ADR-003 Identity Platform](003-identity-platform.md), [ADR-007 pgvector](007-pgvector.md), [ADR-016 magic link 匿名アクセス](016-class-magic-link-anonymous-access.md), [ADR-028 F06 プロンプト/分類器], [F03 AI 構造化](../requirements/functional/F03-ai-structuring.md), [F06 生徒対話](../requirements/functional/F06-student-chat.md), [`docs/compliance/embedding-pii-masking.md`](../compliance/embedding-pii-masking.md), [CLAUDE.md ルール4], NFR03 / NFR04

## 文脈

[ADR-007] の F06 RAG は公開掲示物（`content_versions.snapshot`）から embedding を生成し pgvector に永続する。
embedding への PII 焼き込みは「Vertex AI への事実上の外部委託 + 永続化」（ルール4）であり、一度焼き込むと
**回収困難**なため、生 PII を Vertex へ渡さない多層防御を敷いている（[`embedding-pii-masking.md`](../compliance/embedding-pii-masking.md)）。

現在のマスキング能力（`packages/ai/src/pii/mask.ts`）:

| 手段 | 対象 | 仕組み |
|---|---|---|
| `maskPII(text, entries)` の **確定マスク** | ロスター由来の確実な氏名（`PiiEntry`、category `STAFF`/`STUDENT`/`GUARDIAN`） | 校スコープ roster の表記を最長一致でトークン化 |
| `maskPII` の **パターン検出** | 電話・メール（半角/全角） | 上限付き正規表現（ReDoS 不能） |
| `findUnmaskedPii(text, entries)` の **fail-closed ゲート** | 上記の残存 | マスク後に roster 表記 + 電話/メール書式が残れば検出 → embedding バッチは当該 version を skip |

### 残存リスク（#426）

生徒・保護者は **匿名設計**（[#289] / [ADR-003] / [ADR-016]: 生徒は個別アカウント非保有・magic link 匿名アクセス、
保護者は Phase 2）であり、「学校が保持する正規氏名 roster」の**源泉が構造的に存在しない**。
`PiiCategory` に `STUDENT`/`GUARDIAN` は型として在るが、それを満たす `PiiEntry[]` を供給する roster が無い。

したがって、掲示物本文に**生で書かれた**生徒/保護者氏名（例: 「田中さんが県大会で優勝」）は:

- 確定マスクの対象外（roster に無い）
- 電話/メールのような書式 PII でないため `findUnmaskedPii` でも捕捉されない
- → マスクされず Vertex に渡り、embedding に焼き込まれうる（ルール4 の残存リスク）

これは embedding バッチ固有でなく、`packages/ai` のマスキング設計全体（F03 authoring 時の `structure.ts` も同様）が
共有する既知の限界。[PR #424] Reviewer が Low-1 として follow-up（本 ADR + #426）を推奨した。

### 現状の緩和（実在）

- 運用ポリシー上、掲示物は**職員が curate**し個別生徒 PII を載せない想定（F06 は掲示物 Q&A 限定）。
- 書式 PII の残存兆候は `blockedUnmaskedPii` カウンタで監視可能（生氏名は対象外）。

緩和はあるが、**authoring 経路に技術的な歯止めが無い**点が #426 の要求。embedding バッチ（下流）で止めるより
**authoring（上流）で止める**方が根本的（焼き込み前に検出でき、F06 以外の将来用途にも効く）。

## 候補

| 候補 | 概要 | FP/UX | コスト | 残存リスク |
|---|---|---|---|---|
| **A. 何もしない（現状維持）** | 運用ポリシー + 下流監視のみ | なし | 0 | 生氏名が焼き込まれうる（#426 未解決） |
| **B. 決定論ヒューリスティック soft-gate** | publish 経路で**敬称連接パターン**（氏名らしきトークン + さん/君/くん/ちゃん/様 等）等の高確信パターンを検出し、検出時は **warn + 明示 override + 監査記録**を要求 | 低 FP（敬称連接に限定）/ 投稿者が override 可 | 低（純関数 + 既存 publish 経路に gate） | 敬称無しの生氏名は残る（Low、ポリシーで補完） |
| C. ML 日本語人名 NER | `findUnmaskedPii` 相当に NER を追加 | 中〜高 FP（一般語の人名誤検出）/ 要計測 | 中〜高（モデル/辞書 + 推論コスト + レイテンシ） | 低だが FP が authoring を阻害 |
| D. hard-block | 検出時に publish を**不可**にする | FP で正当な掲示を阻害（教員が回避策に走る） | 低 | 低だが運用破綻リスク |

## 決定（提案）

**B（決定論ヒューリスティック soft-gate）+ コンテンツポリシー強化**を採用する。C（ML-NER）は **FP/コストを計測した上で判断する follow-up** とし、本 ADR では採用しない。

1. **authoring 経路の検出ガード（soft-gate）**: 掲示物 publish の Server Action（`packages/db/src/queries/contents-publish.ts`
   の `publishContent` / `updateContent` / `rollbackContent` が `content_versions` 行を追記する。その**呼び出し元 apps/web Server Action**）で、
   本文に対し**決定論的な高確信パターン**を走査する。同じマスキング限界を共有する F03 AI 構造化の authoring 経路
   （`packages/ai/src/structure.ts`）にも同 gate を適用する範囲はコードスライスで確定する。
   - 初期パターンは **敬称連接**（人名らしき直前トークン + `さん`/`くん`/`君`/`ちゃん`/`様`/`先生` 以外の個人指示）に限定し、
     一般語の誤検出を抑える。パターンは `packages/ai`（純関数・ReDoS 不能・テスト pin）に置き、`maskPII` と同じ
     防御規律に従う。F06 は多言語対応（ADR-028）のため、敬称/呼称パターンは主要外国語へ拡張可能な構成とし、
     言語別パターンの初期カバレッジはコードスライスで確定する。
   - 検出時は **warn**（どの箇所が疑わしいか提示）し、投稿者の**明示的な override 操作**を求め、override を
     `audit_log` に記録する（ルール1・NFR04: 「誰が PII 含有を承知で公開したか」を立証可能に）。**hard-block しない**
     （FP で正当な掲示を阻害し回避策を誘発するため。D 却下）。
2. **コンテンツポリシー強化**: 「公開掲示物に個別生徒/保護者の氏名・特定可能情報を載せない」を明文の規約とし、
   `docs/compliance/`（`personal-info-handling-rules.md` 予定 / 当面は [`embedding-pii-masking.md`](../compliance/embedding-pii-masking.md) と本 ADR）に明記。
   authoring UI にも注意喚起を表示。
3. **多層防御の位置づけ**: 本 gate は embedding バッチの fail-closed（`findUnmaskedPii`）の**上流の追加層**であり、
   下流ゲートを置換しない。authoring で override された/敬称無しで漏れた生氏名は、依然 embedding 焼き込みの
   残存リスク（Low）として [`embedding-pii-masking.md`](../compliance/embedding-pii-masking.md) のマトリクスに残る。

### なぜ warn(soft) で block(hard) でないか

データは高機微（10 年保管・公立校生徒）で安全側に倒したいが、ロスター無しの人名検出は**本質的にヒューリスティック**で
FP を伴う。hard-block は正当な掲示（部活名・行事名に人名様の部分文字列を含む等）を阻害し、教員が回避策（画像化・
別経路）に走ると**かえって統制が効かなくなる**。warn + 明示 override + 監査は「安全側の可視化と立証」を確保しつつ
authoring を止めない。高確信パターンに限定することで warn 自体の FP も低く保つ。

## 再検討トリガ

- 学校が生徒/保護者の正規氏名 roster を保持する運用（匿名設計の変更）になった → 確定マスク（`PiiEntry` STUDENT/GUARDIAN）へ移行
- soft-gate の override 件数 / 漏れ事例が増え、warn では不十分と判明した → 高確信パターンの hard-block 化を再評価
- ML-NER の FP/コスト/レイテンシを計測し、authoring を阻害しない水準と確認できた → C を追加採用
- 掲示物が PII を載せる用途へ拡張された（運用ポリシー変更）

## 影響

- **#426 は本 ADR + コードスライスで実装着地（2026-06-03）**:
  - ✅ 検出器（`packages/ai/src/pii/name-heuristic.ts` の `findSuspectedPersonalNames`/`hasSuspectedPersonalName`、
    敬称連接の決定論パターン・ReDoS 不能・純関数 + テスト pin、#474）。
  - ✅ apps/web publish Server Action に soft-gate 配線（`publishContentAction` が公開対象本文を `getContentDetail` で
    取得 → `findSuspectedPersonalNames` 走査 → 検出 & 未 override なら `pii_warning` を返し公開しない。
    `acknowledgePii=true` で公開 + 監査）。`packages/db` の content 書込み関数（`contents-publish.ts`）は非変更。
  - ✅ authoring UI 注意喚起 + override（`PublishControls`: 疑わしい表層提示 + 「承知の上で公開する」/「編集に戻る」）。
  - ✅ override 監査（`audit_log` に operation=update・diff=`{piiOverride, suspectedNameCount}`、**件数のみ**で生氏名は
    複製しない＝ルール4。NFR04: 誰が承知で公開したかを立証）。
  - ✅ コンテンツポリシー明文化は [`docs/compliance/embedding-pii-masking.md`](../compliance/embedding-pii-masking.md)
    （#433）+ 本 ADR。
- 既存の下流ゲート（embedding バッチの `findUnmaskedPii` fail-closed）は不変。多層防御の層が増える。
- ルール3（型単一ソース）非接触（スキーマ変更なし）。ルール4 の残存リスクは Low へ縮小（完全排除ではない）。

## 検討した代替案の要約

- **A 何もしない**: #426 未解決で却下。
- **C ML-NER**: FP/コスト未計測のため本 ADR では不採用、計測後の follow-up。
- **D hard-block**: FP で authoring を阻害し回避策を誘発するため却下。soft-gate（warn + override + 監査）で安全側の可視化を確保。
