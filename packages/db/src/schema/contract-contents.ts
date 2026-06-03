import { sql } from "drizzle-orm";
import { index, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { contents } from "./contents.js";
import { contracts } from "./contracts.js";

/**
 * F10 (#46): 契約 ⇄ 出稿コンテンツの紐付け（多対多の中間テーブル）。
 *
 * 1 契約に複数コンテンツ、1 コンテンツが複数契約に紐づくことを想定（M:N）。F09 広告主レポートの
 * 「どの契約でどの広告（コンテンツ）を出したか」集計・到達数請求の根拠になる関連表。
 *
 * **cross-tenant CRM 管理表（テナント分離なし）だが RLS 有効**。`contracts` / `advertisers` と同じ
 * ADR-018/019 の二層モデルで、`school_id` は**持たない**。DB 層のアクセス制御は migration の
 * `system_admin_full_access` ポリシー**のみ**で、`tenant_isolation` は貼らない（CRM 関連表は
 * system_admin 専用、F10 受け入れ条件）。middleware（第一層）+ RLS（DB 層）の二層防御。
 *
 * なぜ `school_id` を持たない（= contents 側の school_id をミラーしない）か:
 *   - 本表は **CRM の関連付け**であって、テナント分離キーで守るべきデータではない。`contract_id` 経由で
 *     必ず cross-tenant の `contracts` に到達するため、tenant_isolation で守ると逆に system_admin が
 *     扱えず矛盾する（contracts/communications と同区分）。
 *   - 紐付いた `content` のタイトル等は `contents` の RLS に委ねる。`contents` には migration 0002 で
 *     `system_admin_full_access` policy が貼られており、**system_admin context では cross-tenant に
 *     全 contents が可視**なので、紐付け一覧の表示はその policy 経由で成立する（非 system_admin は
 *     `contents` の tenant_isolation で自校分のみ、本表は 0 行になり結合結果も空）。
 *
 * FK の onDelete:
 *   - `contract_id` → `contracts.id` ON DELETE CASCADE: 契約削除で関連行も消す（関連は契約の従属）。
 *   - `content_id`  → `contents.id`  ON DELETE CASCADE: コンテンツ削除で関連行も消す（同上）。
 *   （物理 FK は migration 側で付与する。本表は cross-tenant 表 ↔ テナント表をまたぐが、参照は id 単独で
 *     composite ではない＝関連の存在は CRM 側の関心事で、テナント整合は contents 自身の RLS が守る。）
 *
 * 重複防止: `UNIQUE(contract_id, content_id)` で同一契約に同一コンテンツを二重紐付けできない。
 *
 * 監査: 各行に auditColumns（CLAUDE.md ルール1）。link/unlink は system_admin が行うため actor は
 *   NULL（system_admin は users 行ではない、contracts と同じ扱い）。
 *
 * 関連: ADR-018 (CRM 独自設計), ADR-019 (二層 RLS), F10 (docs/requirements/functional/F10-crm.md)
 */
export const contractContents = pgTable(
  "contract_contents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    ...auditColumns,
  },
  (t) => ({
    // 同一契約 × 同一コンテンツの二重紐付けを DB で禁止（link アクションは conflict に倒す）。
    uqContractContent: unique("uq_contract_contents_contract_content").on(
      t.contractId,
      t.contentId,
    ),
    // 契約からの一覧（紐付いたコンテンツの列挙）と、コンテンツからの逆引き（F09 集計）両方向の索引。
    ixContract: index("ix_contract_contents_contract_id").on(t.contractId),
    ixContent: index("ix_contract_contents_content_id").on(t.contentId),
  }),
);
