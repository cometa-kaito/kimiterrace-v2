import { listTeacherLoginSchools } from "@kimiterrace/db";
import { getDb } from "../db";
import { signInWithEmailPassword } from "./password-sign-in";
import { teacherAccountEmail } from "./teacher-account";

/**
 * ADR-032: 教員「学校共通パスワード」ログインのサーバー処理。**サーバー専用**（公開 route から呼ぶ）。
 *
 * セッション無しの公開経路のため、学校解決は `system_admin` role context（packages/db の query 層が内部で
 * 張る）で cross-tenant に行う。パスワード検証は **Identity Platform の REST `signInWithPassword`** に委ね
 * （本 DB にハッシュを持たない、ルール5）、得た idToken を既存の `createSessionCookie` で session cookie 化
 * する（route 側）。`createCustomToken`（signBlob 権限要）は使わない。
 *
 * ## 学校選択は廃止 = **入力パスワードで学校を自動判定**（ADR-032 追補 2026-06-23）
 * 教員は学校を選ばずパスワードのみを入力する。サーバーは共通ログイン有効校それぞれの共通教員アカウントへ
 * 並列にパスワードを試し、**ちょうど 1 校だけ**認証成功したらその学校でログインする。0 校一致は失敗、
 * **2 校以上一致（= 学校間でパスワードが重複）はテナント越境防止のため拒否**（`ambiguous`）。
 * → 運用前提: **共通パスワードは全校でユニーク**にする（重複校は両方ともログイン不能になる安全側挙動）。
 */

/** 学校特定 + 認証の結果。route はいずれの失敗も 401 に畳む（`ambiguous` だけ運用是正の warn を残す）。 */
export type TeacherLoginOutcome =
  | { ok: true; schoolId: string; idToken: string }
  | { ok: false; reason: "no_schools" | "no_match" }
  | { ok: false; reason: "ambiguous"; schoolIds: string[] };

/**
 * 自動判定で 1 リクエストあたり試行する学校数の上限（IdP 呼び出し増幅の安全弁）。
 * 現実規模では有効校は 1〜数校。超過時は名前順で先頭 N 校のみ試行する（それ以降の校は別途 per-school URL 等が要る）。
 */
export const MAX_AUTODETECT_SCHOOLS = 25;

/** per-school のサインイン試行結果（idToken: 認証成功で文字列 / 失敗で null）。 */
type SignInAttempt = { schoolId: string; idToken: string | null };

/**
 * per-school のサインイン試行結果からログイン対象を選ぶ**純関数**（IO なし＝テスト容易）。
 * - 一致 0 件: 有効校が無ければ `no_schools`、有るが不一致なら `no_match`（route はどちらも 401 に畳む）。
 * - 一致 ちょうど 1 件: その学校でログイン。
 * - 一致 2 件以上: 学校間でパスワードが重複 = どの校か曖昧 → **テナント越境防止のため拒否**（`ambiguous`）。
 */
export function selectTeacherLoginMatch(
  results: ReadonlyArray<SignInAttempt>,
): TeacherLoginOutcome {
  const matches = results.filter(
    (r): r is { schoolId: string; idToken: string } => r.idToken !== null,
  );
  const [only, ...rest] = matches;
  if (only === undefined) {
    return { ok: false, reason: results.length === 0 ? "no_schools" : "no_match" };
  }
  if (rest.length > 0) {
    return { ok: false, reason: "ambiguous", schoolIds: matches.map((m) => m.schoolId) };
  }
  return { ok: true, schoolId: only.schoolId, idToken: only.idToken };
}

/**
 * 入力パスワードだけで「どの学校の共通教員ログインか」を自動判定し認証する（学校選択レス）。
 *
 * 共通ログイン有効校それぞれの IdP 共通教員アカウントへ**並列に**パスワードを試し、`selectTeacherLoginMatch`
 * で対象を決める。試行先は IdP 呼び出し増幅を抑えるため {@link MAX_AUTODETECT_SCHOOLS} 校で頭打ち。
 *
 * `deps` は省略可（既定で本番依存を使う）。テストはここに fake を注入し IdP/DB なしで分岐を検証する。
 */
export async function authenticateTeacherByPassword(
  password: string,
  deps: {
    listSchools?: () => Promise<{ id: string }[]>;
    signIn?: (schoolId: string, password: string) => Promise<string | null>;
  } = {},
): Promise<TeacherLoginOutcome> {
  // 既定: listTeacherLoginSchools は「RLS の扉」関数に getDb() を**直接**渡す（内部で system_admin 文脈を張る。
  // チョークポイント監査 rls-chokepoint-audit.test.ts の扉 allowlist 経路）。
  const listSchools = deps.listSchools ?? (() => listTeacherLoginSchools(getDb()));
  const signIn = deps.signIn ?? signInSharedTeacher;

  const candidates = await listSchools();
  if (candidates.length === 0) {
    return { ok: false, reason: "no_schools" };
  }
  const targets = candidates.slice(0, MAX_AUTODETECT_SCHOOLS);
  const results = await Promise.all(
    targets.map(async (s) => ({ schoolId: s.id, idToken: await signIn(s.id, password) })),
  );
  return selectTeacherLoginMatch(results);
}

/**
 * Identity Platform の REST `signInWithPassword` で共通教員アカウントにサインインし idToken を得る。
 * 公開 API キー（`NEXT_PUBLIC_FIREBASE_API_KEY`、秘密ではない）で叩く。失敗（パスワード不一致 / アカウント
 * 無効 / 設定不備）は **null**（route が 401 に写像。理由を細分化して列挙攻撃の手掛かりを与えない）。
 */
export async function signInSharedTeacher(
  schoolId: string,
  password: string,
): Promise<string | null> {
  return await signInWithEmailPassword(teacherAccountEmail(schoolId), password);
}
