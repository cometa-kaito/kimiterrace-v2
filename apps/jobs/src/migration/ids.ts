import { createHash } from "node:crypto";

/**
 * V1 Firestore ドキュメント → V2 PostgreSQL 行の **決定論的 UUID 導出** (#48-D)。
 *
 * V1 は文字列キー (`schoolId` / `gradeId` …)、V2 は uuid 主キー。移行を**冪等**にするため、
 * V1 のパスから RFC 4122 **UUIDv5** (SHA-1 ベース) で V2 の id を導出する。同じエクスポートを
 * 再実行しても同じ id になり、`onConflictDoUpdate` で重複行を作らず上書きできる。
 *
 * 外部 `uuid` パッケージは入れず `node:crypto` で実装する (依存最小化、CLAUDE.md ルール5 周辺の
 * サプライチェーン面でも望ましい)。
 */

/** キミテラス移行専用の名前空間 UUID (固定。変えると全 id が変わるので不変)。 */
export const MIGRATION_NAMESPACE = "9e1f7a3c-2b48-4d6e-8f01-3a5c7e9b1d2f";

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || /[^0-9a-f]/i.test(hex)) {
    throw new Error(`不正な名前空間 UUID: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

function formatUuid(bytes: Buffer): string {
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * UUIDv5 を計算する。`name` (V1 パス) と `namespace` から決定論的に同じ UUID を返す。
 */
export function uuidv5(name: string, namespace: string = MIGRATION_NAMESPACE): string {
  const ns = uuidToBytes(namespace);
  const hash = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(name, "utf8")]))
    .digest();
  const bytes = hash.subarray(0, 16);
  // version 5 (0101) を上位ニブルに、variant (10xx) をセット。
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/**
 * V1 パスから V2 id を導出する規約 (collision を避けるため種別プレフィックスを付ける)。
 * いずれも入力が同じなら同じ uuid を返す (冪等)。
 */
export const v2Id = {
  school: (schoolId: string) => uuidv5(`school:${schoolId}`),
  department: (schoolId: string, deptId: string) => uuidv5(`school:${schoolId}/dept:${deptId}`),
  grade: (schoolId: string, gradeId: string) => uuidv5(`school:${schoolId}/grade:${gradeId}`),
  class: (schoolId: string, gradeId: string, classId: string) =>
    uuidv5(`school:${schoolId}/grade:${gradeId}/class:${classId}`),
  config: (schoolId: string, scopeKey: string, kind: string) =>
    uuidv5(`school:${schoolId}/config:${scopeKey}:${kind}`),
  dailyData: (schoolId: string, scopeKey: string, date: string) =>
    uuidv5(`school:${schoolId}/daily:${scopeKey}:${date}`),
  ad: (schoolId: string, scopeKey: string, index: number) =>
    uuidv5(`school:${schoolId}/ad:${scopeKey}:${index}`),
};
