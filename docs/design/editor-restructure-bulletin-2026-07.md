# 教員エディタ再構成 ＋ 掲示板型パターン 実装設計書

- 日付: 2026-07-04
- ステータス: 設計確定（実装待ち）。実装は本設計書を正として別スレッドで行う
- 発端: 2026-07-04 UX 構造監査（台帳: `Desktop\app\_ux-discovery\v2\2026-07-04\指摘ログ.md`）。
  オーナー課題感「教員エディタがメイクセンスでない」の根因 3 つを実データで確証した回
- スコープ: v2 単独（portal / LP / 会社HP への横断影響なし）。掲示板型は**新デザインパターンの追加**であり、
  presence / config の契約は不変更 → TV ブリッジ端末（tv-ble-bridge）の APK 改修は**不要**
  （端末は `tv_devices.signage_url` をそのまま開くだけ。パターンは `?design=` クエリで web 側が解決する
  — `apps/web/lib/signage/design-pattern.ts:9-16`）
- デザインモック（合意済の見た目）: セッション scratchpad の `editor-redesign-mock.html`（Artifact 公開済）。
  日付セグメント・3 ゾーン・掲示板型語彙・⠿/★/区切り線/固定行の見た目はこれが基準
  （リポジトリ外なので §3 に要点を文章化してある。齟齬があればモックが優先）

---

## 0. 背景 — 監査で確定した根因 3 つ（指摘ログ 2026-07-04）

1. **語彙の不一致**（v2-ed47-1 **P1** / -5 / -7）: 部屋型盤面（岐阜工業・進路指導室前
   `class_id 7a18ca87-4bcf-4fa7-bb21-bd2cb8231df3`・本番 pattern3）にクラス語彙
   （時限×科目・生徒呼び出し・来校者・基本時間割）を強制。実データで、教員は予定欄に
   「------------------」のダッシュ行（盤面上のスペーサ）、生徒呼び出し欄に「------ 校訓 ------」
   「礼儀正しく 勤労を尊び…」を入力して掲示板を"ハック"して運用している（回避行動＝動かぬ証拠）。
2. **時間モデルの不一致**（v2-ed47-2 / -3 / -6）: 「今日」中心設計 ＋ 今日/選択日の 2 編集スタック並存。
   実運用は「前日夕方・休日に**次の授業日**を仕込む」なのに、その導線が最遠
   （折りたたみ→カレンダー→クリック→最下部）。
3. **層の混在**（v2-ed47-4）: 日常編集／週次計画／端末操作が 1 ページ同階層で縦積み。

付随の確定不整合（v2-ed47-5）: AI 歓迎文（`apps/web/app/app/editor/_components/EditorChat.tsx:50-51`）と
前日/前週コピーの対象・文言（`apps/web/lib/editor/copy-day-actions.ts:95-97,110,215`）が常に
「予定・連絡・提出物」固定で、pattern2/3 の呼び出し/来校者が対象外。

---

## 1. オーナー決定事項（2026-07-04 確定。再検討しない）

1. **掲示板型 = 新 pattern・既存ブロック合成**: `PATTERN_BLOCKS` に掲示板型 pattern を 1 つ追加
   （本設計では **pattern5** と命名）。blocks = **notice を主役（大きく表示）** + schedule（時刻フォーマット表示）
   + news, weather, ad。エディタは「お知らせ」「今日の予定」の 2 セクションのみ
   （callout / visitor / 基本時間割は出さない）。**新ブロック種別・新テーブルは作らない**。
2. **自由度 v1 = 基本セット＋固定行**: ⠿並べ替えと★重要を全教員入力セクションへ横展開
   （連絡には D&D #1124 と重要フラグが実装済→それを他へ）、**区切り線**（ダッシュ行ハックの正規化・行タイプ）、
   時限の自由入力（0限・放課後など。時限なしは #1192 対応済）、**固定行**＝連絡の表示日数に
   「ずっと（無期限）」を追加するだけで実現（新テーブル不要）。カスタムブロック（見出し自由）は v1 スコープ外。
3. **既定対象日 = 休日＋放課後は翌授業日**: エディタは対象日セグメント
   （時系列順: 今日→翌授業日→…→📅カレンダー）の**単一スタック**に再構成。既定選択は
   「授業日の下校時刻（既定 16:00）まで＝今日、それ以降と休日＝次の授業日」。切替時刻は
   school_configs（display_settings 系）で学校ごとに変更可。今日+選択日の 2 スタック並存（`?plan=`）は
   **廃止**し `?date=` に一本化。3 ゾーン分層（毎日の編集／計画＝前日・前週コピー・基本時間割・カレンダー／
   このモニタ＝サイネージを開く・黒画面）。
4. **移行 = 切替時に一括移行**: 進路指導室前（`7a18ca87-4bcf-4fa7-bb21-bd2cb8231df3`）の既存ハックデータ
   （予定のダッシュ行→区切り線、呼び出し欄の校訓→固定行 or お知らせ）を切替日に移行する手順/スクリプトを
   設計に含める（§8 / PR-E）。

---

## 2. 現状コード地図（2026-07-04 に origin/main = b7ad8422 の実コードで確認済み）

### エディタ

