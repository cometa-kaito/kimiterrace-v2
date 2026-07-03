# 教員エディタ入力支援 ＋ 盤面自動ページング 設計書

> ⚠ **読み方（2026-07-02 移植時の注記）**: 本書の §1〜§6 は旧作業ブランチ（`feat/editor-tiers-signage-paging`・
> origin/main から 103 コミット遅れの基底）を前提に書かれた**歴史的記録**。その後、main には別レーンが
> F2 相当（#1166/#1170 エディタ事前生成）・F1 の連続スクロール版（#1179 JS AutoScroll）・F4 相当
> （`EditorDateCalendar` #1189）を先に実装済みだったことが判明し、旧ブランチはデプロイせず**必要分だけ main へ
> 移植**した。**移植後の正は §7**（ファイル名・実装が §6 と異なる点は §7 が優先）。

- 日付: 2026-07-02
- ステータス: 設計確定（実装待ち）。実装は本設計書を正として別スレッドで行う
- スコープ: v2 単独（portal / LP / 会社HP への横断影響なし。`PATTERN_BLOCKS` の構造・presence 契約は不変更のため TV ブリッジ端末（tv-ble-bridge）の APK 改修も不要）
- 発端: 教員のコンテンツ入力を楽にする機能検討（2026-07-02 のオーナー判断を反映済み）

## 0. オーナー決定事項（この3点は確定。再検討しない）

1. **盤面の自動スクロールを実装する**。現状、溢れたコンテンツは `overflow: hidden` + `text-overflow: ellipsis` で黙って切り捨てられており（silent truncation）、これを根治する。方式はページング（後述）。
2. **入力枠は「追加ボタンを押さなくても最初から並んでいる」常設枠にする**。容量ハードリミットは設けない（スクロールが受け皿になるため）。収まる/収まらないの境界は可視化で伝える。
3. **機能を3層（ファースト/セカンド/その他)に分類し、UI/UX を物理的に切り分ける**。ファースト画面（毎日触る画面）には機能を足さない方針。

## 1. 現状コード地図（2026-07-02 に実コードで確認済み）

### 教員エディタ
| 対象 | パス |
|---|---|
| クラス編集画面（主画面） | `apps/web/app/app/editor/[classId]/page.tsx` |
| WYSIWYG 盤面エディタ | `apps/web/app/app/editor/[classId]/_components/WysiwygBoardEditor.tsx` |
| 予定エディタ（表形式・追加ボタン式） | `apps/web/app/app/editor/[classId]/_components/ScheduleEditor.tsx` |
| 連絡 / 提出物 / 来校者 / 呼び出し | 同 `_components/` の `NoticeEditor.tsx` / `AssignmentEditor.tsx` / `VisitorsEditor.tsx` ほか |
| 時限・特殊スロット定義 | `apps/web/lib/editor/schedule-core.ts`（`SCHEDULE_SLOT_OPTIONS`：1〜12限 + `before_school`/`lunch`/`after_school`/`evening`） |
| エディタ選択（モニタの壁） | `apps/web/app/app/editor/page.tsx` |
| scope（学年・学科共通）編集 | `apps/web/app/app/editor/scope/ScopeEditorView.tsx` ※既存。セカンド層設計時に現状機能を要確認 |
| AI チャット | `apps/web/app/api/editor/assistant/chat/route.ts` ほか（浮遊 FAB。本設計では触らない） |

### サイネージ盤面
| 対象 | パス |
|---|---|
| 盤面レンダラ（純粋関数・実機とプレビューの単一ソース） | `apps/web/app/(signage)/signage/[classToken]/_components/SignageBoardView.tsx` |
| 盤面 CSS（切り捨ての発生源） | 同 `_components/signage.module.css` |
| 縮小プレビュー | 同 `_components/ScaledSignageBoard.tsx` |
| ブロック構成の契約 | `apps/web/lib/signage/pattern-blocks.ts`（schedule/notice/assignment/callout/visitor/presence/train/news/safety_alert/weather/ad） |

