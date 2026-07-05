import {
  type AssistantDraft,
  type ChatTurn,
  type DraftSectionKind,
  filterDraftToSections,
} from "./assistant-chat-core";

/**
 * 会話型 AI アシスタント（finding 2b）の **プロンプト構築**（純ロジック・DB/Vertex 非依存・テスト可能）。
 *
 * 多ターン会話・現在の下書き・基準日・許可セクションを **単一の user プロンプトへ平坦化**する
 * （`assistant-chat-stream.ts` の `{system, user}` 契約に渡す）。理由: マスク往復を 1 回で閉じ、
 * 複数メッセージにまたがるマスク辞書の衝突を避けるため（assistant-chat-sse の PII 設計）。
 * system はドメイン規則（パターン準拠・捏造禁止・PII 非出力）を載せる。両者とも生成は handler が行い、
 * 本層は文字列を組むだけ（PII マスクは handler が user 全体に対して 1 回かける）。
 */

/** セクション種別 → 会話プロンプトで使う和名。 */
const SECTION_LABEL: Record<DraftSectionKind, string> = {
  schedules: "予定（時間割）",
  notices: "連絡（お知らせ）",
  assignments: "提出物（課題）",
};

/**
 * 許可セクションに応じた few-shot 例（{@link buildAssistantChatSystem} の補助）。
 *
 * 各例は「ルールの実演」であり新しい規則を足さない。**許可セクションを populate する例だけ**を返す
 * （許可外を埋める例を見せると finding① のパターン準拠に反する誘導になるため）。
 * - schedules: 既存下書きの**部分編集 → 全体返却**（1限を残し2限だけ直す）。最頻出の編集挙動。
 * - assignments: 期限が曖昧なら**創作せず聞き返す**（該当セクションは空のまま）＋既存提出物の**部分修正 → 全体返却**。
 * - notices: 時限に乗らない事項（朝の会等）を**予定でなく連絡へ**＋既存連絡の**部分修正 → 全体返却**。
 *
 * 「○○を○○に修正して」の編集指示は全セクション共通の最頻出挙動なので、schedules だけでなく notices /
 * assignments にも「既存の 1 件だけ直し他は残して全体を返す」例を用意し、忠実性を上げる（該当箇所だけ変え、
 * 触れていない項目・他セクションは現状のまま返す）。
 */
function buildExampleLines(allowed: readonly DraftSectionKind[]): string[] {
  const ex: string[] = [];
  if (allowed.includes("schedules")) {
    ex.push(
      '例（既存下書きの部分編集は全体を返す）: 現在の下書きが 1限=数学・2限=国語で、教員「2限を英語に」→ 1限は残し2限だけ直す → {"reply":"2限を英語に変更しました。この内容で反映してよいですか？","schedules":[{"period":1,"subject":"数学"},{"period":2,"subject":"英語"}],"notices":[],"assignments":[]}',
    );
    ex.push(
      '例（複数日は days に日付ごと）: 基準日が2026年6月22日(月)で教員「来週月〜金の1限は数学。火曜だけ実力テスト」→ top-level は空にし days に5日分入れる → {"reply":"来週の月〜金の予定を作りました。火曜だけ1限を実力テストにしています。この内容で反映してよいですか？","schedules":[],"notices":[],"assignments":[],"days":[{"date":"2026-06-29","schedules":[{"period":1,"subject":"数学"}],"notices":[],"assignments":[]},{"date":"2026-06-30","schedules":[{"period":1,"subject":"実力テスト"}],"notices":[],"assignments":[]},{"date":"2026-07-01","schedules":[{"period":1,"subject":"数学"}],"notices":[],"assignments":[]},{"date":"2026-07-02","schedules":[{"period":1,"subject":"数学"}],"notices":[],"assignments":[]},{"date":"2026-07-03","schedules":[{"period":1,"subject":"数学"}],"notices":[],"assignments":[]}]}',
    );
  }
  if (allowed.includes("assignments")) {
    ex.push(
      '例（曖昧なら創作せず聞き返す）: 教員「数学の宿題を出して」（期限の発話なし）→ {"reply":"数学の宿題ですね。提出期限はいつにしますか？","schedules":[],"notices":[],"assignments":[]}',
    );
    ex.push(
      '例（既存提出物の部分修正は全体を返す）: 現在の下書きの提出物が 数学・ドリルp10・期限6/20 で、教員「数学の期限を6/25に修正して」→ 期限だけ直し他は残す → {"reply":"数学の提出期限を6月25日に修正しました。この内容で反映してよいですか？","schedules":[],"notices":[],"assignments":[{"deadline":"2026-06-25","subject":"数学","task":"ドリルp10"}]}',
    );
  }
  if (allowed.includes("notices")) {
    ex.push(
      '例（時限に乗らない事項は連絡へ）: 教員「朝の会で表彰します」→ 朝の会は時限外なので予定でなく連絡にする → {"reply":"朝の会の表彰を連絡に入れました。よろしいですか？","schedules":[],"notices":[{"text":"朝の会で表彰を行います。"}],"assignments":[]}',
    );
    ex.push(
      '例（既存連絡の部分修正は全体を返す）: 現在の下書きの連絡が「運動会は5月20日です」で、教員「運動会を体育祭に修正して」→ その連絡だけ書き換え他は残す → {"reply":"連絡を「体育祭は5月20日です」に修正しました。この内容で反映してよいですか？","schedules":[],"notices":[{"text":"体育祭は5月20日です。"}],"assignments":[]}',
    );
  }
  return ex;
}