| 対象 | パス・アンカー |
|---|---|
| クラス編集画面（2 スタックの現構造） | `apps/web/app/app/editor/[classId]/page.tsx` — `?date`/`?plan` の受け口 L57,64-75／今日スタック L229-254／`?plan` スタック L302-342／中間ゾーン混在（時間割 L279-283・カレンダー L284-289・前週コピー L295-297・サイネージリンク L349-360・黒画面 L364-369）／AI FAB L377-392 |
| WYSIWYG 盤面エディタ（パターン駆動出し分け・**既に実装済**） | `.../_components/WysiwygBoardEditor.tsx:185-194`（`patternIncludesBlock` で予定/連絡/提出物を出し分け）。セクション見出しは `EditorCard title="予定"` 等の**ハードコード文字列**（L233 付近, 連絡 L257 付近） |
| 月カレンダー（`?plan` ルーティングの発生源） | `.../_components/EditorDateCalendar.tsx:122-133`（`go()` が `router.push(…?plan=)` L132） |
| 前日/前週コピー UI | `.../_components/CopyPreviousDayButton.tsx` / `CopyPreviousWeekButton.tsx`（成功時 `?copied=<ts>` 再ナビ→エディタ再マウント。page.tsx L65-69） |
| 連絡エディタ（**D&D・★・表示日数の既存実装＝横展開の種**） | `.../_components/NoticeEditor.tsx` — 表示日数プリセット L54-61／★重要 L259-265／⠿ D&D `useRowReorder` L188-193 |
| 予定エディタ（時限 select・**自由入力は実装済**） | `.../_components/ScheduleEditor.tsx` — `(時限なし)` L358／`その他`（自由入力）L365-371 |
| 時限の型・検証（単一ソース） | `apps/web/lib/editor/schedule-core.ts` — `CustomPeriod` L241-249／並び順キー（custom=2000, 時限なし=3000, **安定ソート**）L279-301／`validateScheduleItems`（数値時限のみ重複拒否・末尾で slot ソート）L429-501 |
| 連絡/提出物の型・検証 | `apps/web/lib/editor/notice-assignment-core.ts` — `NoticeItem` L30／`NOTICE_MAX_DISPLAY_DAYS=14` L41／displayDays 検証（1..14 整数のみ）L92-103／提出物は期限昇順ソート L140 |
| 前日/前週コピー action | `apps/web/lib/editor/copy-day-actions.ts` — 3 セクション固定書込 L95-97,146-148／固定文言 L110,215 |
| AI: パターン準拠セクション解決（**既に単一ソース consume 済**） | `apps/web/lib/editor/assistant-sections.ts:22-53`（`resolveAllowedSections` / `resolveManualSectionLabels`。pattern 追加に無改修追従） |
| AI: 歓迎文（**固定文言＝不整合の残り**） | `apps/web/app/app/editor/_components/EditorChat.tsx:50-51`（使用 L413） |

### サイネージ・データ層

| 対象 | パス・アンカー |
|---|---|
| パターン union・URL 合成（pattern 追加箇所①） | `apps/web/lib/signage/design-pattern.ts` — `SIGNAGE_DESIGN_PATTERNS` L19／ラベル L27-32／`SIGNAGE_SCHEDULE_DAY_COUNT` L52-57／`applyDesignPatternToUrl` L147-158 |
| パターン→ブロックの単一ソース（pattern 追加箇所②） | `apps/web/lib/signage/pattern-blocks.ts` — `PATTERN_BLOCKS` L115-128／`SIGNAGE_BLOCK_META`（label は盤面 aria-label と一致・ドリフトガード対象）L73-89／`PATTERN_BLOCK_ROW_CAPACITY` L184-194 |
| 盤面レンダラ（pattern 追加箇所③＝専用レイアウト） | `apps/web/app/(signage)/signage/[classToken]/_components/SignageBoardView.tsx` — `PATTERN_BOARDS` dispatch L168-188／専用レイアウトの前例 `Pattern3Board` L411・`Pattern4Board` L472 |
| データ取得ゲート（pattern 追従・無改修） | `apps/web/lib/signage/signage-display.ts:276-311`（`patternIncludesBlock` で来校者/呼び出し/センサ/鉄道/ニュース/警報を出し分け） |
| 連絡の表示期間・遡及窓 | `apps/web/lib/signage/effective-daily-data.ts` — `isNoticeActive` L157-166／`EFFECTIVE_LOOKBACK_DAYS=31` L133／窓クエリ L310-327。**同じ窓を学校管理ハブ `hub-queries.ts` も共有**（L131-133 コメント） |
| 盤面の行フォーマッタ（★の描画先） | `apps/web/lib/signage/section-format.ts:109-115`（連絡のみ `isHighlight`→`emphasis`） |
| school_configs（切替時刻の置き場所） | `packages/db/src/schema/school-configs.ts` — `kind`: display_settings / quiet_hours / schedule_templates（L13）・`value` は **opaque JSONB**（L32）→ **キー追加に migration 不要**。JSONB からの defensive parse の前例 = `parseSignageDesignPattern`（design-pattern.ts:79-87） |
| 営業日計算（土日スキップ・祝日非考慮） | `apps/web/lib/signage/rotation.ts` — `jstDateString` L116／`signageScheduleDates` L137／`previousBusinessDay` L180 |
| migration 採番 | `packages/db/migrations/` — **0036 まで使用済**（⚠ 0030 が 2 本ある採番事故あり。予約時は必ず `ls` で確認） |

### 重要な事実（実装者向け）

- **時限の自由入力・時限なしは実装済み**（`ScheduleEditor.tsx:355-371` / `schedule-core.ts:241-249`）。
  オーナー決定 2 のうち「時限の自由入力」は**新規実装不要**。掲示板型の「時刻フォーマット表示」は
  この既存 `CustomPeriod`（自由入力）に時刻文字列（例 `13:00〜`）を入れるだけで成立する（§6.2）。
- **⠿ D&D は連絡（#1124）だけでなく来校者・呼び出しにも実装済み**
  （`VisitorsEditor.tsx` / `CalloutsEditor.tsx` が `useRowReorder` を使用。DB 側 sort_order は
  migration 0034/0035）。横展開の残りは**予定・提出物**のみ（§5.1）。
- ★重要（isHighlight）は**連絡のみ**。予定・提出物は JSONB（daily_data）なので migration 不要、
  来校者・呼び出しは**実テーブル**（`class_visitors` / `student_callouts`）なので列追加 migration が要る（§5.2）。
- 連絡・予定・提出物は `daily_data` の **opaque JSONB**（正式スキーマは TS の validate が確定する
  — `notice-assignment-core.ts:5-9`）。**行タイプ追加（区切り線）・フラグ追加（固定行）に DB migration は不要**。