### 重要な事実（実装者向け注意）
- `SignageBoardView.tsx:49` の `MIN_ROWS = 5` は**最小行数**（5行に満たない時にプレースホルダで埋める）であって最大行数の enforce ではない。**現状、最大行数はコード上どこにも定義されておらず、CSS のクリップで暗黙に決まっている**。→ 本実装で初めて「容量定数」を明示化する（§3.1）。
- 予定ブロックは「本日＋次の2営業日」の3日列で表示。ページングは**日列ごと**に独立して行う。
- 保存はセクション単位の**置換保存**（`setScheduleAction` 等の Server Action。空配列保存＝全消去）。
- 対象日は `?date=YYYY-MM-DD` クエリで、`key={date}` によるエディタ再マウントで切替。UI 上の日付選択は未実装。
- 編集側に文字数・行数バリデーションは一切ない。

## 2. 全体設計：3層分類と UI の切り分け

| 層 | 置き場所 | 入るもの | 入れないもの |
|---|---|---|---|
| **ファースト**（毎日・開いた瞬間） | 現行のクラス編集画面そのまま | 常設入力枠、スクロール境界線、前日コピーボタン（新規ボタンはこれ1個のみ） | カレンダー、一括操作、テンプレ管理 |
| **セカンド**（週1回・計画） | 新設タブ「カレンダー / 計画」（1クリック奥） | 月間カレンダー、週次ベース時間割、学年・学科共通予定、前週コピー等の一括操作 | 日々の入力フォーム |
| **その他**（アシスト・不可視） | 既存 FAB / フィールド挙動 / 通知 | AI チャット（将来の写真取込もチャット内）、科目サジェスト（入力補完として溶かす）、未入力リマインド（UI 外） | 新規の画面・タブ |

原則: **新機能を追加するときは必ずこの表のどこに入るかを先に決める**。ファースト層への追加は原則禁止（追加したくなったら本設計書を改訂してから）。

## 3. 機能仕様

### F1. 盤面自動ページング（最優先・盤面側で完結）

**方式: ページング（連続マーキーは不採用）**。根拠は盤面設計指針（`盤面設計指針-研究-2026-06-30.md`、app ルート直下）：滞留 5–10 秒・廊下距離からの視認性。連続スクロールは読み取りに不利。

- **容量定数の明示化**: ブロック種別ごとの「スクロールなしで表示できる実効行数」を定数モジュール（例 `apps/web/lib/signage/board-capacity.ts`）に定義する。値は実装時に現行 CSS（フォントサイズ・行高・領域高さ）から導出し、**エディタ側（F2 の境界線）と同じ定数を import する**。二重定義禁止（ドリフト源になる）。パターン（特に pattern3 の拡大タイポ）で値が変わる場合はパターン別に持つ。
- **対象ブロック**: schedule（3日列それぞれ独立）/ notice / assignment / visitor / callout。自動系（news/weather/train/ad 等）は対象外（既存挙動維持）。
- **発動条件**: 実効行数を超えた場合のみ。収まっていれば完全に静止（現状と同じ見え方）。
- **切替仕様**: 実効行数ぶんを 1 ページとし、5–10 秒滞留 → フェードまたは縦スライドで次ページへ循環。ページが複数あるときのみページインジケータ（●○○）を領域隅に小さく表示。滞留秒数は定数化し、初期値は 8 秒を提案（実機で調整）。
- **実装層**: `SignageBoardView` は**純粋関数のまま維持**（hooks を入れない）。ページ index の state 管理はクライアントラッパー側で行い、`SignageBoardView` へは「表示すべきスライス」または「現在ページ」を props で渡す形にする。アニメーションは **transform / opacity のみ**（合成レイヤーで完結させ、layout/paint を発生させない）。低スペック Google TV の WebView で動くことが制約。
- **プレビュー連動**: `ScaledSignageBoard` 経由のエディタプレビューでも同一のページング挙動が動くこと（単一ソースの原則）。教員が「6行目以降がどう映るか」を保存前に確認できるのが F2 境界線とセットの狙い。
- **広告との非干渉**: 広告ブロックの滞留タイマー（MIN_AD_MS 系）とは**独立タイマー**。同期を取らない。
- **受け入れ基準**:
  1. 行数が実効行数以内のとき、描画結果が現行と視覚的に同一（回帰なし）
  2. 超過時、全行がいずれかのページで完全に読める（切り捨てゼロ）
  3. エディタプレビューと実機 `/signage/{classToken}` で同一挙動
  4. 実機（岐南の Google TV）で描画が滑らか（カクつき・メモリ増加なし）
  5. `pattern-blocks.ts` のブロック構成・payload 契約に変更なし

