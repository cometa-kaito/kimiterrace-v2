# エディタ AI アシスタント UX 再設計（連絡ドラフト生成）

- 状態: 採用（実装スライス進行中）
- 日付: 2026-06-08
- 関連: #243 ②UI-UX, ADR-006（Vercel AI SDK / SSE）, ADR-017（confidence）, ADR-028（回答ポリシー）, ADR-030（authoring-time PII gate）, ADR-033（本再設計の意思決定）
- 対象実装: `apps/web/app/admin/editor/_components/EditorAssistant.tsx` ほか（§7 スライス計画）

> 目的: 教員が「話す・打つ・ファイル」から **連絡（お知らせ）** の下書きを AI 生成する体験を、
> Notion AI / Google Docs「Help me write」/ ChatGPT・Claude / Cursor・Copilot / Grammarly / Linear・
> Superhuman の **広く使われ評判の良い実装** に学んで世界水準へ作り替える。校務 DX の最上位軸
> 「**先生の工数を増やさない**」（[根本方針](../../README.md)）に直結する中核機能。

---

## 0. 現状（Before）と課題

現行 `EditorAssistant` は次の素朴なフロー:

1. 右下 FAB `🤖 AI` → 浮遊パネル → textarea / 音声 / ファイル
2. 「AIで連絡を作る」→ **「作成中…」スピナー（無音・無進捗）**
3. 完成後にまとめて **チェックボックスのフラットなリスト**
4. 「連絡に反映する」で **全件を一括 apply**

課題（§3 のなぜなぜで詳述）:

- **死んだスピナー**: 動かないスピナーは「固まった/失敗した」と読まれ、二重送信（= Vertex 課金・レート消費の二重発生）を誘発する。
- **一括 apply**: 1 件でも気に入らないと良い 4 件ごと破棄する設計。リトライは全リスト再生成しかない。
- **再生成・トーン調整・部分修正が無い**: 「もう少し短く」「ていねいに」が一切できない。
- **PII 警告がモーダル**: ソフトゲート（ADR-030）が本文と切り離されたモーダルで、判断の文脈に乗らない。
- **編集不可**: AI の下書きを採用前にその場で直せない。

---

## 1. パクる対象と、それぞれの一級パターン

| 製品 | 学ぶ中核 |
|---|---|
| **Notion AI** | 生成結果は **可逆プレビュー**。`Done / Discard / Try again` の3アクション。Change tone / Make longer-shorter。 |
| **Google Docs「Help me write」** | **項目ごとの ✓** + Accept all / Reject all。Refine（Rephrase/Shorten/Elaborate/Formal/Casual/Bulletize）。 |
| **ChatGPT / Claude** | トークン **ストリーミング** + **Stop**。Regenerate（前版を保持）。edit-and-resend。 |
| **Cursor (Cmd-K) / GitHub Copilot** | **インライン diff** の Accept/Reject。**キーボードファースト**（Enter 採用 / Esc 却下 / 部分採用）。 |
| **Grammarly** | **提案カードに「なぜ」を同梱**。瞬時・ちらつかない apply（Delta gluing）。 |
| **Linear / Superhuman** | **楽観的 UI + Undo**（確認ダイアログを廃し、間違いだけに課税）。**Cmd+K パレット**で操作を発見・教育。 |

出典は §9。Notion/Cursor 公式は正確なラベルが薄いので、verbatim な文言は三者ガイドで裏取り済み。

---

## 2. ターゲット体験（After）

### 2.1 ストリーミング（構造化リスト）

- **トークン列ではなく「構造化オブジェクトを要素単位で」ストリーミング**する（Vercel AI SDK `streamObject({output:'array'})` の `elementStream`）。連絡は **短文の独立した複数件** なので、チャットの prose トークン流しは不適。
- 送信した瞬間に **N 枚のスケルトンカード**を出す（最初のトークン前の「効いてる?」不安を消す）。各要素が確定するごとにカードがスケルトン→実体へ反転。
- 全体に **停止** ボタン（`stop()`）。停止しても **既に届いた項目は破棄しない**（構造化リストの強み）。
- **途中でエラーが出ても**: 入力（音声/テキスト/ファイル）と **完成済みカードは保持**。失敗は該当項目だけにインライン表示（`この項目の生成に失敗しました ・ 再試行`）。バッチ全体や入力を消さない。

### 2.2 項目ごとの採否（コア修正）

各カードの主行（左→右、3アクション固定）:

```
✓ 採用    ✕ 削除    ↻ 作り直し    ⋯
```

