import type { AssistantDraft, DraftSectionKind } from "@/lib/editor/assistant-chat-core";
import type { Extraction } from "@kimiterrace/ai";

/**
 * AI 精度評価（eval harness）の **純採点ロジック**（DB/Vertex 非依存・常時ユニットテスト対象）。
 *
 * 期待値はチェックリストに展開され、1 ケースのスコア = passed / total。exact match でなく
 * 「代替語 any-of × キーワード群 all-of」の含有マッチにする（モデル出力の言い回し揺れに頑健、
 * ただし日付・時限は厳密一致）。ランナー（assistant-eval.test.ts・RUN_AI_EVAL gate）が
 * 実 Vertex 応答へ適用し、カテゴリ別に集計する。
 */

/** 代替語グループ（いずれか 1 つが含まれていれば match）。 */
export type Alternatives = readonly string[];

/** 予定 1 コマの期待値（period は厳密一致・subject は代替語含有）。 */
export type ExpectedSchedule = { period: number; subject: Alternatives };

/** 連絡 1 件の期待値（keywords の各グループが同一 text 内で all-of）。 */
export type ExpectedNotice = { keywords: readonly Alternatives[]; isHighlight?: boolean };

/** 提出物 1 件の期待値（deadline は YYYY-MM-DD 厳密一致）。 */
export type ExpectedAssignment = {
  deadline: string;
  subject?: Alternatives;
  taskKeywords?: readonly Alternatives[];
};

/** 1 日分（top-level または days の 1 要素）のセクション期待値。 */
export type SectionExpectation = {
  schedules?: readonly ExpectedSchedule[];
  notices?: readonly ExpectedNotice[];
  assignments?: readonly ExpectedAssignment[];
};

/** 会話型 AI 1 ターンの期待値。 */
export type AssistantExpectation = SectionExpectation & {
  /** 複数日まとめの期待（date 厳密一致・期待外の date は減点）。 */
  days?: readonly ({ date: string } & SectionExpectation)[];
  /** top-level で空であるべきセクション。 */
  emptySections?: readonly DraftSectionKind[];
  /** days を使ってはならない（単一日指示）。 */
  noDays?: boolean;
  /** reply の必須要素（各グループ any-of・全グループ all-of）。 */
  replyIncludesAny?: readonly Alternatives[];
};

/** 採点の 1 チェック（レポートで失敗箇所を特定できる粒度）。 */
export type Check = { name: string; pass: boolean; detail?: string };

