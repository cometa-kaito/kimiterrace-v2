# ADR-036: エディタ AI アシスタント「おまかせ」は 1 入力を予定/連絡/提出物へ分類し、保存は per-section・採用前編集で担保する

- 状態: Accepted
- 日付: 2026-06-11
- 関連: F02（教員入力）, ADR-030（authoring-time PII gate）, ADR-033（構造化ドラフト UX）, [[ref_v2_two_content_systems]]（daily_data=サイネージ系統）, [[project_teacher_ui_editor_only]]

## 文脈

エディタ AI アシスタントは PR-1〜5 で「連絡 / 予定 / 提出物」の **セクション別**モード（教員がタブで種類を宣言 → 話す/入力/ファイル → AI 下書き → 採用 → daily_data → サイネージ）を実現した。

最終ゴール（ユーザー判断 2026-06-11）は **「おまかせ統合」**: 教員がタブを選ばず 1 回入力すると、AI が各項目を予定/連絡/提出物に**自動仕分け**して 3 セクション同時に提案する「話すだけで全部埋まる」ピーク UX。これは「先生の工数を増やさない」校務 DX 原則の到達点。

ただし分類には固有の難しさがある:
- **分類の曖昧さ**: 「体育館で全校集会」は予定（period 無し）か連絡か判然としない。「明日まで数学ワーク」は提出物。誤分類の余地が常にある。
- **保存先が 3 つ**: daily_data の schedules/notices/assignments は別カラムで、保存 action（`setScheduleAction`/`setNoticesAction`/`setAssignmentsAction`）も別。3 セクションを跨ぐ原子性は現状の per-section upsert には無い。
- **PII**: 公立校データゆえ送信前マスク・soft-gate（ADR-030）は単一入力に対して必須。

## 決定

1. **分類は単一の AI 呼び出しで 3 配列を返す**。新 system プロンプト `ALL_ASSIST_SYSTEM` が `{"schedules":[...],"notices":[...],"assignments":[...]}` を出力する。**PII マスク/soft-gate/レート/監査の単一パイプライン（`runSectionDraft` を spec 駆動 = `DraftSpec` に一般化）を予定/連絡/提出物/おまかせの 4 経路で共有**する（セキュリティ不変条件を 1 か所に保つ、ルール4）。`assistDraftAllAction` / `assistDraftAllFromFileAction` を追加。
2. **分類の最終確定は人間**。AI 出力は採用前にカードでその場編集可（可逆プレビュー, ADR-033）。各セクションの最終検証は既存 `validate*Items`（period 1..12・重複, deadline 実在日付）が強制する。プロンプトは「period が判別できない事項は予定に入れず連絡へ」「締切を計算できない課題は作らない」と誘導し、**確信が持てない/必須フィールドが欠ける項目は notices に寄せるか省く**（捏造禁止）。
3. **保存は per-section を順に実行し、原子性は求めない**。採用反映は section ごとに「既存 + 採用分」で該当 save action を呼ぶ（採用 0 件の section はスキップ）。**1 つが失敗しても成功済みは巻き戻さない**（各 section は独立カラムの upsert ＝ 冪等で、再実行で復旧可能）。UI はどの section が成功/失敗したかを明示する。理由: 跨りトランザクションを新設するコスト > 便益。daily_data の section は独立で、部分適用しても他 section を壊さない。
4. **PII override は入力（リクエスト）単位**。soft-gate は分類入力全体に効き、override（`acknowledgePii`）は per-request（per-item ではない）。セクション別モードと同一。
5. **「おまかせ」は追加モード**。セクション別タブ（連絡/予定/提出物）は**確実な手段として存続**し、誤分類時の逃げ道になる。既定モードは引き続き「連絡」。

## 検討した代替案

- **3 セクション横断の原子トランザクション保存**: 1 つでも失敗したら全 rollback。整合は強いが、新しい combined Server Action + 跨り tx が必要で、独立カラム upsert の冪等性を考えると過剰。却下（部分適用 + 明示報告 + 冪等再実行で十分）。
- **分類をクライアント（ルールベース）で行う**: 「明日まで」→提出物等の正規表現。脆く、相対日付・場所抽出を再実装する羽目になり、AI の文脈理解を捨てる。却下。
- **おまかせをセクション別の代替（置換）にする**: 誤分類時に教員が直す手段を失う。セクション別を残し、おまかせは上に乗せる。却下。
- **per-item の PII override**: 粒度は細かいが UX 複雑化、かつ既存 soft-gate（入力単位）と二重管理。却下。

## 結果（Consequences）

- 良い影響: 「話すだけで予定・連絡・提出物が埋まる」最小工数 UX。PII/監査は 4 経路で単一パイプライン共有（divergence リスク減）。誤分類は採用前編集 + セクション別タブで吸収。
- トレードオフ: 分類精度は Vertex Gemini 依存でユニットは mock 検証に留まり、実精度は staging（AI_ENABLED=true）で要検証（[[ref_idp_password_floor_and_login_static_cache]] と同様、実挙動は live 依存）。部分保存失敗時に「一部だけ反映済み」状態が起こりうる（明示報告 + 冪等再実行で緩和）。
- 実装分割: **PR-6a**=本 ADR + 分類バックエンド（`runSectionDraft` の spec 駆動一般化 + ALL 経路 + テスト）、**PR-6b**=統合 UI（おまかせタブ + 3 セクションカード + per-section 保存 + 部分失敗表示 + テスト）。各 ≤500 行・緑で段階導入（ADR-033 §7 と同方針）。