- **採用** が期待される正の既定で先頭・最も重い見た目（Notion=Done 先頭 / Docs=Accept ✓ 先頭）。
- **⋯** がトーン/長さの refine チップを開く（主行を3アクションに保ち、モバイルの親指圏に収める）。
- バッチバー（モバイル=下部固定 / デスクトップ=右上）:

```
すべて採用    ↻ 全部作り直す    停止（生成中のみ）
```

- **すべて採用** は最も目立つ既定。ただし後述 **要確認** 項目は **すべて採用ではスキップ**し、必ず一瞥を強制する。

### 2.3 採用前に編集できる（可逆プレビュー）

- カード本文はその場で編集可能（textarea）。`isHighlight`（重要マーク）はトグル。採用するまで保存（`setNoticesAction`）に触れない。
- **採用 = 楽観的に下書きリストへ即反映** + トースト `採用しました ・ 取り消す`（単段 Undo、~8秒 / Cmd+Z）。確認ダイアログは出さない（正しい 95% に課税しない）。**DB 保存自体は RLS・監査つきトランザクションのまま**（楽観は表示層だけ）。

### 2.4 トーン・長さ（refine-in-place）

トーンは「文を書き換える」変換なので diff ではなく **その項目を再生成（refine-in-place）** する。日本語の敬語は独立軸として一級に扱う。

- 主チップ: **短く** / **くわしく** / **ていねいに**（敬語寄せ）/ **やわらかく**（保護者向けに温かく）
- ⋯ 副メニュー: **簡潔に**（事実を落とさず締める）/ **かしこまった表現に** / **言い換え** / **箇条書きに** / **やさしい日本語・多言語**（多言語連絡の布石）
- **diff は局所修正（「この日付を直して」）だけ**に使う（Cursor 流）。全文書き換えに diff はノイズ。
- バッチ **全部作り直す** は重いハンマー。**前バッチを1段保持**して、悪化した再生成から戻れるようにする。

### 2.5 PII / 要確認（ここは参照元より厳しく）

- ソフトゲート（ADR-030・敬称連接の氏名らしき語）は **モーダルでなくカード上のチップ** `⚠ 個人名を含む可能性`。タップで「なぜ（何を検出/マスクしたか）」を展開。
- AI が不確かな抽出（解釈した日付・時刻・場所・人数）には **黄色の「要確認」** マーカー。**すべて採用ではスキップ**し、個別タップを要求（automation bias 対策）。掲示は保護者・サイネージに出る一方向のため、最後の確認は常に人間。

### 2.6 デスクトップのキーボード（パワーユーザー経路）

- `Enter`/`Tab` = 現在項目を採用、`Esc` = 削除、`R` = 作り直し、`J`/`K` = 項目移動、`Cmd/Ctrl+Enter` = すべて採用、`Cmd/Ctrl+Z` = 直前の採否を取り消し、`Cmd/Ctrl+K` = AI アクションパレット（トーン/refine、最後に実装）。
- モバイルは下部固定バッチバー + 大タップ + スワイプ削除（= Esc のモバイル等価）。

---

## 3. なぜなぜ（5-whys → 設計帰結）抜粋

完全版は調査ログ。各鎖は「なぜ」を4〜5段下げ、**我々の文脈での設計帰結**で締める。

**① 可逆プレビュー（挿入しない）**
control が要る→LLM 出力は確率的でしばしば微妙→無言挿入は後始末を生む→後始末は「この道具は逆らう」を学習させ日々使う道具を捨てさせる（教員は元々過負荷）。**帰結: 生成は項目ごとの可逆な提案。採用まで保存連絡に書かない。**

**② Done/Discard/Try again の3アクション固定**
判断点の認知負荷をほぼ0に→直前に AI 文を読み判断するのが高コストな認知ステップ→ボタン追加は「どれ?」の逡巡を生む→出力は N 件なので4つ目のボタンは N 回課税する。**帰結: 主行は 採用/削除/作り直し の3つ。トーン等は ⋯ へ降格。**

**③ 項目ごと ✓ + すべて採用/却下**
リストの実意図は「全部OK」と「ほぼOK・1件直す」→片方を強いるのは摩擦、全か無かは1件の悪で良品を壊す→現状は全リスト再生成しかなく、1件の悪が良5件を吹き飛ばす→「バッチを信じるな」を学習し手打ちに戻る。**帰結: すべて採用 + 項目ごと ✓/✕。却下はその項目だけ除外、残りは採用維持。**

