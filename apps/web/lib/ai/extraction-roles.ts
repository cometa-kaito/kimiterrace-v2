import type { TenantRole } from "@kimiterrace/db";

/**
 * teacher_inputs(F01/F02) を AI 抽出できる role = **school_admin のみ**（指摘ログ finding⑧）。
 *
 * teacher-input サブシステム（音声/テキスト/ファイル → 構造化抽出 → RAG 知識源）は教員から撤去し学校管理者に
 * 集約する（`TEACHER_INPUT_STAFF_ROLES` と同一境界）。抽出は transcript（生徒文脈の自由記述を含みうる）・
 * 職員氏名 roster(PII) 読取・Vertex 起動を伴うため、**teacher を含めると teacher-input 撤去の裏口になる**
 * （同一校なら id 指定で他者の入力を抽出しうる・RLS は role 境界を守らない・ルール2）。生徒・保護者は元より不可。
 *
 * **pure（server 依存なし）モジュールに置く**: `run-extraction.ts`（`getCurrentUser`/`withUserSession` 等の
 * server 依存を引く）から分離し、認可マトリクス等の node 単体テストから import 可能にする（他の gate 定数
 * `PUBLISHER_ROLES`/`TEACHER_INPUT_STAFF_ROLES` と同方針）。`satisfies` で TenantRole の妥当性を担保（ルール3）。
 */
export const EXTRACTION_AUTHOR_ROLES = ["school_admin"] as const satisfies readonly TenantRole[];