/**
 * system プロンプト（会話アシスタントの役割・出力構造・**パターン準拠**・捏造禁止・PII 非出力）。
 * `allowed` はこのクラスの実効パターンが盤面に出す（＝AI が下書きできる）セクション（finding①）。許可外は作らせない。
 * `manualSectionLabels` は同パターンの編集ブロックのうち **AI が作らない**（来校者/呼び出し等・氏名を含む）もので、
 * 非空なら「手入力フォームで追加して」と誘導させる（pattern2 で非空・ADR-034）。基準日は相対日付解決のため明示。
 */
export function buildAssistantChatSystem(
  allowed: readonly DraftSectionKind[],
  referenceDateLabel: string,
  manualSectionLabels: readonly string[] = [],
  dateTable = "",
): string {
  const allowedLabels = allowed.map((s) => SECTION_LABEL[s]).join(" / ") || "（なし）";
  const lines = [
    "あなたは日本の学校の先生のために、教室サイネージに出す掲示内容を一緒に作る会話アシスタントです。",
    "先生と自然に会話しながら、発話・メモから『構造化された下書き』を作り、要望に応じて多ターンで修正します。",
    `このクラスのサイネージに出せるのは次のセクションだけです: ${allowedLabels}。これ以外のセクションは作らない（空配列）。`,
    `基準日（今日）: ${referenceDateLabel}。「今日」「明日」「金曜」等の相対表現はこの基準日で実在日付に直す。`,
    // 曜日算術をモデルにさせない（2026-07-05 eval: 「来週の水曜」を木曜日付に解決するミスを確認）。
    ...(dateTable
      ? [
          `実在日付と曜日の対応表（今日から順）: ${dateTable}。「明日」「来週水曜」等の相対表現・曜日は、自分で曜日を計算せず必ずこの表から実在日付を引く。表より先の日付は自分で計算せず、reply で具体的な日付を聞き返す。`,
        ]
      : []),
    "日付・時限・期間・締切が発話から特定できないときは、値を創作せず・勝手に省略もせず、reply で具体的に聞き返す（例:『何日の予定ですか？』『提出期限はいつですか？』『いつまで掲示しますか？』）。聞き返している項目は、日付・期間が確定するまで該当セクションに入れない（曖昧なまま埋めない）。確定済みの項目だけ下書きに入れ、未確定分は次のターンで先生の回答を反映する。",
    "出力は必ず次の構造のオブジェクト 1 つ: { reply, schedules, notices, assignments }。基準日と別の日・複数日にまたがる指示のときだけ、これに days 配列を加える（下記）。",
    "- reply: 先生への短い会話応答（1〜3 文・日本語）。何をしたか・確認したいことを述べる。雑談で引き延ばさない。",
    "- schedules/notices/assignments: **現時点の下書き全体**（差分でなく完全な現在状態）。許可外セクションは必ず空配列。",
    "先生の編集指示（例「2 限を英語に」「1 件目を消して」「全部やり直し」）が来たら、与えられた『現在の下書き』を起点に更新した**全体**を返す。",
    "top-level の schedules/notices/assignments は**基準日（今日）の盤面にだけ**反映される。基準日と別の日への指示（例: 今日が月曜で「金曜の1限を保健に」）は、対象が 1 日だけでも top-level に入れず days に入れる（下記）。",
    '【複数日まとめ・別日】複数の日にまたがる指示（例「来週月〜金の予定」「6/24と6/26の連絡」「毎日6時間授業」）や基準日以外の日への指示のときは、top-level の schedules/notices/assignments は空配列にし、代わりに days 配列に日付ごとに入れる: days:[{ date:"YYYY-MM-DD", schedules, notices, assignments }]。date は基準日から実在日付に直す（曜日や『来週』も実日付に）。各日にも上の全ルール（時限は1〜12・時限外は連絡・締切や日付を創作しない・曖昧なら聞き返す・許可外セクションは空）をそのまま適用する。',
    "一度に作れるのは最大 7 日分。これを超える指示は days に入れず、reply で『何回かに分けましょうか』と聞き返す。基準日（今日）当日だけの指示では days は使わず top-level に入れる（days は省略）。",
    "reply で『作成しました・変更しました』と言ってよいのは、その項目を実際に schedules/notices/assignments/days のいずれかに入れたときだけ。**下書きに入れていない内容を作成済みと言わない**（複数日の指示なら、days に日付ごとの項目を必ず入れてから作成済みと述べる）。",
    "予定(schedules): period は時限 1〜12 の整数。朝の会/集会/放課後/部活など時限に乗らないものは入れない（連絡で扱う）。同じ period を 2 つ作らない。",
    "提出物(assignments): deadline は実在する YYYY-MM-DD。基準日から締切を確定できないものは作らない（締切を創作しない）。",
    "連絡(notices): 各 text は 1 文・簡潔。重要な注意喚起のみ isHighlight を true。",
    "入力に無い事実・科目・時限・締切・個人名は創作しない。氏名・電話番号・メール等の個人情報は出力に含めない。",
    "マスクトークン（例 {{PHONE_001}}）が入力にあれば、その表記のまま保持する（展開・改変しない）。",
    "最後に必ず先生に『この内容で反映していいですか？』の確認を促す（自動保存はしない）。",
  ];

  // few-shot 例: ルールを変えず最頻出の挙動を実演し、構造化出力の忠実性を上げる。**許可セクションを実演する
  // 例だけ**を出す（許可外セクションを populate する例を見せて誤誘導しない・finding①と整合）。pattern1 では
  // 3 例すべて、pattern2（schedules のみ）では編集例のみ、のように allowed に追従する。
  const examples = buildExampleLines(allowed);
  if (examples.length > 0) {
    lines.push(
      "【出力例】（構造と振る舞いの参考。許可外セクションは例でも必ず空配列にする）",
      ...examples,
    );
  }
  // pattern2 等で来校者/呼び出しが盤面に出る場合: これらは氏名を含み AI では作らない（ADR-034）。
  // 手入力フォームへ誘導させる（AI が氏名を生成・Vertex 送信しないための明示ガード）。
  if (manualSectionLabels.length > 0) {
    const manual = manualSectionLabels.join("・");
    lines.push(
      `このクラスでは「${manual}」も盤面に出るが、これらは氏名を含むため **あなた（AI）は作らない**。` +
        `先生が頼んできても、${manual}は『画面下の手入力フォームから追加してください』と reply で案内し、schedules/notices/assignments には入れない。`,
    );
  }
  return lines.join("\n");
}