### F2. 常設入力枠（追加ボタン廃止）＋境界線

- **予定（ScheduleEditor）**: 1〜6限の行を最初から表示（現行は空→「追加」ボタン）。教員は空欄を埋めるだけ。7〜12限と特殊スロット（朝・昼・放課後・夜間）は折りたたみセクションで下に常設。既存データに 6 限超・特殊スロットがある日は該当行を自動展開。
  - 行の「削除」は「行クリア」（空欄化）に置き換え。科目が空の行は保存対象外（既存の入力完全性チェック＝`useAutoSaveSection` の流れを流用。置換保存なので「空行を送らない」だけで成立）。
- **連絡・提出物（NoticeEditor / AssignmentEditor）**: 空行を常時 2〜3 行表示。最終空行への入力開始で次の空行を自動追加（現行の「最終行 Tab → 新行」を、入力イベントでも発火するよう拡張）。追加ボタン撤去。
- **来校者・呼び出し**: 同じ常設枠パターンを適用（pattern2/3 のみ表示される既存条件は維持）。
- **スクロール境界線**: F1 の容量定数を import し、実効行数の位置に区切り線＋注記「ここから下はサイネージでスクロール（ページ切替）表示になります」。入力は制限しない。
- **文字数ソフト警告**: 横方向のはみ出し（長い科目名等）はページングでは解決しないため、盤面の列幅から逆算した安全文字数を超えたフィールドに「あと○文字 / はみ出す可能性」の警告表示（ハードリミットにはしない）。安全文字数も容量定数モジュールに同居させる。
- **依存**: F1 の容量定数が先に必要（境界線の位置と文言が F1 で確定するため、実装順は F1 → F2）。
- **受け入れ基準**:
  1. 新規の日を開くと 1〜6 限の枠が並び、追加ボタンなしで入力開始できる
  2. 空行が保存されない（置換保存で余計な空要素が daily_data に入らない）
  3. 既存データ（6限超・特殊スロット・5行超の連絡等）を開いても欠落なく表示・編集できる
  4. AI チャットの下書き反映（`setScheduleAction` 等）と競合しない（AI 経路は無改修で通ること）

### F3. 前日コピー（ファースト層に置く唯一の新規ボタン)

- 対象日が空（または教員が明示操作）のとき、「前日をコピー」1 ボタンで前営業日の schedules/notices/assignments を対象日へ複製（置換保存 API をそのまま利用）。
- 上書き確認: 対象日に既存入力がある場合は確認ダイアログ必須。
- 監査: `created_by`/`updated_by` は操作した教員（ルール1 の監査カラム規律に従う）。
- 「前営業日」の定義は盤面の「次の2営業日」計算と同じロジックを再利用する（独自実装しない）。

### F4. セカンド層タブ＋月間カレンダー

- クラス編集画面にタブ（またはヘッダ切替）「カレンダー / 計画」を新設。
- **月間カレンダー**: `daily_data`（＋class_visitors / student_callouts）に入力がある日へドット表示（月範囲の一括 SELECT）。日付クリック → `?date=` を書き換えてファースト画面へ（既存の `key={date}` 再マウント機構でエディタ本体は無改修）。本日ハイライト・JST 暦日・月送り。
- **前週コピー等の一括操作**もこのタブに置く（ファースト層には置かない）。
- 学年・学科共通予定の UI は既存 `ScopeEditorView.tsx` の現状を確認してから配置を決める（重複実装しない）。

### F5. 週次ベース時間割（本設計書では枠だけ確保・詳細設計は別途）

- 狙い: 基本時間割（月〜金）を 1 回登録 → 各日はそれを初期値に差分編集。教員の日次作業を「確認＋差分修正」に変える本命。
- 設計判断が残る点: テンプレの持ち方（新テーブル vs daily_data 拡張）、反映方式（コピーオンライト推奨＝表示時マージはしない）、学期・時間割変更の切替。**F1〜F4 と同一 PR にしない。着手前に単独で設計スレッドを立てること。**

