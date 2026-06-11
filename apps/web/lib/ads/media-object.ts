/**
 * サイネージ広告メディアの **オブジェクトキー規約と同一オリジン配信パス**（#46 / ADR-037）。
 *
 * 広告クリエイティブは公開 ad-media バケット（`infrastructure/terraform/modules/ad_media`）に保存するが、
 * **サイネージ実機は `app.school-signage.net` のみ到達可（県教委 Wi-Fi の FQDN 許可リスト・prod main.tf /
 * docs/discovery/wifi-filter-method.md）で `storage.googleapis.com` は遮断されうる**。そこで `ads.media_url`
 * には GCS 直 URL ではなく **web 自身が配信する同一オリジン URL（`/ad-media/<key>`）** を保存し、配信 Route
 * （`app/ad-media/[...key]/route.ts`）がバケットからオブジェクトを stream する（ADR-037）。
 *
 * 純粋関数のみ（副作用なし）。アップロード受口（`/api/ads/media`）と配信 Route の双方が依存する単一ソース
 * （ルール3）で、キー検証ロジックを 1 箇所に集約して齟齬を防ぐ。
 */

/**
 * 全アップロード広告メディアを置くオブジェクトキーの接頭辞。配信 Route はこの接頭辞配下のみ serve し、
 * バケット内の任意オブジェクトを引ける汎用プロキシにならないよう制限する（多層防御）。
 */
export const AD_MEDIA_OBJECT_PREFIX = "ads";

/** オブジェクトキーの実務上限（暴走入力・極端に長い path を弾く）。 */
const KEY_MAX_LENGTH = 512;

/** 各セグメントに許す文字（英数・`.`・`_`・`-`）。`/` は区切りとして別途扱う。 */
const SEGMENT_RE = /^[0-9a-zA-Z._-]+$/;

/**
 * 配信 Route が受けたキーが安全かを検証する。
 *
 * - 接頭辞 `ads/` で始まる（汎用バケットプロキシ化の防止）。
 * - `/` 区切りの各セグメントが安全文字のみで、空・`.`・`..` を含まない（path traversal 防止）。
 * - 先頭/末尾の `/`・連続 `/`（空セグメント）を許さない。
 * - 総長 1..{@link KEY_MAX_LENGTH}。
 *
 * 公開掲示物（PII 無し）ゆえ機密性リスクは低いが、`..` 等で接頭辞外へ抜ける入力は構造的に拒否する。
 */
export function isValidAdMediaKey(key: unknown): key is string {
  if (typeof key !== "string") {
    return false;
  }
  if (key.length === 0 || key.length > KEY_MAX_LENGTH) {
    return false;
  }
  const segments = key.split("/");
  // 先頭セグメントは必ず接頭辞。以降に最低 1 セグメント（実ファイル）が要る。
  if (segments.length < 2 || segments[0] !== AD_MEDIA_OBJECT_PREFIX) {
    return false;
  }
  return segments.every(
    (seg) => seg.length > 0 && seg !== "." && seg !== ".." && SEGMENT_RE.test(seg),
  );
}

/**
 * オブジェクトキー → サイネージが `<img>`/`<video>` で GET する**同一オリジン配信 URL パス**。
 * `ads.media_url` にはこの相対パス（先頭 `/`）を保存し、`app.school-signage.net` 配下から配信する。
 */
export function adMediaServingPath(key: string): string {
  return `/ad-media/${key}`;
}

/**
 * アップロード保存先のオブジェクトキーを組み立てる: `ads/<schoolId>/<objectId>.<ext>`。
 *
 * - **per-school prefix**: `schoolId` を第1階層に置き（upload_storage と同規律）、将来 IAM condition で
 *   prefix 単位の境界を張れる土台にする。`schoolId` はサーバ（セッション）由来で client は渡さない。
 * - **objectId はサーバ生成 UUID**、**ext は検証済み MIME 由来**（クライアントのファイル名を path に使わない
 *   = path traversal 防止）。生成キーは必ず {@link isValidAdMediaKey} を満たす。
 *
 * @throws RangeError 各要素が空、または `/`・`.` 等の区切りを含むとき（prefix 境界を跨ぐ injection を防ぐ）。
 */
export function buildAdMediaObjectKey(schoolId: string, objectId: string, ext: string): string {
  if (!schoolId || schoolId.includes("/")) {
    throw new RangeError("buildAdMediaObjectKey: schoolId が不正");
  }
  if (!objectId || objectId.includes("/")) {
    throw new RangeError("buildAdMediaObjectKey: objectId が不正");
  }
  if (!ext || ext.includes("/") || ext.includes(".")) {
    throw new RangeError("buildAdMediaObjectKey: ext が不正");
  }
  return `${AD_MEDIA_OBJECT_PREFIX}/${schoolId}/${objectId}.${ext}`;
}