- エディタの再マウント規律: `key={date}:{copied}`（page.tsx:246-254, 65-69）。これを崩すと
  「旧日付の入力が新日付に保存される」混線バグが再発する（2026-06-16 の実バグ）。単一スタック化でも維持する。
- 盤面には**リージョンドリフトガード**がある（`SIGNAGE_BLOCK_META.label` ＝盤面 `aria-label`、
  `apps/web/__tests__/signage/SignageClient.test.tsx`）。pattern 追加時はテストのリージョン集合も更新する。

---

## 3. 全体設計 — 単一スタック・3 ゾーン（オーナー決定 3）

### 3.1 画面構成（モック `editor-redesign-mock.html` の文章化）

```
[パンくず: 戻る ／ 進路指導室前]
┌─ ゾーン1: 毎日の編集 ────────────────────────────┐
│ 対象日セグメント: [今日 7/4(土)] [7/6(月) 翌授業日] [7/7(火)] … [📅]   │
│   （時系列順・既定選択は §3.2 のルール。📅 で月カレンダーが開く）        │
│ 盤面ライブプレビュー（WysiwygBoardEditor・選択日に追随）               │
│ 編集セクション（パターン駆動: pattern5 なら お知らせ／今日の予定 のみ）  │
└──────────────────────────────────────────┘
┌─ ゾーン2: 計画 ─────────────────────────────────┐
│ 前日コピー ／ 前週コピー ／ 基本時間割を設定 → ／ 月カレンダー           │
└──────────────────────────────────────────┘
┌─ ゾーン3: このモニタ ────────────────────────────┐
│ このクラスのサイネージを開く → ／ サイネージを黒画面にする              │
│ （school_admin のみ: 広告管理 → ／ 静粛時間 → もここへ集約）           │
└──────────────────────────────────────────┘
```

- **編集スタックは常に 1 つ**。セグメントで対象日を切り替えると、プレビュー・編集セクション・AI FAB・
  前日コピーがすべてその日に追随する（現状の「選択した日はプレビュー無し・見出し色だけが識別子」
  — page.tsx:299-342 — を解消。v2-ed47-3/6）。
- セグメントの並びは**時系列**: 今日（授業日でなくても常に先頭に出す＝「今日の盤面に何が映っているか」の
  確認用途を殺さない）→ 翌授業日 → その次の授業日（計 3〜4 個・実装時に調整）→ 📅（任意日）。
  各セグメントには曜日と「翌授業日」バッジを添える。
- 📅 は既存 `EditorDateCalendar` の月グリッドを再利用する（内容ドット・過去日無効化のロジックは温存。
  `?plan` push（EditorDateCalendar.tsx:132）を `?date` push に変えるだけ）。
  折りたたみトグル「別の日も準備する」と説明文 hint（L199）は**廃止**（単一スタック化で構造が自明になる
  — v2-ed47-6 の指摘どおり説明文が要る時点で負け）。

### 3.2 既定対象日ルール（オーナー決定 3・単一ソース化）

```
resolveDefaultEditorDate(now, cutover):   // 新設: apps/web/lib/editor/default-date.ts（純関数・テスト必須）
  today = jstDateString(now)                        // rotation.ts:116
  if (isSchoolDay(today) && jstTime(now) < cutover) return today
  return nextSchoolDay(today)                        // 土日スキップ（rotation.ts の営業日ロジックの前向き版）
```

- **授業日判定は v1 では「土日スキップ」のみ**（祝日非考慮）。これは盤面の「次の N 平日」・前日コピーの
  `previousBusinessDay`（rotation.ts:177-180 の注記どおり）と**同一制約で一貫**させる。祝日・休校日は
  `school_calendar_events`（ADR-045・iCal キャッシュ）が既にあるため将来拡張ポイントとして §9 に記す。
- **切替時刻（下校時刻・既定 16:00）**: `school_configs` の `kind='display_settings'` `scope='school'` の
  `value.editorDayCutover`（`"HH:MM"` 文字列）。**migration 不要**（value は opaque JSONB・
  school-configs.ts:32）。パースは `parseSignageDesignPattern`（design-pattern.ts:79-87）と同じ
  defensive 作法（形不正・欠落は既定 `"16:00"` に fail-soft）。学校ごとの変更 UI は v1 では既存の
  `/ops/school-configs`（`apps/web/app/ops/school-configs/page.tsx`）から system_admin が設定する
  （学校管理画面への露出は follow-up）。
- 適用箇所は **`?date` 無指定時の初期値のみ**。URL に `?date=` があれば常にそれが勝つ（deep link 安定）。

### 3.3 `?plan=` 廃止と後方互換

- page.tsx の searchParams を `{ date?, copied? }` に縮退。`?plan=X` が来たら
  `redirect(/app/editor/[classId]?date=X)`（Next `redirect()`・恒久 URL ではないので 307 で十分）。
  ブックマーク・履歴・進行中タブを壊さない。
- `planData` の二重データ取得（page.tsx:114-138）・`SELECTED_DAY_ANCHOR_ID` スクロール機構
  （EditorDateCalendar.tsx:33-36, 85-94）・見出し色による今日/未来の識別（page.tsx:438-450）は削除。
- `CopyPreviousDayButton` の `?copied=` 再ナビは**現在の `?date=` を保持**して付与する（要確認ポイント:
  現実装が URL をどう組むか。選択日の入力を巻き戻さないこと）。
- `copyPreviousWeekAction`（copy-day-actions.ts:164-232）は「JST 今日を含む週」固定。単一スタック化後も
  仕様は据え置き（計画ゾーンの説明文で「今週へ複製」と明示する）。選択日基準の週コピーは v1 スコープ外。

---

## 4. 機能設計 F 群一覧（PR 分割は §7）