### 6.5 F5 実装（2026-07-02・ユーザー承認済み・schema=JSONB案／migration=staging まで）
- **保存方式（決定）**: 新テーブル `class_weekly_schedules`（**1 クラス 1 行**・`schedule_by_weekday` JSONB
  `{"1":[ScheduleItem...] … "5":[...]}` 曜日 1=月..5=金・監査カラム+RLS tenant_isolation）。daily_data と同じ JSONB 流儀。
  - Drizzle schema `packages/db/src/schema/class-weekly-schedules.ts`＋drizzle 生成 DDL
    `drizzle/20260702084240_class_weekly_schedules.sql`＋手書き RLS `migrations/0034_class_weekly_schedules_rls.sql`
    （class_visitors/0023・school_calendar/0032 と同パターン）。**本番 migration 適用は人間専任（skill apply-migration）**。
  - RLS テスト `packages/db/__tests__/rls/class-weekly-schedules.test.ts`（tenant 分離・WITH CHECK・deny-by-default）。
- **反映方式（決定）＝コピーオンライト**: 当日の `daily_data.schedules` が**空 かつ 平日**のとき、その曜日の基本
  時間割をエディタの**初期値に seed**する（`page.tsx` の `seededSchedules`）。教員が確認・差分編集して保存すると
  `daily_data` へ materialize。**盤面の表示時マージはしない**（signage/F1〜F4 の表示経路は無改修）。土日・既入力日は seed しない。
- **検証**: 各曜日を日次予定と同じ `validateScheduleItems` で検証（`validateWeeklyTimetable`）。科目のみ登録（場所/対象者は
  日ごと編集）。保存は明示「保存」（計画作業＝週 1 回程度）。監査 created_by/updated_by=操作教員。
- **UI**: `/app/editor/[classId]/timetable`（計画タブから 1 クリック）で月〜金 × 1〜6 限のグリッド編集（`WeeklyTimetableEditor`）。
- **学期・時間割変更**: テンプレは可変 1 本（学期変更は上書き）。コピーオンライトなので materialize 済みの過去日は不変・
  未編集の未来日だけ新テンプレで初期化。effective-dating（複数世代テンプレ）は将来拡張。
- **v1 スコープ外（将来）**: 「基本時間割を今週に一括 materialize」ボタン（週埋め）、7〜12 限・特殊スロットのテンプレ化、
  科目サジェスト連携。
- **既知の制約（v1・#1210 Reviewer M-1）**: テンプレがある平日を**「意図的に空」にはできない**。教員が seed 行を
  全削除して保存すると daily_data に `[]` が materialize されるが、読み取り側は「行なし」と「空配列あり」を区別
  しないため次回表示で**再 seed**される。回避策はテンプレ側から当該曜日を消すこと。将来対応＝「daily_data 行が
  存在して空 = クリア済み」を seed 対象外にする（読み取りの区別が必要・follow-up）。
- **prod デプロイ順序（必須）**: エディタ本体（`/app/editor/[classId]`）も主 tx 内で `class_weekly_schedules` を
  読むため、**migration 0036 未適用の prod へ web を先に出すと日次エディタ全体が 500**（意図的な fail-loud＝
  誤デプロイを隠さない）。prod は **0036 適用（人間・skill apply-migration）→ web デプロイ**の順を厳守。

## 4. 実装順と PR 分割（推奨）

| 順 | 内容 | 独立性 |
|---|---|---|
| PR-1 | F1 容量定数モジュール＋盤面ページング | 盤面側で完結。教員 UI 無変更 |
| PR-2 | F2 常設入力枠＋境界線＋文字数警告 | PR-1 の定数に依存 |
| PR-3 | F3 前日コピー | PR-2 と独立可 |
| PR-4 | F4 セカンド層タブ＋月間カレンダー | PR-1〜3 と独立可 |
| （別設計） | F5 週次ベース時間割 | 設計スレッド → 実装 |

## 5. 制約・地雷（実装スレッドで必ず守る)

