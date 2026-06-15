import { type TenantTx, getClassConfigValue } from "@kimiterrace/db";

/**
 * **server 専用**のサイネージ「黒画面」状態の読み取り（per-class）。
 *
 * 教室サイネージを一時的に真っ黒にする運用トグル（web のみ・APK / migration 不要）。保存先は既存
 * `school_configs`（scope='class', class_id=該当, kind='display_settings'）の `value.blackout`（boolean）。
 * **新しい `config_kind` enum 値は足さない**（enum は固定。display_settings に相乗りする）。学校レベル既定の
 * デザイン（`signage-design.ts` の `getSignageDesignPattern`）は **scope='school'** の display_settings 行に
 * `signageDesign` を持ち、本トグルは **scope='class'** の別行なので `ux_school_configs_target`
 * （NULLS NOT DISTINCT 複合一意）の別エントリになり**衝突しない**。
 *
 * 読み取り失敗・行欠落・想定外の形はすべて `false`（黒画面しない＝盤面を出す）に倒す（fail-soft、盤面を
 * 壊さない）。`parseBlackout` は DB 非依存の純ロジックとして切り出し（テスト容易・client からも安全に
 * import 可能）、DB 読み取りは `getClassSignageBlackout` が担う。
 */

/**
 * class スコープ `display_settings` config の `value`（JSONB, opaque）から `blackout` を **defensive に**
 * 取り出す。`value.blackout === true` のときだけ `true`、それ以外（キー欠落・非 boolean・null・行なし）は
 * すべて `false`（既定＝黒画面しない）。
 */
export function parseBlackout(configValue: unknown): boolean {
  if (configValue && typeof configValue === "object" && !Array.isArray(configValue)) {
    return (configValue as Record<string, unknown>).blackout === true;
  }
  return false;
}

/**
 * 自校・指定クラスのサイネージ黒画面フラグを読む（`getSignageDisplayData` のテナント context tx 内、または
 * エディタの `withSession` tx 内で呼ぶ）。`school_configs`（scope='class', class_id, kind='display_settings'）の
 * `value.blackout` を解決。RLS で自校に限定（ルール2、手書き WHERE school_id は書かない）。未設定なら `false`。
 */
export async function getClassSignageBlackout(tx: TenantTx, classId: string): Promise<boolean> {
  const value = await getClassConfigValue(tx, classId, "display_settings");
  return parseBlackout(value);
}