**④ ストリーミング + 停止**
体感速度は同レイテンシでも 40–60% 速く感じる→離脱は「felt wait」で決まり、動かないスピナーは「失敗」に読まれる→ユーザは送信失敗と誤認し再送→各 run は Vertex（課金・PII マスク）とレートを叩き、幻の再送が予算・quota を浪費。**帰結: スピナー廃止 →（a）即スケルトン（b）要素流し込み（c）常設の停止。**

**⑤ 構造化リストの要素単位ストリーミング**
要素ごとに流す→各連絡は完成した瞬間に独立して使える→教員は1件目を読みながら4件目生成を待てる（注意のパイプライン化）→半端な JSON をトークンで描くと壊れて見える。**帰結: `elementStream`/`useObject`。スケルトン→フィールド充填、楽観連鎖に optional chaining。**

**⑦ 提案カードに「なぜ」を同梱（Grammarly）**
理由が見えると採用は速く、不同意の却下は自信を持てる→盲目的信頼を情報ある判断に変える→我々の必須制約は **PII の可視的取り扱い**で、隠れたマスク判断は設計上 非準拠→設定は読まれない。警告は対象の成果物に乗せ、判断時点で出す。**帰結: PII ソフトゲートはカード上のチップ。設定画面でなく項目に。**

**⑧ 楽観 UI + Undo（Linear/Superhuman）**
~100ms 超で体感は急落、毎回のスピナーは鈍い→速さが日々の道具を「良い」にする→遅い道具は紙/LINE に迂回され、我々の論拠（負担減）が崩れる→確認ダイアログは正しい経路に課税。Undo は間違いにだけ課税。**帰結: 採用は即時反映 + トースト Undo。採用ごとの確認ダイアログ無し。**

**⑨ 意図プレビュー + 不確実性提示（agentic 信頼）**
不確実性を提示し automation bias と戦う→多忙な教員はバッチを rubber-stamp しがち（過信が現実的失敗モード）→幻覚の日時/場所が保護者・サイネージに権威として出る→精度ゼロ誤りは不可能。設計で人間を最後の安価な砦にする。**帰結: 解釈した日付/名前/数値に「要確認」。すべて採用は一瞥なしにそれらを巻き込まない。**

---

## 4. 避けるアンチパターン（参照元が意図的に避けているもの）

1. 確認なしの自動挿入 → 保存連絡に無言で書かない。
2. 生成中のブロッキング・スピナー → ストリーミング + 停止に置換（**現状はこれ**）。
3. エラーで入力を失う → 途中失敗でも入力と完成項目を保持。
4. リストの全か無か apply → 項目ごと採否で1件の悪が良品を巻き込まない。
5. 再生成で前案を破壊 → 全部作り直すは前バッチを1段保持。
6. 不確実性の隠蔽・自信ある当て推量 → 要確認マーカー。
7. 採用ごとの確認ダイアログ → トースト Undo。
8. 専門用語/設定埋もれの説明 → 「なぜ」を項目カードに。

---

## 5. ストリーミング・アーキテクチャ

既存 F06 チャット（`createVertexChatStreamClient` + `respondWithChatStream` + `streamChat`）の **SSE over RLS-tx** パターン（[[feedback_sse_over_rls_tx_pattern]]）を踏襲。ただし連絡は **構造化リスト** なので prose トークンでなく要素オブジェクトを流す。

```
[client] streamNoticeDraft(SSE) ──POST──▶ /api/admin/editor/notice-draft (route: 認証+role gate)
                                              │ 200 前に 401/403/400/413 を実 HTTP で返す
                                              ▼
                            respondWithNoticeDraftStream (sse-handler)
                              0) AI_ENABLED kill-switch → 503
                              1) soft-gate（氏名）→ SSE error(pii_warning) ※未 ack
                              2) per-school rate limit
                              3) maskPII（電話/メール）+ fail-closed
                              4) createVertexNoticeStreamClient.stream(system,user)
                                   elementStream で要素ごとに:
                                     - unmaskPII + findUnmaskedPii（要素単位 fail-closed）
                                     - SSE frame: notice{index,text,isHighlight,needsReview?}
                              5) done → audit_log（件数のみ・本文/PII を残さない）
```