- **正本フォルダの HEAD が正**。`main` を前提にしない（着手時に `git status` / `branch --show-current` 確認。ルート CLAUDE.md §1）。
- `SignageBoardView` の**純粋関数性を壊さない**（プレビューと実機の単一ソースが崩れる）。
- `pattern-blocks.ts` の契約・presence 契約は**不変更**（変えると TV ブリッジ端末互換の確認が必要になる。本設計は不要な範囲に収めてある）。
- AI 経路の規律は不変: ルール4（PII マスキング）、ADR-030（PII soft-gate）、ADR-034（来校者・呼び出し・生徒実名は LLM 経路外）。本設計は AI 経路に触らないが、F2 の保存形が AI 下書き反映と同じ Server Action を通ることに注意。
- DB スキーマ変更は F1〜F4 では**不要**（migration なし）。F5 で必要になった場合は migration 規律（本番適用は人間専任・skill apply-migration）に従う。
- デプロイは skill **deploy-v2**（`docs/runbooks/web-deploy.md`）。プレビュー確認だけでなく実機（岐南）での表示確認を PR-1 の受け入れに含める。
- 容量定数・安全文字数の**二重定義禁止**：盤面とエディタは必ず同一モジュールを import。

## 6. 実装時に測定・決定する未確定事項

1. ブロック種別 × パターン別の実効行数の正値（現行 CSS から導出。pattern3 拡大タイポは別値の可能性）
2. ページ滞留秒数の最終値（初期 8 秒、実機で調整）
3. 切替アニメーション（フェード vs 縦スライド）の最終選定（実機の描画性能で判断）
4. 安全文字数（列幅 × フォントから導出、全角基準）
5. `ScopeEditorView.tsx` の既存機能範囲（F4 で重複実装を避けるための事前確認)

### 6.1 PR-1 実装時の決定値（2026-07-02 実装・`apps/web/lib/signage/board-capacity.ts` が正）

- **(1) 実効行数（pattern1）= schedule / notice / assignment いずれも 5 行**。現行 CSS
  （`signage.module.css` の `grid-template-rows: repeat(5, …)` と `:nth-of-type(n + 6){ display:none }`＝
  溢れを黙って切り捨てていた閾値）から導出。pattern3 の既存値（予定 6 コマ / 呼び出し・来校者 3 件＝
  `P3_SCHEDULE_VISIBLE_ROWS` / `P3_PEOPLE_VISIBLE_ROWS`）も同モジュールへ移設し単一ソース化。
- **(2) 滞留秒数 = 8 秒（`SIGNAGE_PAGE_DWELL_MS = 8_000`）**。初期値。実機で調整可能なよう定数化。
- **(3) 切替アニメーション = フェード（opacity のみ）**を採用。合成レイヤーで完結し layout/paint を出さない
  （低スペック Google TV WebView 対策）。縦スライドは実機性能を見て将来再検討可（`.pagerPage` の transition だけ差し替え）。
  `prefers-reduced-motion` ではフェードを止め、ページ切替のみ継続（全行を必ず読める）。
- **(4) 安全文字数（F2・PR-2 で決定）**: `board-capacity.ts` の `SIGNAGE_SAFE_CHARS`（全角基準の初期見積り）に
  同居。予定科目=12 / 連絡=22 / 提出物・科目=8 / 提出物・内容=14。pattern1 盤面の列幅・`clamp()` フォントからの
  初期見積りで、実機（岐南 50 インチ）で実測調整する。**ソフト警告のみ**（超えても保存は通る＝サーバ検証の
  上限 科目32/連絡500/提出物200 とは別物）。常設空行の初期本数 `SIGNAGE_MIN_INPUT_ROWS=2`（末尾は必ず空・
  最終空行入力で自動追加）。

### 6.2 PR-2（F2）実装メモ（2026-07-02）
- **保存セマンティクス**: 常設空行が自動保存をブロックしないよう、**空行を保存ペイロードから除外**する
  （`toScheduleItems`/`toNoticeItems`/`toAssignmentItems` で filter）。置換保存なので「空行を送らない」だけで成立し、
  AI 下書き反映（同じ Server Action）・自動保存・RLS/監査は無改修（受け入れ基準4）。部分入力行（補足だけ / 科目だけ）は
  「未入力」として保存を保留し、黙って捨てない安全弁を入れた。