| # | 機能 | 対応する決定 | 主な変更ファイル |
|---|---|---|---|
| F-A | 単一スタック＋日付セグメント＋3 ゾーン＋既定対象日＋`?plan` 廃止 | 決定 3 | editor/[classId]/page.tsx, EditorDateCalendar.tsx, 新 default-date.ts |
| F-B1 | ⠿/★ の横展開（予定・提出物・来校者・呼び出し） | 決定 2 | schedule-core.ts, notice-assignment-core.ts, 各エディタ, section-format.ts, migration 0037 |
| F-B2 | 区切り線（行タイプ・予定＋連絡） | 決定 2 | schedule-core.ts, notice-assignment-core.ts, ScheduleEditor/NoticeEditor, SignageBoardView, section-format.ts |
| F-C | 固定行＝表示日数「ずっと」 | 決定 2 | notice-assignment-core.ts, NoticeEditor.tsx, effective-daily-data.ts, hub-queries.ts |
| F-D | 掲示板型 pattern5（盤面＋エディタ 2 セクション＋AI/コピーの pattern 動的化） | 決定 1（＋v2-ed47-5） | design-pattern.ts, pattern-blocks.ts, SignageBoardView.tsx, signage.module.css, WysiwygBoardEditor.tsx, EditorChat.tsx, copy-day-actions.ts |
| F-E | 進路指導室前の一括移行 | 決定 4 | 新 CLI スクリプト（packages/db）＋運用手順 |

---

## 5. 自由度 v1（オーナー決定 2）

### 5.1 ⠿並べ替えの横展開（F-B1）

現状: 連絡=配列順が盤面順で D&D 済（NoticeEditor.tsx:39-43, 188-193）。来校者・呼び出しも D&D 済
（sort_order 0034/0035）。**残りは予定・提出物**で、両者はサーバ側で強制ソートされる
（予定: slot キー順 schedule-core.ts:499／提出物: 期限昇順 notice-assignment-core.ts:140）。

**設計: 「同一ソートキー内の並べ替え」として実装する（強制ソートは崩さない）**

- 両 validate のソートは**安定ソート**なので、同一キーの行は**入力配列順を保持**する。つまり
  - 予定: 同じ時限バケット内（複数の「放課後」・複数の「その他（custom=2000）」・複数の「時限なし（3000）」
    — schedule-core.ts:279-301）は、配列順＝保存順＝盤面順。**D&D がそのまま効く**。
  - 提出物: 同一期限内は配列順が効く。
- エディタは予定・提出物にも `DragHandle` + `useRowReorder` を付け、ドロップ後に**クライアント側でも
  同じ slot キーで安定再ソート**して見た目と保存結果を一致させる（別バケットへ跨いだドロップは
  スナップバック＝時限順という時間割の意味論を壊さない）。
- **掲示板型（pattern5）ではこれが実質フル自由並べ替えになる**: 掲示板の予定行は「その他（時刻文字列）」
  「時限なし」しか使わないため全行が同一バケットに入り、D&D で完全に自由に並ぶ（§6.2）。
  クラス盤面では数値時限の時限順が守られる。**新しい順序フィールドを追加しない**のがこの設計の要
  （JSONB 契約・盤面描画・AI 下書き経路すべて無改修）。

### 5.2 ★重要の横展開（F-B1）

- **予定・提出物**: `ScheduleItem` / `AssignmentItem` に `isHighlight?: true` を追加
  （schedule-core.ts:351-358 / notice-assignment-core.ts:38。JSONB なので **migration 不要**。
  validate は `rec.isHighlight === true` のみ受理＝連絡と同作法 notice-assignment-core.ts:87-89）。
- **来校者・呼び出し**: 実テーブルのため **migration 0037**（§10）で `is_highlight boolean NOT NULL
  DEFAULT false` を `class_visitors` / `student_callouts` に追加。RLS は既存 policy が行単位なので
  追加作業なし。既存 INSERT/SELECT（visitors-core / callouts-core）に列を通す。
- **盤面描画**: `section-format.ts` の各フォーマッタが連絡と同じ `emphasis` を返す
  （現状は連絡のみ L109-115）。盤面 CSS の emphasis 表現（橙アクセント・太字）は既存の連絡★と同一視覚言語。
- エディタ UI は NoticeEditor の「詳細」パネル方式（RowDetailToggle）を各エディタに横展開する。

### 5.3 区切り線（F-B2・ダッシュ行ハックの正規化）

- **対象セクションは v1 では予定と連絡（＝お知らせ）のみ**（ハックが観測された箇所＋掲示板型の
  2 セクション。提出物・来校者・呼び出しは需要未観測のため見送り）。
- データ表現: 行タイプの導入。`ScheduleItem` / `NoticeItem` に `kind?: "divider"` を追加。
  - divider 行は `subject` / `text` の必須検証を免除（**任意ラベル**として許容: 「------ 校訓 ------」の
    見出し用途を汲む。空なら純粋な罫線）。`isHighlight` / `displayDays` は divider では無視（validate で剥がす）。
  - 予定の divider の並び順: `period` を持たない divider は時限なしキー（3000）に落ちて末尾へ行ってしまうため、
    **divider は slot ソートの対象外＝配列上の位置を保持**する（validate のソートを「divider を挟んで区間ごとに
    ソート」に変更）。これで「1〜3限 ／ ─── ／ 午後の部」のような区切りが成立する。
  - 検証: `validateScheduleItems` / `validateNoticeItems` に divider 分岐を追加（不正 kind 値は拒否）。
- 盤面描画: `section-format.ts` が `{ divider: true, label? }` の表示行を返し、`SignageBoardView` の
  行レンダラが水平罫線（ラベル付きなら中央にラベル）を描く。ページング（board-paging.ts）上は 1 行として数える。
- エディタ UI: 各セクションの行追加ボタン脇に「＋区切り線」を置く（モック準拠）。divider 行は
  本文入力の代わりにラベル入力（任意・placeholder「ラベル（省略可）」）と ⠿・削除だけを出す。
