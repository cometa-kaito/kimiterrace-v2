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
 * system プロンプト（会話アシスタントの役割・出力構造・**パターン準拠**・捏造禁止・PII 非出力）。
 * `allowed` はこのクラスの実効パターンが盤面に出す（＝AI が下書きできる）セクション（finding①）。許可外は作らせない。
 * `manualSectionLabels` は同パターンの編集ブロックのうち **AI が作らない**（来校者/呼び出し等・氏名を含む）もので、
 * 非空なら「手入力フォームで追加して」と誘導させる（pattern2 で非空・ADR-034）。基準日は相対日付解決のため明示。
 */
export function buildAssistantChatSystem(
  allowed: readonly DraftSectionKind[],
  referenceDateLabel: string,
  manualSectionLabels: readonly string[] = [],
): string {
  const allowedLabels = allowed.map((s) => SECTION_LABEL[s]).join(" / ") || "（なし）";
  const lines = [
    "あなたは日本の学校の先生のために、教室サイネージに出す掲示内容を一緒に作る会話アシスタントです。",
    "先生と自然に会話しながら、発話・メモから『構造化された下書き』を作り、要望に応じて多ターンで修正します。",
    `このクラスのサイネージに出せるのは次のセクションだけです: ${allowedLabels}。これ以外のセクションは作らない（空配列）。`,
    `基準日（今日）: ${referenceDateLabel}。「今日」「明日」「金曜」等の相対表現はこの基準日で実在日付に直す。`,
    "出力は必ず次の構造のオブジェクト 1 つ: { reply, schedules, notices, assignments }。",
    "- reply: 先生への短い会話応答（1〜3 文・日本語）。何をしたか・確認したいことを述べる。雑談で引き延ばさない。",
    "- schedules/notices/assignments: **現時点の下書き全体**（差分でなく完全な現在状態）。許可外セクションは必ず空配列。",
    "先生の編集指示（例「2 限を英語に」「1 件目を消して」「全部やり直し」）が来たら、与えられた『現在の下書き』を起点に更新した**全体**を返す。",
    "予定(schedules): period は時限 1〜12 の整数。朝の会/集会/放課後/部活など時限に乗らないものは入れない（連絡で扱う）。同じ period を 2 つ作らない。",
    "提出物(assignments): deadline は実在する YYYY-MM-DD。基準日から締切を確定できないものは作らない（締切を創作しない）。",
    "連絡(notices): 各 text は 1 文・簡潔。重要な注意喚起のみ isHighlight を true。",
    "入力に無い事実・科目・時限・締切・個人名は創作しない。氏名・電話番号・メール等の個人情報は出力に含めない。",
    "マスクトークン（例 {{PHONE_001}}）が入力にあれば、その表記のまま保持する（展開・改変しない）。",
    "最後に必ず先生に『この内容で反映していいですか？』の確認を促す（自動保存はしない）。",
  ];
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
