/**
 * 脅威モデル I-03 (Cloud Logging への PII 出力) の緩和: 構造化ログ payload の **自動 PII マスキング**。
 *
 * 開発者が誤って生 PII を含むオブジェクトを log に渡しても (`logger.error("save failed", { schedule })`
 * の `schedule.student.fullName` など)、Cloud Logging へ書き出す前に `***` へ伏せる **defense-in-depth**。
 * CLAUDE.md ルール4 / NFR03 / threat-model.md I-03。
 *
 * ## 方針 (precision 優先)
 * - **key 名 denylist** が一次防御: PII を表す典型的なフィールド名 (氏名・連絡先・住所・自由記述) は
 *   値ごと `***` に伏せる。key 正規化は lowercase + 非英数字除去なので `studentName` / `student_name`
 *   / `STUDENT-NAME` を等価に扱う。
 * - **値の正規表現** が二次防御: denylist 外の key でも、文字列値に **メール / ハイフン区切り電話番号**が
 *   埋め込まれていれば、その**部分文字列のみ** `***` に置換する (文脈は残す)。
 * - **氏名の値ベース検出は意図的に行わない**: 日本語氏名を正規表現で判定すると誤検知が多く、正当な
 *   非 PII 文字列まで壊す。氏名は key denylist + 「msg 自由記述に PII を書かない」規律 (logger.ts の
 *   NOTE) で守る。ハイフン無し連番電話も stable ID (UUID) との誤検知を避けるため値正規表現には含めない。
 * - **stable ID は伏せない**: `schoolId` / `userId` / `contentId` / `id` 等は rule4 が推奨する安全な
 *   代替なので denylist に入れない。
 *
 * ## 限界
 * - pino の `formatters.log` は **payload オブジェクト**のみを受け取り、`msg` 文字列 (例:
 *   `logger.info(\`生徒 ${name}\`)`) は通らない。free-text への PII 埋め込みは依然開発者責務
 *   (logger.ts NOTE + 将来の Biome no-template-literal-PII / no-console 強化で補強、I-03 後続)。
 */

/** 伏字。 */
const CENSOR = "***";

/** 再帰の深さ上限 (病的な深い/循環オブジェクトでの暴走防止)。超過分は安全側に伏せる。 */
const MAX_DEPTH = 8;

/**
 * PII を表す key 名 (正規化形: lowercase + 非英数字除去)。値ごと伏せる。
 * stable ID 系 (id/schoolId/userId/...) は**意図的に含めない** (rule4 推奨の安全な代替)。
 */
const PII_KEY_DENYLIST: ReadonlySet<string> = new Set([
  // 氏名系
  "name",
  "fullname",
  "firstname",
  "lastname",
  "studentname",
  "parentname",
  "guardianname",
  "mothername",
  "fathername",
  "siblingname",
  "emergencyname",
  "emergencycontact",
  "kana",
  "furigana",
  "ruby",
  // 連絡先 (phone/email は下の isPiiKey 部分一致でも捕捉。ここは exact 補完)
  "phone",
  "phonenumber",
  "tel",
  "telephone",
  "mobile",
  "fax",
  "email",
  "mail",
  "emailaddress",
  "address",
  "addr",
  "homeaddress",
  "contactaddress",
  "postal",
  "postalcode",
  "zipcode",
  "zip",
  // 自由記述 (PII を含みうる。#234 feedback の studentEpisode / improvement 等)
  "studentepisode",
  "episode",
  "improvement",
  "note",
  "notes",
  "memo",
  "feedback",
  "comment",
  "remarks",
  "freetext",
  // 生年月日
  "birthday",
  "birthdate",
  "dob",
]);

/** key を比較用に正規化する (lowercase + 非英数字除去)。`student_name`→`studentname`。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * denylist 判定。exact 一致に加え、**高シグナル・低誤検知**の token `phone` / `email` は
 * 部分一致でも PII とみなす (`contactPhone` / `parent_email` / `mobilePhone` 等の実スキーマ列を
 * 列挙せずに捕捉)。`tel` / `name` / `address` は `telemetry` / `filename` / `ipAddress` 等の誤検知が
 * あるため部分一致には使わず exact 判定に留める。`emailEnabled` 等の boolean が伏字化される軽微な
 * 過剰伏字は privacy 側に倒す許容トレードオフ。
 */
function isPiiKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (PII_KEY_DENYLIST.has(normalized)) return true;
  return normalized.includes("phone") || normalized.includes("email");
}

/**
 * メールアドレス (部分一致)。多項式バックトラッキング (js/polynomial-redos) を 2 点で排除する:
 * (1) ドメインは「`.` を含まないラベル」を literal `.` で連結し、クラスと隣接 literal の `.` 重複を無くす。
 * (2) **全量化子を有界化** (RFC5321 準拠: local ≤64 / label ≤63、ラベル数も上限)。無制限の `+` は
 * 入力長に対し試行コストが線形に伸び、scan と合わせ O(n^2) になるため。長すぎるメールは部分一致しない
 * 軽微な recall 低下を許容 (ReDoS 不在を優先)。
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;
/** ハイフン区切りの日本電話番号 (`058-271-1111` / `090-1234-5678` 等)。日付 YYYY-MM-DD は末尾桁不足で不一致。 */
const PHONE_RE = /\b0\d{1,4}-\d{1,4}-\d{3,4}\b/g;

/** 文字列値に埋め込まれた PII パターン (メール / 電話) を部分置換する。 */
function redactStringValue(value: string): string {
  return value.replace(EMAIL_RE, CENSOR).replace(PHONE_RE, CENSOR);
}

/**
 * 任意の値を深く走査し、PII を伏せた**新しい**値を返す (引数は破壊しない)。
 *
 * - key が denylist 一致 → 値ごと `***`。
 * - 文字列値 → メール / 電話の部分置換。
 * - object / array → 再帰。循環は `[Circular]`、深さ超過は `***` に倒す (fail-closed)。
 * - その他のプリミティブ (number/boolean/null/bigint) → そのまま。
 */
export function redactPii(input: unknown): unknown {
  return redactValue(input, 0, new WeakSet<object>());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactStringValue(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  // ここから object / array。
  if (depth >= MAX_DEPTH) {
    return CENSOR;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  // `seen` は**現在の祖先パス**のみを表す。subtree 退出時に delete することで、循環 (祖先の再訪) は
  // [Circular] に倒しつつ、DAG (同一ノードを兄弟が共有する非循環参照) を誤って消さない (Medium-1)。
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => redactValue(item, depth + 1, seen));
  } else {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isPiiKey(key) ? CENSOR : redactValue(val, depth + 1, seen);
    }
    result = out;
  }
  seen.delete(value);
  return result;
}