- 後方互換: 旧リーダ（デプロイスキュー中の盤面）は divider 行の text/subject が空だと空行として出る
  程度の劣化で済む（fail-soft。実害は数分のスキュー窓のみ）。

### 5.4 固定行＝表示日数「ずっと」（F-C）

**設計判断: `displayDays` の番兵値ではなく、独立フラグ `pinned?: true` で表す。**

- 理由:
  1. `displayDays` は「1..14 の整数」検証（notice-assignment-core.ts:92-103）で、上限
     `NOTICE_MAX_DISPLAY_DAYS=14` は**サイネージの遡及読み取り窓の根拠**
     （effective-daily-data.ts:130-133 `EFFECTIVE_LOOKBACK_DAYS=31`）。巨大値や 0 番兵を通すと
     「窓の根拠」という不変条件が壊れ、読み手全員（盤面＋学校管理ハブ hub-queries.ts）の再点検が要る。
  2. `pinned: true` は旧リーダに対して fail-soft（`isNoticeActive` は displayDays 欠落を 1 と読む
     — effective-daily-data.ts:157-166 — ので、スキュー中は「入力日のみ表示」に劣化するだけで壊れない）。
  3. 意味が自明（「ずっと」は期間の一種ではなく**固定**という別概念）。
- データ: `NoticeItem` に `pinned?: true` を追加（JSONB・**migration 不要**）。pinned のとき
  `displayDays` は保存しない（validate で剥がす）。
- 読み取り: `isNoticeActive` を「`pinned===true` なら `diff >= 0` で常に活性」に拡張。
  **遡及窓の外の pinned を拾う**ため、`getEffectiveDailyData` の窓クエリ（effective-daily-data.ts:310-327）に
  OR 分岐を 1 本足す: `date < windowStart AND notices @> '[{"pinned":true}]'`（JSONB 包含）。
  クラスの daily_data は高々 1 行/日×scope なので全期間スキャンでも実害なし（岐南 1 年運用で数百行）。
  性能が問題化したら partial GIN index を後から足す（v1 では張らない・§10）。
  同じ拡張を**学校管理ハブの読み手**（`apps/web/lib/school-admin/hub-queries.ts`・
  EFFECTIVE_LOOKBACK_DAYS の共有先）にも適用し、実表示との整合を保つ。
- エディタ UI: NoticeEditor の表示日数 select（L275-295）に「ずっと」を追加
  （`DISPLAY_DAYS_PRESETS` の末尾ではなく select の独立 option・値は `"pinned"` 番兵→保存時に
  `pinned:true` へ写像）。「設定あり」判定 `hasNoticeDetail`（L74-76）にも pinned を含める。
- **削除経路が生命線**: pinned は自然消滅しないので、エディタで「今表示中の固定行」が**対象日に関係なく
  常に見えて削除できる**必要がある。エディタの連絡初期値は現状「対象日の行」だけ
  （`getClassNotices(tx, classId, date)` — page.tsx:84）なので、pinned 行は**入力日以外の日のエディタに
  出てこない＝見えない幽霊**になる。→ F-C で連絡セクションに「固定中のお知らせ」小リスト（入力日と本文＋
  削除ボタン）を追加し、削除は**入力日の行の置換保存**として実装する（保存経路は既存の
  `setNoticesAction` を入力日向けに呼ぶ＝新 action 不要）。これを v1 の受入基準に含める（§11）。

---

## 6. 掲示板型 pattern5（オーナー決定 1・F-D）

### 6.1 パターン定義（「pattern 追加＝1 行で全消費者追従」の作法に乗る）

| 変更箇所 | 内容 |
|---|---|
| `design-pattern.ts:19` | `SIGNAGE_DESIGN_PATTERNS` に `"pattern5"` 追加 |
| `design-pattern.ts:27-32` | ラベル `pattern5: "パターン5（掲示板型・お知らせ主役）"` |
| `design-pattern.ts:52-57` | `SIGNAGE_SCHEDULE_DAY_COUNT.pattern5 = 1`（「今日の予定」1 列のみ。多日グリッドを出さない） |
| `pattern-blocks.ts:115-128` | `pattern5: ["notice", "schedule", "news", "weather", "ad"]`（notice 先頭＝主役・エディタ順もこれに追従） |
| `pattern-blocks.ts:184-194` | `PATTERN_BLOCK_ROW_CAPACITY.pattern5 = { notice: 5, schedule: 5 }`（初期値。実機文字サイズで調整・盤面ページング boardPageSize もこれに追従） |

これだけで、データ取得ゲート（signage-display.ts:276-311）・エディタ出し分け
（WysiwygBoardEditor.tsx:185-194 → お知らせ＋予定のみ表示・提出物/来校者/呼び出しは自動で消える）・
AI の許可セクション（assistant-sections.ts:33-42 → schedules+notices）が**無改修で追従**する。
残る手作業は盤面レイアウト（§6.3）とラベル（§6.2）。

### 6.2 語彙: パターン別ラベルの上書き機構（新設・小）

`SIGNAGE_BLOCK_META.label` は全パターン共通（pattern-blocks.ts:73-89）で、盤面 aria-label・エディタ見出し・
AI 振り分けラベルが共用する。掲示板型では notice=「お知らせ」/ schedule=「今日の予定」と呼びたいので、
**pattern-blocks.ts に上書きマップを 1 つ追加**する:

```ts
export const PATTERN_BLOCK_LABEL_OVERRIDES:
  Partial<Record<SignageDesignPattern, Partial<Record<SignageBlockKind, string>>>> = {
  pattern5: { notice: "お知らせ", schedule: "今日の予定" },
};
export function blockLabel(pattern: SignageDesignPattern, kind: SignageBlockKind): string; // override ?? META.label
```