/** NFKC + 小文字 + 空白除去（全角/半角・大小・スペース揺れを吸収）。 */
function norm(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function includesAny(text: string, alts: Alternatives): boolean {
  const t = norm(text);
  return alts.some((a) => t.includes(norm(a)));
}

/** 期待アイテム列 → 実アイテム列 の貪欲 1:1 マッチ（マッチした実 index 集合を返す）。 */
function matchItems<E, A>(
  expected: readonly E[],
  actual: readonly A[],
  matches: (e: E, a: A) => boolean,
  label: (e: E, i: number) => string,
  checks: Check[],
): Set<number> {
  const used = new Set<number>();
  expected.forEach((e, i) => {
    const hit = actual.findIndex((a, j) => !used.has(j) && matches(e, a));
    if (hit >= 0) {
      used.add(hit);
      checks.push({ name: label(e, i), pass: true });
    } else {
      checks.push({ name: label(e, i), pass: false, detail: "期待アイテムが出力に無い" });
    }
  });
  return used;
}

/** 1 日分のセクション期待値を採点する（prefix はレポート上の名前空間）。 */
function scoreSections(
  prefix: string,
  exp: SectionExpectation,
  actual: Pick<AssistantDraft, "schedules" | "notices" | "assignments">,
  checks: Check[],
): void {
  if (exp.schedules) {
    const used = matchItems(
      exp.schedules,
      actual.schedules,
      (e, a) => a.period === e.period && includesAny(a.subject, e.subject),
      (e) => `${prefix}予定 ${e.period}限=${e.subject[0]}`,
      checks,
    );
    checks.push({
      name: `${prefix}予定に余計な項目が無い`,
      pass: actual.schedules.length <= used.size,
      detail: `期待${exp.schedules.length}件/出力${actual.schedules.length}件`,
    });
  }
  if (exp.notices) {
    const used = matchItems(
      exp.notices,
      actual.notices,
      (e, a) =>
        e.keywords.every((g) => includesAny(a.text, g)) &&
        (e.isHighlight === undefined || a.isHighlight === e.isHighlight),
      (e) => `${prefix}連絡「${e.keywords[0]?.[0] ?? ""}」`,
      checks,
    );
    checks.push({
      name: `${prefix}連絡に余計な項目が無い`,
      pass: actual.notices.length <= used.size,
      detail: `期待${exp.notices.length}件/出力${actual.notices.length}件`,
    });
  }
  if (exp.assignments) {
    const used = matchItems(
      exp.assignments,
      actual.assignments,
      (e, a) =>
        a.deadline === e.deadline &&
        (e.subject === undefined || includesAny(a.subject, e.subject)) &&
        (e.taskKeywords === undefined || e.taskKeywords.every((g) => includesAny(a.task, g))),
      (e) => `${prefix}提出物 締切${e.deadline}`,
      checks,
    );
    checks.push({
      name: `${prefix}提出物に余計な項目が無い`,
      pass: actual.assignments.length <= used.size,
      detail: `期待${exp.assignments.length}件/出力${actual.assignments.length}件`,
    });
  }
}

/** 会話型 AI 1 ターン（reply + sanitize 済み下書き）を採点し、チェック列を返す。 */
export function scoreAssistantTurn(
  expected: AssistantExpectation,
  actual: { reply: string; draft: AssistantDraft },
): Check[] {
  const checks: Check[] = [];
  scoreSections("", expected, actual.draft, checks);

  for (const section of expected.emptySections ?? []) {
    const n = actual.draft[section].length;
    checks.push({ name: `${section} が空`, pass: n === 0, detail: `${n}件出力された` });
  }

  if (expected.noDays) {
    const n = actual.draft.days?.length ?? 0;
    checks.push({ name: "days を使わない", pass: n === 0, detail: `days=${n}日` });
  }

  if (expected.days) {
    const actualDays = actual.draft.days ?? [];
    for (const day of expected.days) {
      const found = actualDays.find((d) => d.date === day.date);
      checks.push({ name: `days ${day.date} が存在`, pass: found !== undefined });
      if (found) {
        scoreSections(`days ${day.date}: `, day, found, checks);
      } else {
        // 日が無い場合も期待アイテム分を fail として数える（部分点の公平性）。
        scoreSections(
          `days ${day.date}: `,
          day,
          { schedules: [], notices: [], assignments: [] },
          checks,
        );
      }
    }
    const expectedDates = new Set(expected.days.map((d) => d.date));
    const extras = actualDays.filter((d) => !expectedDates.has(d.date));
    checks.push({
      name: "days に期待外の日付が無い",
      pass: extras.length === 0,
      detail: extras.map((d) => d.date).join(","),
    });
  }

  for (const group of expected.replyIncludesAny ?? []) {
    checks.push({
      name: `reply に「${group[0]}」等を含む`,
      pass: includesAny(actual.reply, group),
      detail: actual.reply.slice(0, 80),
    });
  }
  return checks;
}

/** F03 抽出結果の期待値。 */
export type ExtractionExpectation = {
  scheduleEntries?: readonly ExpectedSchedule[];
  titleKeywords?: readonly Alternatives[];
  bodyKeywords?: readonly Alternatives[];
  summaryKeywords?: readonly Alternatives[];
  /** 各グループが、いずれかのタグに含まれていること。 */
  tagsAny?: readonly Alternatives[];
  minConfidence?: number;
};

/** F03 構造化抽出（status/extraction/confidence）を採点する。 */
export function scoreExtraction(
  expected: ExtractionExpectation,
  result: { status: string; extraction: Extraction | null; confidenceScore: number | null },
): Check[] {
  const checks: Check[] = [];
  checks.push({ name: "status=success", pass: result.status === "success" });
  const ex = result.extraction;
  if (expected.scheduleEntries) {
    const entries = ex?.kind === "schedule" ? ex.data.entries : [];
    matchItems(
      expected.scheduleEntries,
      entries,
      (e, a) => a.period === e.period && includesAny(a.subject, e.subject),
      (e) => `entries ${e.period}限=${e.subject[0]}`,
      checks,
    );
  }
  if (expected.titleKeywords || expected.bodyKeywords) {
    const title = ex?.kind === "announcement" ? ex.data.title : "";
    const body = ex?.kind === "announcement" ? ex.data.body : "";
    for (const g of expected.titleKeywords ?? []) {
      checks.push({ name: `title に「${g[0]}」等`, pass: includesAny(title, g), detail: title });
    }
    for (const g of expected.bodyKeywords ?? []) {
      checks.push({ name: `body に「${g[0]}」等`, pass: includesAny(body, g) });
    }
  }
  if (expected.summaryKeywords) {
    const summary = ex?.kind === "summary" ? ex.data.summary : "";
    for (const g of expected.summaryKeywords) {
      checks.push({ name: `summary に「${g[0]}」等`, pass: includesAny(summary, g) });
    }
  }
  if (expected.tagsAny) {
    const tags = ex?.kind === "tag" ? ex.data.tags : [];
    for (const g of expected.tagsAny) {
      checks.push({
        name: `tags に「${g[0]}」等`,
        pass: tags.some((t) => includesAny(t, g)),
        detail: tags.join(","),
      });
    }
  }
  if (expected.minConfidence !== undefined) {
    checks.push({
      name: `confidence>=${expected.minConfidence}`,
      pass: (result.confidenceScore ?? 0) >= expected.minConfidence,
      detail: String(result.confidenceScore),
    });
  }
  return checks;
}

/** チェック列 → ケーススコア（0..1）。 */
export function caseScore(checks: readonly Check[]): number {
  if (checks.length === 0) {
    return 0;
  }
  return checks.filter((c) => c.pass).length / checks.length;
}
