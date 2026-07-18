# 教員エディタ: ①出荷待ちの収束 + ③「入力ゼロ化」実装設計（2026-07-18）

- **状態**: Draft（設計 = Fable セッション 2026-07-18。実装 = Opus セッションへハンドオフ）
- **目的**: (①) 作ったのに届いていないエディタ改善を本番へ出荷し、塩漬け PR を棚卸しする。(③) エディタの根本コスト「先生が毎日・手で・打つ」を、**朝ドラフト（決定論合成）**と**写真取込（既存AIパイプライン再利用）**で「確認して直すだけ」に変える。
- **正本関係**: 構造再設計と PR-E の変換仕様は [editor-restructure-bulletin-2026-07.md](editor-restructure-bulletin-2026-07.md) が権威（本書は再掲しない）。デプロイ手順は [../runbooks/web-deploy.md](../runbooks/web-deploy.md)（skill deploy-v2）が権威。
- **本書の調査基盤**: 2026-07-18 に 3 レーンの読み取り専用調査で確証済み。事実は `パス:行` で引用する（当時 HEAD = `feat/editor-copy-undo` @ `bd7a7ed8`）。

---

## 0. 実装者（Opus）への前提

1. **着手前に必ず** `git fetch && git rev-list --count HEAD..origin/main` で乖離確認（ワークスペース既知の再発事故: 基底 stale で二重実装）。本設計時点で `feat/editor-copy-undo` は **origin/main に対し 10 コミット遅れ / 2 コミット先行**。遅れ 10 件はサイネージ広告停止系（#1293/#1297/#1298）＋バグ掃除（#1295）＋bump で、**#1295 に「editor 二重書込」修正が含まれる**。テキスト競合は無い（両 PR とも MERGEABLE 確認済）が、rebase 後にエディタ系テスト一式と `next build` を必ず回す（bundling エラーは vitest/tsc で検出不能 — STATUS.md 2026-07-12 の教訓）。
2. CLAUDE.md 8 ルール厳守。特にルール6（1 PR ≤500 行）で本書の PR 分割を崩さない。Reviewer Agent spawn 必須。
3. 本書は未コミット（untracked）。**最初の実装 PR に同梱してコミット**する（前例: 構造再設計書は PR #1214 で追加）。
4. **ユーザー判断ゲート**（下記 §4）以外は自律で進めてよい。

---

## 1. ①-A 出荷: #1289/#1292（コピー統合 + undo）を本番へ

### 現状（確証済み事実）