- 消費者: Pattern5Board の region `aria-label`／WysiwygBoardEditor の `EditorCard title`（現状ハードコード
  "予定"・"連絡" → `blockLabel(pattern, kind)` に置換。**他パターンは値が変わらないので e2e 非破壊**）／
  AI の歓迎文・手入力誘導ラベル（assistant-sections.ts:49-53 も `blockLabel` を引くよう変更）。
- ドリフトガード（SignageClient.test.tsx）は「盤面の region 集合 = hasRegion ブロックの**ラベル**集合」の
  照合を `blockLabel(pattern, …)` 基準に更新する（機構は不変・参照先だけパターン対応）。

「時刻フォーマット表示」: 掲示板の予定行は既存 `CustomPeriod`（自由入力・schedule-core.ts:241-249）に
時刻文字列（`13:00〜` 等）を入れて表す。**新しい時刻フィールドは作らない**。pattern5 のエディタでは
時限 select を出さず、時刻テキスト入力（内部的には custom）を第一カラムにする
（ScheduleEditor に `variant="time"` 的な表示切替 prop を足す。保存形は不変）。placeholder は「13:00」。

### 6.3 盤面レイアウト Pattern5Board（専用レイアウト・Pattern4Board 前例）

- `SignageBoardView.tsx` に `Pattern5Board` を追加し `PATTERN_BOARDS`（L168-188）に 1 行登録。
  前例: `Pattern4Board`（L472〜）＝「schedule を持たない例外」を既にレイアウト層だけで実現している。
- レイアウト（モック基準）:
  - ヘッダー: 実時計＋日付＋天気（pattern3 と同じ時刻主役ヘッダーの流用）
  - **主役 = お知らせ**: 左 2/3 を占める大型タイポ（★行は橙アクセント・区切り線は罫線描画）。
    行数超過は既存ページング（`boardPageSize` = ROW_CAPACITY 経由）で自動送り
  - 右 1/3 = 今日の予定: 「時刻ラベル＋内容」の縦リスト（`scheduleSlotLabel` がそのまま custom 文字列を返す
    — schedule-core.ts:303-312）
  - フッタ: 時事ニュース 1 件自動送り（`Pattern3NewsTicker` 流用・#1156 の作法）
  - 広告 aside: 既存共通（`ad` は hasRegion=false の complementary landmark） 
- CSS は `signage.module.css` に p5 セクションを追加。文字サイズは盤面設計指針
  （`盤面設計指針-研究-2026-06-30.md`: コントラスト 7:1・滞留 5-10s・色非依存）に従い、
  お知らせ本文は pattern3 の拡大タイポ以上を初期値にする（実機実測で調整）。

### 6.4 AI・前日/前週コピーの pattern 動的化（v2-ed47-5 の根治）

- **歓迎文**: `EditorChat.tsx:50-51` の固定 `GREETING` を関数化
  `greetingFor(pattern)` — `resolveAllowedSections(pattern)` のラベル列（blockLabel 経由）と
  `resolveManualSectionLabels(pattern)`（手入力誘導）から合成する。page.tsx は既に pattern を解決している
  （L95）ので prop で渡すだけ。例: pattern5 →「…お知らせ・今日の予定にまとめて下書きします。」
  pattern2/3 →「…予定にまとめて下書きします。生徒呼び出し・来校者一覧は下のフォームから入力してください。」
  （ADR-034: 氏名は AI 生成しない、の既存規律を文言でも保つ）
- **前日/前週コピー**: `copy-day-actions.ts` の `copyOneDay`（L132-150）と `copyPreviousDayAction`
  （L78-104）を pattern 対応にする:
  1. tx 冒頭でクラスの実効パターンを解決（page.tsx:91-95 と同じ `getClassSignageUrl` +
     `getSignageDesignPattern` + `resolveDesignPattern`）
  2. コピー対象 = `editableBlocksForPattern(pattern)`。daily_data 系（schedules/notices/assignments）は
     既存の `upsertDailySectionForTarget`、**visitor/callout は実テーブルの日付行コピー**
     （`class_visitors.visit_date` — class-visitors.ts:48 — / `student_callouts` の同等列。既存の
     visitors-core / callouts-core の書込コアを再利用し、対象日の行を置換）
  3. 「複製できるものが無い」判定・成功/失敗メッセージ（L110, 215）を対象ブロックのラベル列で合成
  - 固定行（pinned）はコピー対象から**除外**する（既に全日表示されており、コピーすると重複表示になる）。
    区切り線はコピー対象に**含める**（レイアウトの一部）。

---

## 7. PR 分割（各 ≤500 行・1PR 1 機能・migration は独立 PR に載せない方針は 0034/0035 前例に従う）

| PR | 内容 | migration | 依存 | 並行可否 |
|---|---|---|---|---|
| **PR-A** | 単一スタック化＋日付セグメント＋3 ゾーン。`?plan`→`?date` 一本化（redirect 互換）・`resolveDefaultEditorDate`（school_configs `editorDayCutover` 読み・既定 16:00）・EditorDateCalendar のセグメント/📅化 | なし | なし | B/C/D と並行可 |
| **PR-B** | 自由度基本セット: ⠿ D&D を予定・提出物へ（同一キー内・§5.1）／★ を予定・提出物・来校者・呼び出しへ（§5.2）／区切り線（予定・連絡・§5.3）／盤面 emphasis/divider 描画 | **0037**（class_visitors / student_callouts に is_highlight） | なし | A と並行可 |
| **PR-C** | 固定行: `pinned` フラグ＋「ずっと」select＋遡及窓の pinned 分岐（effective-daily-data + hub-queries）＋「固定中のお知らせ」削除導線（§5.4） | なし | **PR-B の後**（NoticeEditor の詳細パネル・validate を両方が触る＝コンフリクト回避の直列化。機能依存は無し） | A/D と並行可 |
| **PR-D** | 掲示板型 pattern5: union+PATTERN_BLOCKS+ROW_CAPACITY+DAY_COUNT＋`Pattern5Board`+CSS＋ラベル上書き機構＋エディタ 2 セクション（時刻入力 variant）＋AI 歓迎文/コピーの pattern 動的化（§6） | なし | **PR-B**（区切り線・★を盤面が描く）・**PR-C**（固定行＝校訓の受け皿）。プレーンな pattern5 だけなら B/C 無しでも動くが、移行（PR-E）の前提を揃えるため B→C→D の順を推奨 | A と並行可 |
| **PR-E** | 進路指導室前の一括移行: 変換スクリプト＋切替手順 runbook（§8） | なし（データ変換のみ） | **PR-A〜D 全部が prod 反映済み**であること | 単独・最後 |

