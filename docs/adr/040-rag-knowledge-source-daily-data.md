# ADR-040: 生徒/保護者向け Q&A の知識源を編集(daily_data)に再ソース化（直接注入・ADR-038 D1 を supersede）

- 状態: Accepted（2026-06-14、ユーザー判断「編集(daily_data)を知識源に再ソース化」/ 学校体験リニューアル item4 後続）
- 日付: 2026-06-14
- 関連: [ADR-028 (F06 回答ポリシー)](028-f06-chatbot-answer-policy.md), [ADR-030 (authoring 時 PII ガード)](030-authoring-time-pii-gate.md), [ADR-038 (旧・知識源=published contents)](038-student-qa-rag-knowledge-source.md)（**本 ADR が D1/D2 を supersede**）, [ADR-007 (pgvector)](007-pgvector.md), [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [F06 生徒対話](../requirements/functional/F06-student-qa.md), [CLAUDE.md ルール2/4/8](../../CLAUDE.md), #42

## 文脈

[ADR-038](038-student-qa-rag-knowledge-source.md) は生徒/保護者 Q&A の知識源を「**school_admin が公開した `contents`/`content_versions`**」に固定し（D1）、embedding バッチ Job を本番有効化した（D2、#864 merged）。しかし運用実態の確認で次が判明した:

- **`contents` テーブルは空**（seed/fixture なし）。教員は学校体験リニューアルで「エディタ1枚」に集約され（[[project_teacher_ui_editor_only]]）、`/app/contents`・`/app/teacher-input` の nav は撤去済み。供給主体は school_admin のみ（nav は残存）だが、**Q&A 知識ベースを別途手動でキュレーションする担い手が実質いない**。
- 結果、embedding Job を点灯しても grounded 0 件で `general_supplement` フォールバックのままになる。`lib/nav.ts` 自身が「コンテンツ投入を今後誰が担うかは別途設計」と TODO 化していた。

一方、**教員が日々作っている実コンテンツは編集（`daily_data` の連絡 `notices` / 提出物 `assignments`）にある**。これはサイネージ表示用の別系統（[[ref_v2_two_content_systems]]、ADR-038 が「盤面再利用」として一旦不採用にした候補 B）。ユーザー判断で、**この編集コンテンツを生徒/保護者 Q&A の知識源に再ソース化する**ことを決定した。

## 決定

### D1. 知識源 = 生徒のクラスの実効 daily_data（notices + assignments）。ADR-038 D1 を supersede

生徒/保護者 Q&A(F06) の知識源を、**当該生徒のクラスの「今日表示中」の `daily_data.notices`（連絡）/ `assignments`（提出物）**に変更する。ADR-038 D1（知識源=published contents）と候補 A の採用を **supersede**。`schedules`/`quietHours` は構造化データで Q&A 自然文知識に不適のため対象外。

### D2. 実装方式 = 直接注入（埋め込み非経由）。ADR-038 D2 を supersede

daily_data を埋め込み化せず、**Q&A コンテキストに直接注入**する（方式 M3）。

- 新 provider `createDailyDataContentProvider`（`apps/web/lib/student-qa/`）が、`getEffectiveDailyData(tx, classId, date)`（`lib/signage/effective-daily-data.ts`）を再利用して当該クラスの実効 notices/assignments を取得し、各項目を `ChatContext`（`{ id, title, body }`）に整形して返す。
- 既存 `createRagContentProvider`（curated contents 用）と **合成**: daily_data に grounded 文脈があればそれを採用（`mode="grounded"`）、無ければ既存 RAG/直接取得（→ 0 件なら `general_supplement`）にフォールバック。配線は `sse-handler.ts` の provider 生成 1 箇所のみ変更。
- **採用理由**: daily_data は日付限定・小規模・高頻度更新・鮮度命のデータで、ベクトル RAG（大量・恒久知識向け）と性質が合わない。直接注入は ①常に最新（バッチ遅延なし）②`getEffectiveDailyData` の日付窓（`isNoticeActive`=displayDays / `isAssignmentActive`=期限+猶予）とクラス階層マージ（class>grade>department>school）・RLS をそのまま再利用 ③スキーマ変更ゼロ・新ジョブ不要、で最小・最小リスク。
- **不採用**: M1（daily_data→派生 contents で embedding 再利用）は `contents` console 汚染・version churn・失効ライフサイクルが重い。M2（daily_data 専用 embedding + RAG union）は読取経路変更で prod 生徒Q&A correctness リスク最大。いずれも直接注入の利点（鮮度・最小実装）に劣る。

### D3. embedding バッチ Job（#864）の扱い = コード上 enabled のまま**未 apply（ゲート据置）**

ADR-038 D2 で `enabled=true` 化した embedding Job（#864 merged）は、**本 ADR の直接注入では不要**。`terraform apply`（本番点灯）は**実行しない**（ユーザーゲート据置）。pgvector RAG パイプライン（`content_versions.embedding` / `getRelevantPublishedContent` / `createRagContentProvider`）は将来 curated contents を運用したくなった場合のために**温存**する（合成 provider のフォールバック段に残る）。curated contents の担い手が確定したら、その時に Job を apply する。ADR-038 D5（空知識時の `general_supplement` フォールバック）は最終フォールバックとして維持。

### D4. PII マスキング（ルール4）= 既存経路を踏襲。ただし PII 露出面は増える（残存リスク明記）

daily_data も Q&A の他文脈と同じく **chat-service の step6 で `maskPII`（電話/メール正規表現）+ `redactSuspectedNames`（氏名ヒューリスティック）+ `findUnmaskedPii` fail-closed** を通す（provider は生テキストを返し、マスクは chat-service が単一ソースで担う既存契約を不変で踏襲。マスク漏れ検出時は文脈を LLM へ送らず 500 で fail-closed）。

- ⚠️ **残存リスク（重要）**: daily_data の連絡/提出物は教員が自由記述で書くため、curated contents より**生徒氏名を含みやすい**（例「田中さん 提出物未提出」）。生徒/保護者は匿名設計で roster を持たない（ADR-003/030、`piiEntries` 空）ため、漢字敬称/ひらがな名は確定マスクできず `redactSuspectedNames` の best-effort + fail-closed が最終防御になる。これは ADR-030 が受容した残存リスクの**面拡大**であり、本 ADR で新たに緩めるものではない。
- **緩和 follow-up**: ①[ADR-030](030-authoring-time-pii-gate.md) の authoring 時 soft-gate（連絡/提出物入力時に氏名を warn）を Q&A 知識化の前段防御として重視 ②本経路向けに氏名 redaction を強化する余地（別 PR で計測後）。

### D5. スコープ/鮮度窓・テナント分離 = 既存 `getEffectiveDailyData` を不変で再利用

- 鮮度窓: `isNoticeActive`（入力日から displayDays 日間）/ `isAssignmentActive`（期限 + 猶予日）で「今日表示中」だけを採用（サイネージ表示と同一規約 = 生徒が今見ているサイネージと Q&A の知識が一致）。`date` は JST 今日（`parseSignageDate(undefined)` と同じ既定）。
- クラス境界: `getEffectiveDailyData` がクラス階層（class>grade>department>school）で自クラス可視分のみマージ。生徒の `classId` は `RagAudience`（magic_link セッション由来）から取得。`classId` が無い/staff（教員）は daily_data 注入対象外（教員 Q&A は別途撤去中 #867）。
- テナント分離（ルール2）: `getEffectiveDailyData` は RLS コンテキスト tx 内で自校スコープを DB レベル強制（手書き `school_id` 非依存）。本 ADR で RLS 境界は不変。

## 影響

- 生徒/保護者は **教員が日々作る編集コンテンツ（今日の連絡・提出物）に grounded した Q&A 回答**を、手動キュレーション無しで得られる。Q&A の知識とサイネージ表示が同一ソース（鮮度一致）。
- スキーマ変更・新規 migration・新 Cloud Run Job いずれも無し。embedding Job の本番 apply は不要（コスト発生せず）。
- サイネージ表示・編集の書き込み経路は不変。生徒 Q&A の SSE/route も provider 合成 1 箇所のみ変更。
- 教員 Q&A 経路（撤去中、#867）には daily_data 注入を行わない（class 非バインド）。

## 残存リスク / follow-up

- ① **PII 氏名露出面の拡大**（D4）。fail-closed + ADR-030 authoring gate に依存。氏名 redaction 強化は計測後の別 PR。
- ② **curated contents 経路は休眠**。embedding Job 未 apply。将来 school_admin が Q&A 専用ナレッジを運用するなら ADR-038 の経路を再活性（apply）する。
- ③ **保護者**は生徒と同じ magic_link/クラス経路を辿る前提（class スコープ）。別導線が要るなら別途。
