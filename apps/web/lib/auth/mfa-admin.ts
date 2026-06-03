import { getAdminAuth } from "./adminApp";

/**
 * F11 (#47, ADR-031): MFA enrollment 状態を **Identity Platform (Admin SDK) から読む** server-only seam。
 *
 * ADR-031 / ADR-026 の方針: **エンフォースの単一ソースは IdP**。ある教職員が第2要素を登録済みか
 * どうかの真実は IdP の `UserRecord.multiFactor.enrolledFactors` であり、DB のミラーフラグやクライアント
 * からの自己申告ではない。enrollment 強制ゲート (default OFF, ADR-031 §3) と enrollment 監査
 * (ルール1) は、いずれもこの authoritative な値を根拠にする (クライアントの factorCount を信用しない)。
 *
 * **サーバー専用** (firebase-admin)。Server Component / Server Action からのみ呼ぶ。`uid` は Identity
 * Platform の localId で、provisioning 前提により localId == `users.id`(UUID) (ADR-003、
 * session.ts の normalizeClaims docstring 参照)。
 *
 * **PII (ルール4)**: 戻り値は登録済み factor の **件数のみ**。`MultiFactorInfo` は SMS の場合
 * `phoneNumber` を含みうるため、本 seam は **件数に縮約**して呼出側へ返し、電話番号等の PII が
 * 監査・ログ・ページ props に流れ込むのを構造的に防ぐ (factor の中身は返さない)。
 */

/**
 * 指定ユーザーの **登録済み第2要素 (MFA) の件数**を IdP から取得する。
 *
 * 0 = 未登録 (強制ゲート ON 時は enrollment へ誘導対象)。1 以上 = 登録済み。
 *
 * `getUser` が失敗 (ユーザー不在・IdP 障害) した場合は例外を伝播させる。呼出側は強制ゲートの文脈で
 * **安全側 (= 未登録扱いで誘導、ただしブロックはしない)** に倒すか、enrollment 監査の文脈で操作を
 * 中断するかを判断する (本 seam は判断を持たず authoritative 値の取得に徹する)。
 */
export async function getEnrolledMfaFactorCount(uid: string): Promise<number> {
  const userRecord = await getAdminAuth().getUser(uid);
  // multiFactor は未設定なら undefined。enrolledFactors は登録済み第2要素の配列。
  return userRecord.multiFactor?.enrolledFactors.length ?? 0;
}