- **packages/ai**: `createVertexNoticeStreamClient`（`streamObject` array mode、`elementStream` + `done{modelVersion,tokenCount}`）。テストは `streamObject` を mock し GCP なしで配線検証（chat-stream.test と同方針、実挙動は staging の AI_ENABLED で検証）。
- **PII と streaming の両立**: マスクは送信前、**要素確定の境界で** unmask + fail-closed を回し、漏れた項目だけ落とす（または redaction）。採用→保存の境界でも整合は維持（保存は既存 `setNoticesAction`）。
- **トーン/refine**: route は `tone?` / `instruction?` / `regenerateIndex?` を受け、prompt builder（`assistant-core`）が反映。サーバ契約を先に用意し、UI スライスはサーバ変更を要さない。
- **ファイル経路**: 抽出（同期）→ 同じストリーミングパイプライン。route は multipart（file）/ JSON（text・tone・refine）両対応。

---

## 6. 制約・ガードレール整合（CLAUDE.md）

- ルール1 監査: LLM 呼び出しは `audit_log` に件数のみ（本文/生 PII を残さない）。`updated_at` 明示。
- ルール2 RLS: 監査・保存は `withTenantContext`/`withSession` の自校 tx。actor はセッション由来（外部入力を信用しない）。
- ルール4 PII: 送信前マスク + 要素単位 fail-closed + ソフトゲート（ADR-030）を **可視化**。
- ルール4 kill-switch: `AI_ENABLED` 既定 OFF。route 冒頭で 503。UI は graceful 退避（「AI 機能が無効」）。
- ルール6: 1 PR ≤500 行・1 機能。§7 のスライスで担保。
- ルール7: typecheck/lint/test 緑で merge。
- NFR05 a11y: `aria-live` でストリーミング読み上げ、フォーカス管理、色のみに依存しない（要確認は色+テキスト）。

---

## 7. スライス計画（PR 単位・各 ≤500 行）

| PR | 範囲 | 主成果物 |
|---|---|---|
| **0**（本書）| 設計 + ADR-033 | `docs/design/ai-editor-assist-ux.md`, `docs/adr/033-*.md` |
| **1** | packages/ai ストリームクライアント | `createVertexNoticeStreamClient`（`streamObject` array）+ test + export |
| **2** | apps/web サーバ: ストリーミング route + SSE handler + client lib | `/api/admin/editor/notice-draft`, `respondWithNoticeDraftStream`, `streamNoticeDraft`（text 経路・tone/refine 契約込み）+ test |
| **3** | apps/web UI: 新 EditorAssistant（中核）| スケルトン/要素流し込み・項目ごと採否・すべて採用・停止・エラー保持・PII チップ・楽観+Undo |
| **4** | トーン/長さ refine + 全部作り直す | 主/副チップ・refine-in-place・前バッチ保持 |
| **5** | ファイル経路ストリーミング + キーボード経路 | 抽出→stream・Enter/Esc/R/J/K・Cmd+Enter |
| **6+** | 横断統一 | ChatPanel（停止/スケルトン）・EffectCommentPanel・teacher-input を同作法へ。共有 primitive は `@kimiterrace/ui` へ抽出 |
| **終** | staging デプロイ | `web_image_tag` bump + 実機確認（AI_ENABLED の状態を確認・フラグ操作は別ゲート） |

## 8. 実装順（steal list: impact × low-effort）

1. スピナー→スケルトン+構造化ストリーミング（最大インパクト）
2. 項目ごと 採用/削除 + すべて採用（中核修正）
3. 停止ボタン
4. 項目ごと 作り直し（他を保持）
5. 途中失敗で入力・完成項目を保持 + 項目ごと再試行
6. PII 要確認チップ + すべて採用はスキップ
7. トーン/長さ refine チップ（短く/くわしく/ていねいに/やわらかく）
8. 楽観採用 + トースト Undo
9. バッチ 全部作り直す（前バッチ保持）
10. デスクトップ・キーボード（Enter/Esc/R/J/K）
11. 局所単一フィールド編集の diff（「この日付を直して」）
12. Cmd+K AI アクションパレット（最後）

---

## 9. 出典

Notion AI FAQ / eesel / allthings.how、Google Docs Help me write（support.google.com/docs/answer/13951448）、Cursor inline-edit & shortcuts、GitHub Copilot suggestions、Grammarly engineering blog、Vercel AI SDK object-generation（`useObject`/`elementStream`）、Smashing「Designing Agentic AI: Practical UX Patterns」、Superhuman command palette、Linear review、Redis streaming LLM responses、frontkit streaming UI、ChatGPT regenerate、Canva 敬語コンバータ / LeapMe（JP 敬語=独立軸）。URL は調査ログに保持。
</content>