- **予定**: 1〜6 限を固定行で常設（時限 select 廃止＝行ごと固定）、7〜12 限・特殊は折りたたみ（既存データで自動展開）、
  削除→行クリア。旧 Tab 縦移動（スプレッドシート風・改善4）は固定行モデルで不要になり撤去。
- **連絡・提出物・来校者・呼び出し**: 空行常設＋最終空行入力で自動追加＋追加ボタン撤去。
- 受け入れ基準1（収まる時は現行と視覚同一）は本文の入力欄構造を維持しつつ境界線/警告を**加法的に**足して満たす。

### 6.3 PR-3（F3 前日コピー）実装メモ（2026-07-02）
- 「前営業日」は `lib/signage/rotation.ts` の `previousBusinessDay`（盤面 `signageScheduleDates` の土日スキップ
  ロジックの後ろ向き版・独自実装しない）。`copyPreviousDayAction`（`lib/editor/copy-day-actions.ts`）が自校 RLS tx
  内で前営業日の 3 セクションを読み、対象日へ `upsertDailySectionForTarget` で置換（各エディタ保存と同一コア＝
  検証/監査 created_by=操作教員/RLS 共有・3 セクション同一 tx で部分適用なし）。前営業日が全空なら複製せず
  invalid（対象日を誤って空にしない安全弁）。上書き確認はクライアント（`CopyPreviousDayButton`）。

### 6.4 PR-4（F4 セカンド層タブ + 月間カレンダー）実装メモ（2026-07-02）
- ファースト画面（`/app/editor/[classId]`）に「🗓 カレンダー / 計画 →」導線を足し、セカンド層を**別ルート**
  `/app/editor/[classId]/calendar`（1 クリック奥）に置いた（ファースト層に計画 UI を足さない＝3 層分類）。
- 月間カレンダー（`MonthCalendar`）: `getClassMonthActivity`（月範囲一括 SELECT・daily_data scope=class の非空
  + class_visitors/student_callouts）で**入力がある日**にドット。日付クリックで `?date=` を書き換えてファースト画面へ
  （既存 `key={date}` 再マウントでエディタ本体は無改修）。本日 aria-current・月送り・JST 暦日。暦計算は純関数
  `lib/editor/calendar-core.ts`（単体テスト済）。
- **前週コピー（追加実装・2026-07-02）**: 計画タブに「今週へ前週をコピー」を配置。`copyPreviousWeekAction` が
  **今週（今日を含む週）の月〜金**へ**前週の同じ曜日**の 予定/連絡/提出物 を曜日対応で置換複製する（週は月曜始まり・
  `calendar-core` の週演算）。前週のその曜日が全空の日はスキップ（今週の当該日を空にしない）。5 日を 1 tx で書き
  部分適用なし・監査=操作教員。今週の既存入力を上書きするので**必ず確認**。日割り仕様（this week ← prev week）は
  当面のデフォルト（週選択 UI が要るなら将来拡張）。
- **学年・学科共通予定 UI（追加確認・2026-07-02）**: **既存 `ScopeEditorView.tsx`（`/app/editor/scope/school|department|grade`）で
  実現済**（同じ ScheduleEditor/NoticeEditor/AssignmentEditor を再利用＝F2 常設枠も自動適用）。エディタ一覧
  `/app/editor` の「学校全体/学科にまとめて出す」から到達可。**重複実装せず**、計画タブから scope エディタへの
  **導線（リンク）**だけ足した（学校全体の共通予定 / エディタ一覧の学科別まとめ）。

#### PR-1 の実装スコープ（pattern1 に限定）と理由
- PR-1 は **pattern1（既定・v1 レイアウト）の schedule / notice / assignment** にページングを配線した。
  pattern1 は既定パターンかつ**唯一「純粋な silent truncation（`nth-of-type(n+6)` で黙って切り捨て）+
  溢れ処理なし」**の面＝オーナーが根治対象に挙げた現象そのもの。ルール6（1 PR ≤500 行目安）内に収め動作確認可能にするため。