- [#1289](https://github.com/cometa-kaito/kimiterrace-v2/pull/1289): 前日/前週コピー→「ほかの日からコピー」統合。**base=main / head=`feat/editor-copy-from-menu`**
- [#1292](https://github.com/cometa-kaito/kimiterrace-v2/pull/1292): コピー undo。**base=`feat/editor-copy-from-menu` / head=`feat/editor-copy-undo`（= スタック PR）**
- 2026-07-12 時点で CI 緑 + Reviewer APPROVE 相当（memory 記録）。以後 6 日放置で main が 10 コミット前進。
- 実装実体: `CopyFromMenu.tsx` / `CopyUndoContext.tsx` / `apps/web/lib/editor/copy-day-actions.ts`（`copyOneDay`:232 / `readCopySource`:132 / `restoreCopySnapshotAction`:663）。**schema 変更なし = migration 不要**。

### 手順（この順序を崩さない）

1. `feat/editor-copy-from-menu` を origin/main に rebase → force-push → CI 全緑を確認。
2. `feat/editor-copy-undo` をその上に rebase → force-push → CI 全緑。
3. **#1295 との意味的干渉チェック**: rebase 後に `pnpm --filter @kimiterrace/web test`（エディタスイート）＋ `next build` をローカルで通す。コピーは全ブロック 1 tx 置換なので二重書込修正と原理的には独立だが、確認を省略しない。
4. #1289 を squash merge。**このとき head ブランチを削除しない**（⚠ 既知の罠: stacked PR は base ブランチ削除で子 PR が auto-close する。2026-07-07 に実発生）。
5. `gh pr edit 1292 --base main` で #1292 を main へ retarget → CI 再緑 → squash merge → 両ブランチ削除。
6. デプロイ: skill **deploy-v2** の正規手順（web のみ・migrate 不要）。staging → 疎通 → prod。**prod 反映はユーザー判断ゲート（§4-G1）**。

### 出荷後の検証（本番・テスト校 1年1組で実施）

コピー/undo のスモーク（実データのクラスでは行わない）:
- [ ] 「ほかの日からコピー」でコピー元選択→プレビュー→実行→盤面反映
- [ ] 直後に「元に戻す」→コピー前の状態へ復元（空だった日は空へ戻る）
- [ ] 週コピーが編集中週に効く（今日固定ではない）

あわせて **7/6 監査以来の残目視 4 点**を同じセッションで消化する:
- [ ] FHD 実寸での盤面プレビュー配置（#1248 の 1400px キャンバス）
- [ ] カレンダー選択後スクロール（#1248 でアンカー移設済みの実挙動）
- [ ] 基本時間割 seed の確定押下（SeedConfirmButton）
- [ ] スマホ実機（#1252）。resize では代替にならない（過去に viewport 反映されず未検証のまま）

---

## 2. ①-B 棚卸し: 塩漬け PR の判定

| PR | 判定 | 根拠 / 実装者への指示 |
|---|---|---|
| [#1177](https://github.com/cometa-kaito/kimiterrace-v2/pull/1177) 連絡並べ替えの空行落ちガード | **rebase → merge** | merge 済み #1175（来校者/呼び出し）と同型・40 行・テスト付き fix。rebase して CI 緑なら #1289 群と同じデプロイに同乗させる |
| [#1182](https://github.com/cometa-kaito/kimiterrace-v2/pull/1182) 科目だけで保存・カレンダー初期展開 | **close（コメント付き）** | 6/23 起票。UI 前提が #1237（日付タブ化）/#1248 で消滅（「カレンダー初期展開」は対象 UI 自体が変わった）。生き残る価値がある「時限の自動採番」は監査 ed47-7 と同根で、③朝ドラフト（§3.1）が時間割 seed でより根本的に解決する。close 時に「ed47-7 は §3.1 で解決」と明記 |
| [#1122](https://github.com/cometa-kaito/kimiterrace-v2/pull/1122) 盤面の 50 インチ縮小表示 | **close** | 同目的の実装が別 PR で本番 LIVE 済み（/signage ≥900px 縮小 = `d9aff6e`、＋ #1263 実寸プレビュー `/app/editor/[classId]/preview`）。完全に superseded |
| #1203（tv-liveness）・#1200/#923-928（deps） | 対象外 | エディタレーン外。触らない |

---

## 3. ③「入力ゼロ化」根本設計

### 設計思想（なぜこの順か）

エディタの残コストは「フォームの使いにくさ」ではなく「**毎日ゼロから入力する**」こと自体。既にある 3 素材 — F5 週次時間割・年間行事・前日までの実データ — から**開いた瞬間に盤面の下書きが組み上がっている**状態を既定にし、教員の仕事を「入力」から「確認と微修正」へ変える。AI は決定論で足りる所には使わず（P0）、紙という一次情報の構造化にだけ使う（P1）。

3 本柱。**P0 は AI 不使用・決定論**なので prod の `AI_ENABLED=false` に関係なく全校で効く。ここが最優先。

### 3.1 P0: 朝ドラフト（開いたら今日の盤面ができている）

#### 現状の到達点（全部品が存在し、バラバラに動いている）

| 素材 | 実体 | 現状の挙動 |
|---|---|---|
| 週次時間割 seed | `weekly-timetable-core.ts:76` `seedSchedulesForDate` | 対象日の予定が空なら**表示 seed のみ**（DB 未書込）。`SeedConfirmButton` で手動確定 |
| 年間行事 | `day-events.ts:120,135` `dayEventToScheduleItem/NoticeItem` + `DayEventsPanel` | 行事ごとに「予定へ追加/連絡へ追加」の**手動ワンクリック** |
| 既定対象日 | `default-date.ts:106` `resolveDefaultEditorDate` | cutover 16:00 / 休日→次の授業日。**完成済み・変更不要** |
| 固定・持ち越し連絡 | `page.tsx:236-241` の合成 | 表示合成済み。**変更不要** |
| 全ブロック 1 tx 書込 + undo | `copy-day-actions.ts` `copyOneDay` / `DaySnapshot` / `CopyUndoContext` | ①出荷で本番に載る。朝ドラフト確定の土台 |

つまり朝ドラフトとは**新機能ではなく、この 3 つの手動確定を 1 つの合成＋1 ボタンに統合する**こと。

#### 決定事項

- **D1: 自動保存はしない。「表示合成 + 1 クリック確定」方式**。保存＝即盤面反映（ADR-015、下書き行の永続概念なし = `daily-data-write.ts` 系の確証事実）なので、無確認の自動保存は「教員が見ていない内容がサイネージに出る」。既存の seed 方式（DB 未書込の表示 draft）と完全整合する確定ボタン方式を採る。全校一括の自動確定フラグは将来の school_configs 拡張候補として**本設計では作らない**。
- **D2: 来校者・呼び出しは合成対象外**。ADR-034 の境界（職員が明示入力・日別・最小保持）。前日から氏名を自動持ち越すのは PII 保持の自動延長になるため禁止。
- **D3: 合成はパターン駆動**。`editableBlocksForPattern`（PR-D2 で単一ソース化済み）で対象セクションを絞る。pattern4 → notices のみ / pattern5 → notices+schedules（ただし時刻型 `scheduleInputVariant="time"` のため**時限ベースの時間割 seed は適用しない**。行事由来のみ）/ pattern1/6 → schedules+notices。
- **D4: 確定時はサーバ側で再合成**。クライアントが組んだ items を信用して書かない。`confirmMorningDraftAction` は date+classId＋除外指定のみ受け取り、サーバで同じ純関数を再実行して書く（`restoreCopySnapshotAction` の fail-closed 再検証と同じ思想をより強くした形）。

#### 実装設計

**PR-Z1: 合成コア（純関数 + テストのみ、UI 変更なし）**

新規 `apps/web/lib/editor/morning-draft-core.ts`:

```
buildMorningDraft(input: {
  date: string; pattern: SignagePattern;
  existing: { schedules, notices, assignments };   // 対象日の現 daily_data
  weeklyTimetable: WeeklyTimetable | null;
  dayEvents: EditorDayEvent[];
  excluded?: MorningDraftItemKey[];                 // 教員が×した項目
}): MorningDraft
```

- `MorningDraft = { sections: { schedules?, notices? }, provenance: 項目ごとの出所（"基本時間割" | "年間行事"）}`。provenance は UI バッジと除外キーの安定 id に使う。
- 合成規則: **既に入力があるセクションには一切触れない**（空セクションのみ合成）。schedules = `seedSchedulesForDate` の結果 + 行事の schedule 型写像。notices = 行事の notice 型写像（固定・持ち越しは既存合成に任せ重複させない）。
- 全て既存純関数（`seedSchedulesForDate` / `dayEventToScheduleItem` / `dayEventToNoticeItem`）の呼び出しに徹し、変換ロジックを再発明しない。
- テスト: 空日/部分入力日/休日/パターン別（1,4,5）/除外指定/行事と時間割の共存、の純関数ユニット。

**PR-Z2: 確定 Server Action + undo**

新規 action `confirmMorningDraftAction`（`morning-draft-actions.ts`）:

- 入力: `{ classId, date, excluded }`。サーバで素材を読み直し `buildMorningDraft` を再実行。
- 書込: `copyOneDay` と同じ作法 — 書込前に `readTargetRawSnapshot` 相当で `DaySnapshot` 取得 → 対象セクションを 1 tx で `upsertDailySectionForTarget`（監査同梱・`assertTargetVisible`）→ 戻り値に `undo` 同梱 → `CopyUndoContext` にそのまま載せる。
- 保存前検証は既存 `validateScheduleItems` / `validateNoticeItems` を必ず通す。
- `revalidatePath` はコピー系と同一セット。

**PR-Z3: UI 統合（ゾーン1）**

- 対象日が「合成可能」（＝編集可能ブロックに空きがあり合成結果が非空）のとき、盤面プレビュー直上に**「今日の下書きができています」カード**を表示: 合成内容を provenance バッジ付きでプレビューに重畳（未確定を点線等で視覚区別 — 値は tokens 準拠、skill design-ui）→ 項目ごと×除外 → 「この下書きで盤面に出す」1 ボタン → 確定後は既存の `?applied=` 再ナビ手法（`ClassEditorChat.tsx:52` / `SeedConfirmButton` と同型）でフォーム再マウント・undo トースト表示。
- **`SeedConfirmButton` と `DayEventsPanel` のワンクリック挿入は朝ドラフトカードに吸収**し、露出を 1 箇所へ（非空日では従来どおり `DayEventsPanel` の個別追加を残す）。層混在を増やさない: カードはゾーン1「毎日の編集」の文脈そのもの。
- 文言は説明文に頼らない（監査 ed47-6 の教訓: 説明が要る時点で構造が非自明）。

受入基準: 基本時間割と年間行事が登録済みの校で、**空の授業日を開いてから盤面確定まで 1 クリック**。undo で完全復元。AI 呼び出しゼロ。既入力日では何も出ない。

### 3.2 P1: 写真取込（紙のプリント→盤面下書き）

#### 現状の到達点（バックエンドは実質完成している）

- エディタのファイル添付は **png/jpg を既に受理**: `assistant-actions.ts:102` `EDITOR_FILE_EXTS`、Gemini マルチモーダル OCR（ADR-038、`packages/ai/src/extract/ocr/gemini.ts`）。
- **三段ガード実装済み**（`assistant-actions.ts:413` `draftSectionFromFile`）: per-school rate 前置 → `writeOcrEgressAudit`（画像 SHA-256 のみ・本文非保存）→ 抽出テキストにマスク + 氏名 soft-gate（HTTP 409 + `acknowledgePii` override + 件数のみ監査 = ADR-030 の F03 経路と同一）。
- アップロードハードニング済み: `upload-validation.ts`（50MB 上限・MIME allowlist・ストリーム打ち切り・画像マジックバイト検証）。
- 会話型パイプラインは**複数日の振り分けに対応済み**: `assistant-chat-core.ts:88` `MAX_DRAFT_DAYS=7` + `days`、日付対応表のプロンプト注入（曜日算術をモデルにさせない、eval 実証済み）。
- 確認 UI の型: ADR-049 カレンダー取込（アップロード→AI プレビュー→行編集→確認必須→保存）が最も近い完成前例。

**→ P1 の実装は「新パイプライン構築」ではなく「導線と振り分け先の接続」である。**

#### 決定事項

- **D5: 経路は会話型チャットへの合流を第一候補とする**。写真 OCR テキストを `assistant-chat` の 1 ターン（「このプリントの内容を該当する日へ取り込んで」相当のシステム側指示 + 抽出テキスト）として注入する。理由: (a) `days` による**複数日振り分け**（学年通信は来週の予定を含む）が既に動き eval で検証済み、(b) プレビュー→反映→`?applied=` 同期→PII 409/override の UI が全部ある、(c) `rebaseDraftBeforeFirstTurn`（#1245 の P1 修正）で手入力との衝突も解決済み。単日固定の `assistDraftAllFromFileAction` 拡張は次点（チャット合流で不都合が出た時のフォールバック）。
- **D6: 導線は「AI パネルの中の添付」から「ゾーン1 の正面」へ昇格**。planActions 隣に「📄 プリント/写真から取り込む」— PC はドロップゾーン（#1286 のカレンダー取込ドロップゾーンと同じ作法）、**スマホは `<input type="file" accept="image/*" capture="environment">` でカメラ直起動**。教員の実機はスマホであることが多い（①の残目視にスマホ実機が残っている事実がそれを示す）。
- **D7: `AI_ENABLED` ゲートに素直に乗る**。staging=ON / prod=OFF（Terraform 既定 false）。**prod で写真取込を有効化するかは独立のユーザー判断ゲート（§4-G3）**であり、本実装は staging で完成・eval 通過までを到達点とする。
- **D8: eval を先に足す**。`apps/web/__tests__/ai/evals/` に写真ケース（`cases-photo-extraction.ts`）＋ **PII を含まない**画像フィクスチャ（`extract/__tests__/fixtures/build-fixtures.ts` の前例で合成生成: 学年通信風・時間割変更風・持ち物連絡風の 3 類型）。実 Vertex eval（`RUN_AI_EVAL=1`）で反映精度を計測してから UI を出す。AI 精度改善（2026-07-05）の「eval が先、修正が後」の型を踏襲。

#### 実装分割

- **PR-P1**: eval ケース + 画像フィクスチャ（UI なし・skip-gated なので CI 影響なし）
- **PR-P2**: OCR→チャット合流の配線（`draftSectionFromFile` の OCR 部を共通化し、チャットターンとして注入する server 経路 + 三段ガード維持。ガードの実装を複製しない — 既存関数の抽出リファクタで共有）
- **PR-P3**: 導線 UI（ドロップゾーン + スマホ capture + AI 無効環境では導線自体を出さない）
- 設計メモ: rate limiter がカレンダー取込と独立インスタンスで実質 2 倍になる既知 follow-up（STATUS.md:48）に写真がもう 1 系統足されるため、**PR-P2 で per-school 共有リミッタへの一本化を含める**（3 系統目を作らない）。

### 3.3 P2: 層の契約の明文化 + PR-E 実施

構造監査の「層混在」（ed47-4）はページレベルでは PR-A の 3 ゾーン分層で解消済み。調査で確定した**残りは 2 点だけ**であり、大工事をしない:

1. **計画操作がゾーン1 に再同居**（#1248/#1272 の planActions）— これは配置最適化の**意図的判断**なので戻さない。本書 §3.1 の朝ドラフトカードも同じ場所に置き、「計画の設定は年に一度（時間割・年間行事）／その成果物が毎朝ゾーン1 に現れる」という関係で説明がつく。
2. **端末層の設定が editor ゾーン3 と /ops の端末編集に二重化** — デザインパターン（`?design`）は運営専権・エディタから不可視、が正しい境界（教員が盤面型を壊せない）。**これは直すべきものではなく、契約として明文化する**: 「日常= daily_data（class×date）／計画= class_weekly_schedules・school_calendar_events／端末= tv_devices.signage_url クエリ + display_settings」。この 3 行を [editor-restructure-bulletin-2026-07.md](editor-restructure-bulletin-2026-07.md) §3 に追記する（別ドキュメントを増やさない）。

**PR-E（進路指導室前→pattern5 一括移行）**: 仕様は設計書 §8 が正本（ダッシュ行→divider / 校訓→pinned お知らせ / 実呼び出しは移行しない / dry-run→人間確認→--apply→pattern5 切替→目視→ロールバック）。本調査での追加事項:

- 変換 CLI `migrate-shinro-bulletin-cli.ts` は**未作成**（リポジトリに存在しないことを find で確認済み）。実装はこの CLI + dry-run 出力までが Claude の範囲。**本番 DB への適用と切替は人間専任**（設計書どおり）。
- ⚠ **プリフライト必須（調査で発見した不整合）**: 設計書は「岐阜工業・進路指導室前 = class `7a18ca87-…`・pattern3」とするが、tv-ble-bridge 側 runbook（`dist/APK-MANIFEST.md:106-107`）は物理端末 `ef315334-…` のトークンが**テスト校 1年1組・pattern2 を解決する**と注記している。どちらかの文書が stale。**CLI 実行前に prod の tv_devices を照会し「実機が今どのトークン/クラスを開いているか」を確定**してから対象 class を確認する（誤った class への変換を防ぐ）。結果は本書とtv-ble-bridge runbook の両方に反映。

---

## 4. ユーザー判断ゲート（ここだけは自律で進めない）

| # | ゲート | 内容 |
|---|---|---|
| G1 | **prod デプロイ**（§1 手順6、以降の各出荷も同様） | 外部視認の一方向アクション。staging 完了時点で報告し、prod 反映の可否を確認 |
| G2 | **PR-E の本番 DB 適用 + pattern5 切替** | 設計書 §8 どおり人間専任。dry-run 結果を提示して停止 |
| G3 | **prod の AI_ENABLED を ON にするか**（P1 を本番で使う前提条件） | コスト・quota・PII 姿勢の事業判断。staging での eval 結果（PR-P1）を材料として提示 |

## 5. 実装順序（依存関係）

```
Phase 1（即日・依存なし）      : §1 出荷（#1289→#1292→#1177 同乗）→ staging → [G1] → prod → 検証チェックリスト
                                §2 棚卸し（#1182/#1122 close）
Phase 2（Phase 1 と並行可）    : PR-E プリフライト照会 + 変換 CLI（dry-run まで）→ [G2]
Phase 3（Phase 1 の後）        : P0 朝ドラフト PR-Z1 → Z2 → Z3（undo 基盤が本番にあることが前提）
Phase 4（Phase 3 と並行可）    : P1 写真取込 PR-P1（eval）→ P2 → P3（staging 到達点）→ [G3]
明文化（任意タイミング）       : §3.3-2 の層契約 3 行を構造設計書へ追記
```

各 PR は CI 全緑 + fresh Reviewer 経由で自律 merge（リポジトリ規律どおり）。並行させる場合は parallel-lanes.md に従いレーン claim。