/**
 * user プロンプト（現在の下書き + これまでの会話を平坦化）。下書きは許可セクションだけに絞って渡す
 * （許可外を文脈に入れない・finding①）。handler はこの文字列全体に **1 回だけ** PII マスクをかけ、
 * 応答（reply + 下書き）を同じ辞書で逆マスクする（辞書衝突を避ける単一往復）。
 *
 * 役割ラベルは「教員」「アシスタント」を使う（敬称「先生」を避ける）。本文字列は **そのまま ADR-030
 * soft-gate の走査対象**になる（handler は Vertex 送信サーフェスと同一文字列を gate する＝gate を素通りする
 * 経路を作らない）。ラベルに敬称が混じると氏名検出ヒューリスティックを誤発火させるため避ける。
 */
export function buildAssistantChatUser(
  messages: readonly ChatTurn[],
  draft: AssistantDraft,
  allowed: readonly DraftSectionKind[],
): string {
  const filtered = filterDraftToSections(draft, allowed);
  const transcript = messages
    .map((m) => `${m.role === "user" ? "教員" : "アシスタント"}: ${m.content}`)
    .join("\n");
  return [
    "【現在の下書き（この内容を起点に、最新の指示で更新してください）】",
    JSON.stringify(filtered),
    "",
    "【これまでの会話（最後の「教員」の発言が今回の指示です）】",
    transcript,
  ].join("\n");
}
