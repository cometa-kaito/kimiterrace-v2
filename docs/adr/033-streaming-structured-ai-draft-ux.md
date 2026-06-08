# ADR-033: エディタ AI 連絡ドラフトは「構造化リストのストリーミング + 項目ごと採否」UX にする

- 状態: Accepted
- 日付: 2026-06-08
- 関連: #243 ②UI-UX, ADR-006（Vercel AI SDK / SSE）, ADR-017（confidence）, ADR-028（回答ポリシー）, ADR-030（authoring-time PII gate）, 設計詳細 [docs/design/ai-editor-assist-ux.md](../design/ai-editor-assist-ux.md)

## 文脈

エディタの AI アシスタント（教員のメモ/発話/ファイル → 連絡ドラフト）の UX が素朴で、(1) 無進捗スピナー、
(2) 全件一括 apply、(3) 再生成/トーン調整/部分修正なし、(4) PII 警告がモーダル分離、(5) 採用前に編集不可、
という問題があった。広く使われ評判の良い AI エディタ（Notion AI / Google Docs Help me write / ChatGPT・
Claude / Cursor・Copilot / Grammarly / Linear・Superhuman）を調査し、なぜなぜで深掘りした（設計詳細参照）。

連絡は「短文の独立した複数件」という構造であり、チャット（F06）の **prose トークンストリーミング** とは
出力形状が異なる。また公立校データゆえ PII の可視的取り扱い（ADR-030）が必須制約である。

## 決定

1. **トークンではなく構造化オブジェクトを要素単位でストリーミング** する。Vercel AI SDK `streamObject`
   の array mode（`elementStream`）を使い、連絡を **1 件ずつ確定ストリーム** する。SSE/HTTP 配線は F06 の
   `respondWithChatStream`（SSE over RLS-tx, [[feedback_sse_over_rls_tx_pattern]]）を踏襲した
   `respondWithNoticeDraftStream` に集約する。
2. **項目ごとの採用/削除/作り直し + すべて採用** を中核 UX とする。全件一括 apply を廃する。採用まで
   保存連絡（`setNoticesAction`）に書かない（可逆プレビュー）。
3. **トーンは refine-in-place（その項目を再生成）**、diff は局所単一フィールド編集だけに使う。日本語の敬語を
   独立軸として一級扱い（ていねいに/やわらかく 等）。
4. **PII ソフトゲートと不確実性はカード上に可視化** する（モーダル/設定でなく項目に）。「要確認」項目は
   「すべて採用」でスキップし、一瞥を強制する（automation bias 対策）。
5. **採用は楽観 UI + トースト Undo**（採用ごとの確認ダイアログは出さない）。ただし **DB 保存自体は RLS・
   監査つきトランザクションのまま**（楽観は表示層のみ、CLAUDE.md ルール1/2 を曲げない）。
6. AI 呼び出しは `AI_ENABLED` kill-switch（既定 OFF）下で、route 冒頭 503・UI graceful 退避。`audit_log` は
   件数のみ（本文/生 PII を残さない、ルール1/4）。

## 検討した代替案

- **既存の req/response を維持しスピナーだけ改善**: 最小工数だが、体感速度・二重送信・項目ごと採否という
  本質課題を解かない。却下。
- **prose トークンストリーミング（F06 と同形）**: 連絡は構造化リストで、半端な JSON をトークンで描くと
  壊れて見え、「N 件中 M 件完了」を表現できない。構造化要素ストリームに劣る。却下。
- **生成結果を直接エディタ本文へ自動挿入（inline 化）**: 現行は plain textarea で rich-text inline 挿入の
  土台がなく、かつ無言挿入は信頼を損なう（なぜなぜ①）。可逆プレビューを採る。却下。
- **承認ダイアログで採用を確認**: 正しい 95% の経路に課税する。Linear/Superhuman 流の楽観+Undo を採る。却下。

## 結果（Consequences）

- 良い影響: 体感速度向上・二重送信/幻リトライ減（Vertex 課金・レート保護）、1 件の悪が良品を壊さない、
  トーン/長さ/部分修正が可能に、PII 取り扱いが判断時点で可視化され ADR-030 をより強く満たす。
- トレードオフ: `streamObject` array mode の実挙動は Vertex Gemini 依存で、ユニットは mock 配線検証に留まり
  実証は staging（AI_ENABLED=true）に依存する（[[feedback_pinned_llm_model_retires_verify_live]]）。SSE route +
  要素単位 fail-closed の実装複雑度が上がる。→ §7 のスライスで ≤500 行/緑を担保し段階導入。
- 横展開: 停止・スケルトン・楽観+Undo の作法を F06 チャット / 効果コメント / teacher-input へ統一する
  （設計 §7 PR-6+）。共有 primitive は `@kimiterrace/ui` へ抽出する。
</content>