- 行数見積: A ≈ 400（page.tsx 再構成＋カレンダー改修＋新純関数＋テスト）／B ≈ 450（4 エディタ＋2 core＋
  盤面描画＋migration＋テスト）／C ≈ 250／D ≈ 500 弱（盤面 1 枚＋CSS が主）／E ≈ 200。
  D が溢れそうなら「D1: pattern5 盤面＋定義」「D2: AI/コピー動的化」に割る（D2 は独立レビュー可能）。
- どの PR も docs/STATUS.md 更新・deploy は含めない（デプロイは skill deploy-v2 のレーン）。

---

## 8. 進路指導室前の一括移行（オーナー決定 4・PR-E）

対象: `class_id = 7a18ca87-4bcf-4fa7-bb21-bd2cb8231df3`（岐阜工業・進路指導室前・本番 pattern3 LIVE）。

### 8.1 変換内容（監査で確証した実データ→新語彙）

| 現状（ハック） | 移行先 |
|---|---|
| `daily_data.schedules`（scope=class）の subject が全てダッシュ類（`/^[-‐−–—ー―_＿=＝\s]+$/`）の行 | 区切り線行 `{ kind: "divider" }`（ラベル無し） |
| `student_callouts` の「------ 校訓 ------」行 | お知らせの区切り線行（ラベル「校訓」）＋固定 |
| `student_callouts` の校訓本文（「礼儀正しく 勤労を尊び…」等・呼び出しではない行全部） | お知らせの**固定行** `{ text, pinned: true }` |
| 実在の呼び出し（あれば・氏名を含む行） | 移行しない（pattern5 に呼び出し枠は無い。切替前に現地確認し、必要なら通常のお知らせに手動転記） |

### 8.2 手順（切替日に一括・人間ゲート付き）

1. **事前（いつでも可）**: 変換スクリプトを dry-run で流し、変換対象行の一覧を出力して**人間が確認**する。
   スクリプトは `packages/db/src/` の seed-* CLI 前例（`seed-ginan-signage-cli.ts` 等）に倣った一回性 CLI
   （案: `migrate-shinro-bulletin-cli.ts`）。書込は daily_data / student_callouts のみ・監査カラムは
   システム作成規約（created_by/updated_by=null）・RLS は system_admin コンテキスト。
   dry-run 既定・`--apply` で実書込（creative-orphan-cleanup cron と同じ fail-safe 作法）。
2. **切替（授業時間外に実施）**:
   a. スクリプト `--apply`（daily_data の予定ダッシュ行→divider・callouts→pinned お知らせ・元 callout 行削除）
   b. TV 設定編集 UI（管理画面のデザインパターン ドロップダウン）で当該端末を pattern5 に変更
      （内部は `applyDesignPatternToUrl` — design-pattern.ts:147-158 — が `signage_url` に
      `?design=pattern5` を合成。端末は config ポーリングで自動追従・APK 無改修）
   c. 実機盤面を目視（お知らせ主役で校訓・区切り線・時刻付き予定が出ること）
3. **ロールバック**: b を pattern3 に戻すだけで盤面は旧表示に戻る（データ変換は非破壊方向:
   divider/pinned は pattern3 盤面でも「空行/通常連絡」として fail-soft 表示される。呼び出し行の削除だけは
   戻らないため、スクリプトが削除前に JSON バックアップを stdout/ファイルへ吐くこと）。
- **本番 DB への適用は人間専任**（CLAUDE.md の migration 規律に準ずる運用。スキーマ変更ではないが
  本番 LIVE 盤面への不可逆データ操作のため同じゲートを踏む）。

---

## 9. スコープ外（明示）

- カスタムブロック（見出し自由の汎用ブロック）— オーナー決定 2 で v1 除外
- 祝日・休校日を考慮した授業日判定（school_calendar_events 連携）— §3.2 の将来拡張
- 教員着地ページの一斉表示/「その他」ラベル（v2-ed47-8）・時限プリセット既定（v2-ed47-7 岐南で要確証）
- 選択日基準の前週コピー（§3.3）・学校管理画面への切替時刻設定 UI 露出（§3.2）
- モバイル幅の検証（監査時 resize 不可で未検証 — 実装時に E2E で補う）

---

## 10. データ / migration まとめ

| 変更 | 方式 | migration |
|---|---|---|
| 切替時刻 `editorDayCutover` | school_configs `display_settings` の value（opaque JSONB）にキー追加 | 不要 |
| ★ 予定・提出物 / 区切り線 / 固定行 pinned | daily_data の opaque JSONB スキーマ拡張（TS validate が正） | 不要 |
| ★ 来校者・呼び出し | `class_visitors` / `student_callouts` に `is_highlight boolean NOT NULL DEFAULT false` | **0037**（次番。⚠ 0030 重複の採番事故前例あり — 予約時に `ls packages/db/migrations` で必ず確認。追加列のみ・RLS/監査トリガは既存のまま。staging 先行・prod 適用は人間専任 = skill apply-migration） |
| pinned の遡及読み JSONB 包含クエリ | インデックス**張らない**（行数極小）。性能問題が出たら partial GIN を後続 migration で | 当面不要 |
| pattern5 | コード定義のみ（`?design=` クエリ方式・tv_devices スキーマ非変更 — design-pattern.ts:9-16） | 不要 |

---