- **pattern2 / pattern3 / pattern4 のページングは PR-1b で実装済**（2026-07-02・オーナー承認）。pattern3 は現状の
  CSS 連続マーキー（`.p3SchScrollerAuto` / `.p3PersonScrollerAuto` + keyframes）を**削除して BoardPager のページングへ
  置換**（オーナー決定「連続マーキー不採用」に整合）。pattern2（明示 CSS キャップ無し）は**保守的な低め容量**
  （予定5 / 人物3）で切り捨てゼロを優先（実機で上げ調整可）。pattern4 連絡は `.listGroup`（5）を共有。
  pattern3 の可視コマ定数は `board-capacity` を単一ソースに移設（`P3_SCHEDULE_VISIBLE_ROWS` 等は import 値）。
  pattern3 のページャ・ビューポートは cqh の size container を絶対フィルする専用クラス `.p3PagerViewport`。
- 実装: 容量定数 `lib/signage/board-capacity.ts` ＋ client island `BoardPager.tsx`（`SignageBoardView` の純粋関数性は
  不変＝タイマー/ページ index は island に閉じ込め、盤面は確定済みページ markup を props で受ける）＋ CSS `.pager*`。
  受け入れ基準1（収まる時は現行と視覚同一）は**非ページング経路を現行 markup のまま維持**して満たす（発動＝溢れた時のみ）。

## 7. main への移植記録（2026-07-02 以降・こちらが正）

旧ブランチは基底が origin/main から 103 コミット遅れており、main には別レーンの並行実装
（F2 相当 #1166/#1170・連続スクロール #1179・カレンダー #1189）が先に本番稼働していたため、
**旧ブランチはデプロイ禁止**とし、main に無い価値だけを origin/main 起点の新ブランチで移植する
（オーナー決定 2026-07-02: ①F3 前日/前週コピーと F5 を移植 ②溢れ表示は連続スクロールをやめ**ページングへ置換**）。

### 7.1 PR 分割（移植版）
| PR | 内容 | レーン |
|---|---|---|
| A1 | ページング基盤 + pattern1（予定/連絡/**提出物**）を BoardPager 化 | lane:signage |
| A2 | pattern2/3 の editable ブロックも BoardPager 化（p3 マーキー撤去） | lane:signage（A1 merge 後） |
| C1 | F3 前日コピー | lane:editor |
| C2 | F3 前週コピー＋計画導線 | lane:editor |
| B | F5 DB スライス（schema + RLS migration **0036**＝main の 0034/0035 使用済のため振り直し） | lane:db |
| D | F5 web スライス（/timetable UI + コピーオンライト seed） | lane:editor（B merge 後） |

### 7.2 A1 実装記録（旧 §6.1 との差分）
- **容量の単一ソースは main 既存の `blockRowCapacity`（`lib/signage/pattern-blocks.ts`・全編集ブロック 5）**。
  旧ブランチの `board-capacity.ts` は移植しない（値の二重定義を作らない）。新設 `lib/signage/board-paging.ts` が
  持つのは滞留 `SIGNAGE_PAGE_DWELL_MS=8000`・`chunkIntoPages`・**1 ページ件数の例外上書き**（pattern2 の
  呼び出し/来校者=3・自然高さ 2 行アイテム対策）だけ。
- pattern1 では #1179 の CSS 連続スクロール（`.autoScrollActive` + keyframes）を**撤去**し、`.autoScroll` は
  「size container + 固定行高の基準」（`FixedRowsViewport`）に役割を縮小。超過時のみ `BoardPager`（フェード・
  ページドット・reduced-motion 対応・全ページ DOM 保持=切り捨てゼロ）。未超過は現行と視覚同一の静的描画。
- **提出物もページング対象に追加**（旧 §6 では sticky thead を理由に対象外→`nth-of-type(n+6)` の silent
  truncation が残っていた。ページングは各ページが thead 込みの完全なテーブルになるため相性問題が無い＝撤去）。
- pattern4 連絡（`.noticeFlow` + JS `AutoScroll`）と自動ブロック（news 等）は**据え置き**（長文の自然高さ
  フローは件数ベースのページングだと 1 ページ内で再クリップしうる。設計原則「切り捨てゼロ」優先の判断）。
- モバイル（縦積み）はページングを解除して全ページを静的展開（従来の「固定枠解除・全件流す」と一貫）。