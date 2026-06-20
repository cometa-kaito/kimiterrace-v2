# ADR-048: サイネージ パターン4（教員入力最小・天気/ニュース主役・連絡のみ編集）

- 状態: Accepted（2026-06-20、Desktop 判断。ユーザーがデザインプレビュー（ウィジェット2枚）を確認のうえ「実装に進む」「防災帯は含める（条件付き）」を明示）
- 日付: 2026-06-20
- 関連: [ADR-043 工学ニュース外部取得]、[ADR-044 keyless 外部データ relay（防災・安全）]、[CLAUDE.md ルール6（小さい PR）/ ルール7（テスト緑）]、`apps/web/lib/signage/pattern-blocks.ts`（単一ソース `PATTERN_BLOCKS`）、`apps/web/lib/signage/design-pattern.ts`
- 由来: ユーザー要望「pattern3 から派生して pattern4 を作る。pattern4 は教員入力をできるだけ無くす（連絡フリーワードのみ）。天気とニュースを基本の重要情報に」。同時に pattern3 から工学ニュースを撤去（[PR #1080](https://github.com/cometa-kaito/kimiterrace-v2/pull/1080)）。

## 文脈

サイネージ盤面はデザインパターン（`SIGNAGE_DESIGN_PATTERNS`）で切り替わり、**どのパターンがどの表示ブロックを出すか**は単一ソース `PATTERN_BLOCKS`（`pattern-blocks.ts`）が宣言的に持つ。盤面 dispatch・データ取得ゲート（`signage-display.ts` の `patternIncludesBlock`）・エディタ/AI の編集セクション出し分け・盤面 region ドリフトガード（`SignageClient.test`）はすべてこの単一ソースから**自動駆動**する（finding①）。

既存パターンはいずれも **教員の日次入力（予定・連絡・提出物・呼び出し・来校者）を前提**にしている:

- pattern1（標準）: 予定 / 連絡 / 提出物 + 天気 / 広告 + 防災・安全（条件付き）
- pattern2（掲示）: 予定 / 呼び出し / 来校者 / 鉄道 / 人感センサ / 工学ニュース + 天気 / 広告
- pattern3（廊下）: pattern2 と同内容を遠目最適化（後に工学ニュースを撤去 = [#1080](https://github.com/cometa-kaito/kimiterrace-v2/pull/1080)）

しかし運用上、**教員が日々入力する工数を割けない設置面**（共用部・職員不在のモニタ等）がある。そこに「予定が空のまま」の盤面を出すと体裁が悪い。**教員入力をほぼ要さず、API/自動コンテンツで成立する盤面**が欲しい。

## 決定

**pattern4** を新設する。設計思想は **pattern3 の対**:

- **pattern3** = 教員入力を前提とした運用（予定・呼び出し・来校者を教員が日々入力）。
- **pattern4** = 教員入力をできるだけ無くした運用。**教員が入力するのは「連絡」（フリーワード）のみ**。それ以外は全自動 / API で教員入力ゼロ。

### pattern4 の表示ブロック（`PATTERN_BLOCKS.pattern4`）

順序付き（盤面の読み順）:

```
["safety_alert", "weather", "news", "notice", "train", "presence", "ad"]
```

| ブロック | 役割 | 供給 |
|---|---|---|
| safety_alert（防災・安全） | 条件付き帯（最上部・アクティブ時のみ） | API 自動（ADR-044） |
| **weather（天気）** | **主役①**: 今日を大きく + 週間 6 日 | API 自動 |
| **news（工学ニュース）** | **主役②**: 見出し + 出典（本文非転載） | API 自動（ADR-043） |
| notice（連絡） | **唯一の教員入力**（フリーワード） | 教員 |
| train（鉄道） | 運行情報 | API 自動（ADR-035） |
| presence（人感センサ） | 本日の検知回数 | センサ自動 |
| ad（広告） | 9:16 広告 | 配信 |

→ `editableBlocksForPattern("pattern4")` は **`["notice"]` のみ**。

## 論点と候補

### (1) 教員入力ブロックの扱い（予定・呼び出し・来校者）

| 候補 | 評価 |
|---|---|
| A. 残して空表示 | 「予定が常に空」は体裁が悪く、pattern4 の趣旨（教員工数ゼロ）に反する |
| **B. 載せない（採用）** | 教員入力を要するブロックは連絡を除き **`PATTERN_BLOCKS.pattern4` に含めない**。editableBlocksForPattern が `[notice]` のみになり、エディタ（`WysiwygBoardEditor`）・AI（`assistant-sections`）・データ取得ゲートが自動追従して死セクションを作らない |
| C. 予定を API（時間割連携）で自動供給 | 時間割 API は未整備。別 feature（スコープ過大）。本 ADR では非採用 |

### (2) 「全パターン共通の主役 = schedule」不変条件の緩和

これまで「どのパターンも予定（schedule）を含む」を不変条件にしていた（テストで固定）。pattern4 は予定を持たないため、これを **「pattern1/2/3 は schedule を含む、pattern4 は持たない例外」** に緩める（`pattern-blocks.test.ts`）。安易な「全パターン schedule 前提」のコードを増やさないための明示的な記録。

### (3) 天気・ニュースの主役化（限られた画面に最大限の情報）

ユーザー指示「天気とニュースを基本の重要情報に」「画面領域は限られるのでシンプルに最大限の情報量」に従い、**天気を専用ヒーロー**（今日を暗色タイルで大きく + 週間 6 日ストリップ）、**ニュースを拡大見出しの主役カード**に据える（`Pattern4Board` / `Pattern4WeatherHero`）。盤面は縦積み（`.p4Grid`）で flex 比を news 1.8 / notice 1 に配分。

### (4) 防災・安全帯を含めるか

ユーザー確認の結果 **含める（条件付き）**。pattern1 と同じく `safety_alert`（気象警報/熱中症・ADR-044）を `PATTERN_BLOCKS.pattern4` に含め、アクティブ時のみ最上部に帯を出す（無アラート時は帯ごと出さない・fail-soft）。天気が主役の方針と整合し、教員入力ゼロのまま安全情報も自動で出る。`safety_alert` は `pattern1 / pattern4` のみが取得・描画。

### (5) 保持方式（スキーマ非変更）

既存と同じく `tv_devices.signage_url` の `?design=pattern4` クエリで端末別に保持（専用列を足さない）。`SIGNAGE_DESIGN_PATTERNS` union と `SIGNAGE_DESIGN_PATTERN_LABELS` に 1 語追加するだけで、TV 設定編集ドロップダウン・解決ロジック・fail-soft が自動追従。

## 結果 / 影響

- **新規**: `Pattern4Board` + `Pattern4WeatherHero`（`SignageBoardView.tsx`）、`.p4*` CSS（`signage.module.css`）、`PATTERN_BLOCKS.pattern4`、union/label に pattern4。
- **自動追従（無改修）**: データ取得ゲート（`signage-display.ts`）・region ドリフトガード（`SignageClient.test`）・AI 許可セクション（`assistant-sections`）・TV 設定ドロップダウン。
- **小改修**: `WysiwygBoardEditor` に `showSchedule` ゲート追加（pattern4 は予定の編集欄も出さない）。pattern4 で news / safety_alert を取得するよう `signage-display.ts` の JSDoc/コメントを pattern2/4・pattern1/4 へ更新（挙動は patternIncludesBlock 駆動で自動）。
- **pattern1/2/3 は無改修**（pattern3 の news 撤去は先行 #1080）。スキーマ変更・migration なし。工学ニュース取得 Job（ADR-043）・防災データ relay（ADR-044）は既存のまま流用（pattern4 が読むだけ）。
- **NFR05（色非依存）**: 気温は数値併記、天気グリフは `aria-label`、防災帯は段階ラベル併記。region landmark は単一ソースの hasRegion と一致（天気ヒーロー・防災帯は `role="group"`）。

## 却下案

- 予定を API 自動供給（時間割連携）: 未整備で別 feature。pattern4 は連絡のみ教員入力で割り切る。
- pattern3 を改造して pattern4 化: pattern3（教員入力前提・廊下）は別運用として残す必要があり、別パターンとして新設するのが正。
