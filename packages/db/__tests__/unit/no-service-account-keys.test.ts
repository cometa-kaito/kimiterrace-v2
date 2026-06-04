import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * E-03 / SEC-026 (CLAUDE.md ルール5): リポジトリに GCP サービスアカウント JSON 鍵 /
 * PEM 秘密鍵が混入していないことの静的監査（回帰固定）。
 *
 * SEC-026 の防御成功条件: SA JSON 鍵がリポジトリ/成果物に存在しない（Workload Identity /
 * ADC 強制・組織ポリシーで鍵生成禁止）。検出時は merge 不可 + 24h rotation。
 *
 * ルール5: シークレットは Secret Manager のみ。サービスアカウント JSON 鍵ファイルは禁止
 * （Cloud Run は Workload Identity で取得し、JSON 鍵を配布しない）。pre-commit / CI の gitleaks は
 * 別途パターン検知するが、本テストは **テストスイート層の独立した第2の防御線**。gitleaks の
 * 設定差分・無効化・ルール退行・allowlist 肥大があっても、このテストが残る限り鍵混入は
 * CI Test を落として検知される（多層防御）。
 *
 * 検知シグネチャは誤検知を避けるため鍵「ファイル」固有の構造に限定する。HCL の
 * `google_service_account` リソース定義、IAM の `serviceAccount:` メンバ参照、SA メールアドレスの
 * 単独言及などは鍵ではないので対象にしない:
 *   1. GCP SA JSON 鍵の type マーカー（"type" フィールドが SA 値を取る形）
 *   2. PEM 形式の秘密鍵ヘッダ行（RSA / EC / OPENSSH / 無印すべて）
 *
 * 検知パターンは fragment 結合で組み立て、本ファイル自身がシグネチャ文字列を含まないようにする
 * （= 自スキャンでも gitleaks でも本ファイルを誤検知しない）。さらに basename で自己除外もする
 * （二重の保険）。tracked files の列挙は `git ls-files` で行い、node_modules / dist（.gitignore 済）を
 * 自然に除外する。
 *
 * 実 PG を要しない静的監査なので、DATABASE_URL の有無に関わらず常時実行する。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_BASENAME = "no-service-account-keys.test.ts";

// ---- シグネチャ（fragment 結合で本ファイルに literal を残さない） ----
// (1) GCP SA JSON 鍵の type マーカー: "type": "<service+account>"（空白ゆれ許容）
const SA_TYPE_RE = new RegExp(`"type"\\s*:\\s*"${["service", "account"].join("_")}"`);
// (2) PEM 秘密鍵ヘッダ: -----BEGIN [RSA/EC/OPENSSH...] <PRIVATE+KEY>-----
const PEM_RE = new RegExp(`-----BEGIN [A-Z0-9 ]*?${["PRIVATE", "KEY"].join(" ")}-----`);

type Signature = { name: string; re: RegExp };
const SIGNATURES: Signature[] = [
  { name: "GCP SA JSON key (type marker)", re: SA_TYPE_RE },
  { name: "PEM private-key header", re: PEM_RE },
];

/**
 * 監査対象外（正当な occurrence）の allowlist。リポジトリ相対パスの完全一致。
 * `.example` テンプレ等で意図的にダミー鍵形を置く場合のみ、理由付きでここに明示する。
 * 現時点では空（= リポジトリのどこにも実鍵/秘密鍵は無いのが正）。
 */
const ALLOWLIST = new Set<string>([
  // 例: "infrastructure/terraform/sa-key.json.example",
]);

// 2MB 超は鍵ファイルでない想定でスキップ（巨大 blob の無駄読み回避）。
const MAX_BYTES = 2 * 1024 * 1024;

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: HERE,
    encoding: "utf8",
  }).trim();
}

function trackedFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p.length > 0);
}

describe("E-03 / SEC-026: サービスアカウント鍵 / 秘密鍵の混入監査 (ルール5)", () => {
  const root = repoRoot();
  const files = trackedFiles(root);

  it("git tracked files を列挙できる (監査が vacuous でないことの保証)", () => {
    // 0 件だと scan が空回りして「鍵なし」を常に pass してしまう。最低限の母数を要求する。
    expect(files.length).toBeGreaterThan(50);
  });

  it("tracked files に SA JSON 鍵 / PEM 秘密鍵のシグネチャが存在しない", () => {
    const violations: string[] = [];
    for (const rel of files) {
      if (rel.endsWith(SELF_BASENAME)) continue; // 自己除外（保険）
      if (ALLOWLIST.has(rel)) continue;
      const abs = join(root, rel);
      let size: number;
      try {
        size = statSync(abs).size;
      } catch {
        continue; // submodule gitlink 等で実体が無い場合はスキップ
      }
      if (size > MAX_BYTES) continue;
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      for (const sig of SIGNATURES) {
        if (sig.re.test(content)) violations.push(`${rel} :: ${sig.name}`);
      }
    }
    expect(violations, `鍵ファイルらしき混入を検知:\n${violations.join("\n")}`).toEqual([]);
  });

  it("シグネチャ自体は機能する (既知の鍵形を確かに検出できる = 検出器が死んでいない)", () => {
    // 合成サンプル（実鍵ではない）。検出器が正しく hit することを正の対比で固定し、
    // 「常に空配列を返すだけ」の vacuous な監査でないことを保証する。
    const fakeSaJson = `{ "type" : "${["service", "account"].join("_")}", "project_id": "x" }`;
    const fakePem = `-----BEGIN ${["PRIVATE", "KEY"].join(" ")}-----\nMIIE...\n-----END`;
    expect(SA_TYPE_RE.test(fakeSaJson)).toBe(true);
    expect(PEM_RE.test(fakePem)).toBe(true);
    // 正当な参照（鍵ではない）は検出しない: HCL リソース名 / IAM メンバ / SA email 単独。
    expect(SA_TYPE_RE.test('resource "google_service_account" "ci" {}')).toBe(false);
    expect(SA_TYPE_RE.test('"serviceAccount:ci@proj.iam.gserviceaccount.com"')).toBe(false);
    expect(PEM_RE.test("BEGIN PUBLIC KEY")).toBe(false);
  });
});