## 11. リスク・地雷（実装スレッドで必ず守る）

1. **`key={date}:{copied}` の再マウント規律を崩さない**（page.tsx:246-254）。単一スタック化で
   セグメント切替がソフトナビになるが、key が変わらないと旧日付の入力が新日付へ保存される混線バグが
   再発する（2026-06-16 実バグ・page.tsx:65-69 のコメントが正）。
2. **VisitorsCalloutsSection の安定キー教訓**（page.tsx:256-265）: 対象日ソフトナビ時の複製/押し出しバグの
   前例。ゾーン再配置時も条件付き短絡で同一親に隣接させない。
3. **置換保存＝空配列は全消去**。区切り線・pinned の validate 変更で「既存行が validate を通らなくなる」
   退行を絶対に出さない（既存 JSONB の全形を fixtures 化して validate の後方互換テストを書く）。
4. **`?plan` 廃止の互換**: redirect を必ず入れる。e2e（見出し「今日の編集」「選択した日の編集」に依存する
   strict locator）と `EditorDateCalendar` のアンカー機構が対象。RememberLastClass / CopyPreviousDayButton の
   URL 組み立てに `?date` 保持を確認。
5. **ドリフトガード**: pattern5 追加時、SignageClient.test.tsx の「描画 region 集合 ↔ hasRegion ブロック集合」
   照合をラベル上書き（§6.2）込みで更新。`PATTERN_BLOCK_ROW_CAPACITY` と CSS の可視行数
   （`--p5-*-visible` を作る場合）は対で変える（pattern-blocks.ts:165-183 の注意書きどおり）。
6. **AI の下書きシード一致**（page.tsx:383-389）: pattern5 で編集セクションが 2 つになっても
   initialDraft は盤面セクションと一致させる（seed を知らない下書きが per-section 置換で内容を消す穴）。
7. **pinned の読み手は 2 箇所**（盤面 effective-daily-data ＋ 学校管理ハブ hub-queries）。片方だけ直すと
   「ハブでは消えたのに盤面に出続ける」不整合になる。両方を同一 PR-C で。
8. **デプロイスキュー**: 新エディタで保存した divider/pinned を旧盤面が読む窓がある。fail-soft
   （空行/1 日表示への劣化）で壊れないことを §5.3/5.4 の設計で担保済みだが、PR-E（移行）だけは
   **全 PR の prod 反映後**に実施する。
9. **copyPreviousWeekAction の tx が visitor/callout コピーで肥大**する（pattern2/3 で 5 日×5 セクション）。
   タイムアウトと部分適用防止（現行は 1 tx 全ロールバック — copy-day-actions.ts:156）を維持する。
10. **正本ブランチ規律**: 実装着手時は必ず `git fetch && git rev-list --count HEAD..origin/main` で
    乖離確認（2026-07-02 の 103 コミット遅れ二重実装の再発防止。ルート CLAUDE.md §1）。

---

## 12. 受入基準

- **PR-A**
  1. 土曜 or 授業日 16:00 以降に開くと既定対象日が次の授業日になり、セグメント/盤面/編集/AI が全てその日を指す
  2. `?date=` 明示は常に優先。`?plan=X` の旧 URL は `?date=X` へ redirect
  3. 編集スタックは常に 1 つ・盤面プレビューが選択日に追随（旧「選択した日はプレビュー無し」の解消）
  4. 3 ゾーンの視覚分離（毎日の編集／計画／このモニタ）がモック相当
  5. 日付切替→入力→保存で内容が正しい日付に入る（key 規律・既存 e2e 緑）
- **PR-B**
  1. 予定・提出物で同一時限/同一期限内の D&D 並べ替えが保存・盤面に反映（数値時限の時限順は不変）
  2. 全教員入力セクションで★が付けられ盤面で emphasis 表示（既存の連絡★と同一視覚）
  3. 予定・連絡に区切り線（ラベル任意）を挿入・並べ替え・削除でき、盤面に罫線描画
  4. 既存 JSONB データ（★/表示日数/時限なし/custom/7-12 限）が全て従来どおり validate を通る
- **PR-C**
  1. 連絡の表示日数で「ずっと」を選べ、14 日超経過後も盤面・ハブに表示され続ける
  2. 固定中のお知らせが対象日に関わらずエディタに見え、削除できる
  3. 前日/前週コピーで pinned が重複コピーされない
- **PR-D**
  1. pattern5 端末の盤面: お知らせ主役＋今日の予定（時刻表示）＋ニュース/天気/広告。エディタは
     「お知らせ」「今日の予定」の 2 セクションのみ（提出物・呼び出し・来校者・基本時間割導線は出ない）
  2. AI 歓迎文・下書き対象・前日/前週コピーの対象と文言が各パターンの実セクションに一致
     （pattern1/2/3/4 の文言・挙動も pattern 実態と一致＝v2-ed47-5 クローズ）
  3. 既存 4 パターンの盤面描画・e2e に回帰なし（ドリフトガード緑）
- **PR-E**
  1. dry-run 一覧を人間確認→apply→pattern5 切替で、進路指導室前の実機にダッシュ行ゼロ・
     校訓が固定お知らせとして表示
  2. pattern3 へ戻すロールバックで盤面が壊れない（バックアップ出力あり）

---

## 13. 参照

- 監査台帳（発端・根因の証拠）: `Desktop\app\_ux-discovery\v2\2026-07-04\指摘ログ.md`
- デザインモック（見た目の正）: セッション scratchpad `editor-redesign-mock.html`（Artifact 公開済）
- 先行設計書（作法の型・3 層分類の前例）: `docs/design/editor-input-tiers-and-signage-paging.md`
- 盤面設計指針（タイポ/滞留/コントラストの根拠）: `盤面設計指針-研究-2026-06-30.md`（app ルート直下）
- ADR-034（氏名を AI に送らない）・ADR-043（news）・ADR-044（safety_alert）・ADR-045（school_calendar_events）
