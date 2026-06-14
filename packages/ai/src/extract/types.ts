/**
 * F01 テキスト抽出レイヤの型（CLAUDE.md ルール3: 型は単一ソース）。
 *
 * 役割: PDF / Word / Excel / 画像などのアップロード素材から **素テキストを取り出す前段**。
 * 出力テキストはそのまま {@link "../structure".structureContent} の `input` に渡せる形にそろえる
 * （F01 抽出 → F03 構造化 のパイプライン接続点）。
 *
 * 重要（CLAUDE.md ルール4）: ここで取り出したテキストは **まだ PII マスキングされていない**。
 * Vertex AI へ送る経路（structureContent / embedding）に渡す前に必ず PII マスキングを通すこと。
 * 抽出器自体が外部 OCR（Vertex Vision 等）を呼ぶ実装になる場合は、画像そのものが PII を含む
 * 外部委託になるため、後述の `ExtractMeta.ocrUsed` を立てて監査側が判別できるようにする。
 *
 * パーサ依存（pdf / docx / xlsx / OCR）はこのレイヤでは **import しない**。具象抽出器は
 * インターフェースとフェイルクローズな未設定スタブのみを置き、依存追加とその配線は別 PR で行う。
 */

/** 抽出元の素材形式。 */
export const SOURCE_FORMATS = ["pdf", "docx", "xlsx", "image", "text"] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

/** 抽出への入力。バイト列と、形式推定の手掛かり（任意）。 */
export interface ExtractSource {
  /** 元ファイルのバイト列。 */
  bytes: Uint8Array;
  /** 元ファイル名。拡張子から形式を推定する手掛かり（任意）。 */
  filename?: string;
  /** MIME タイプ。`filename` より優先して形式推定に使う（任意）。 */
  mimeType?: string;
  /** 形式を明示する場合（推定をスキップして直接指定）。 */
  format?: SourceFormat;
}

/** 形式別の補足メタ。監査・後段処理の判断材料に使う。 */
export interface ExtractMeta {
  /** PDF / 画像のページ数。 */
  pageCount?: number;
  /** Excel のシート名一覧。 */
  sheetNames?: string[];
  /**
   * 外部 OCR（既定バックエンド = Vertex Gemini マルチモーダル, ADR-038・旧 ADR-024 決定2 Cloud Vision を supersede）を
   * 経由したか。true の場合、画像そのものが外部委託に送られた（ルール4）。監査側が記録する。
   */
  ocrUsed?: boolean;
  /** 抽出器が信頼度を出せる場合（0..1）。OCR の確信度など。 */
  confidence?: number;
}

/** 抽出結果。`text` を structureContent の `input` にそのまま渡せる。 */
export interface ExtractedText {
  /** 抽出した素テキスト。**まだ PII マスキングしていない**（ルール4 注意）。 */
  text: string;
  /** 抽出元として判定した形式。 */
  format: SourceFormat;
  /** 形式別の補足（任意）。 */
  meta?: ExtractMeta;
}

/** OCR バックエンドの認識結果（テキスト + 任意の信頼度）。 */
export interface OcrResult {
  /** 認識した素テキスト。**PII 未マスク**（画像中の生徒氏名・手書き等を含みうる）。 */
  text: string;
  /** バックエンドが返す信頼度（0..1）。出せない場合は省略。 */
  confidence?: number;
}

/**
 * 画像 OCR バックエンドの境界（ADR-024 決定3: 依存逆転でテスタブルに）。
 * `ModelClient`（ADR-006）と同じ思想で、実 Cloud Vision アダプタを差し替え可能にし、
 * credential を要する実呼び出しを単体テスト/CI に持ち込まない。
 *
 * ⚠ OCR は **画像そのものを外部委託に送る**（既定バックエンド = Vertex Gemini マルチモーダル, ADR-038）。
 * 実装側は呼び出しを `audit_log` に記録し（who/school_id/画像ハッシュ/結果文字数）、結果テキストは下流で
 * 必ず PII マスキングを通すこと（ルール4）。
 */
export interface OcrClient {
  /**
   * バイト列（画像）を OCR してテキストを返す。`mediaType`（IANA メディアタイプ・例 "image/png"）は
   * マルチモーダル LLM バックエンド（Gemini 直送 / ADR-038）が画像パートに付与するための任意ヒント。
   * Cloud Vision アダプタ（ADR-024）は内容から判定するため無視してよい（後方互換）。
   */
  recognize(bytes: Uint8Array, mediaType?: string): Promise<OcrResult>;
}

/**
 * 単一形式のテキスト抽出器。
 * 形式ごとに実装し、{@link "./registry".ExtractorRegistry} に登録して使う。
 */
export interface DocumentExtractor {
  /** この抽出器が担当する形式。 */
  readonly format: SourceFormat;
  /** 指定形式を扱えるか。 */
  supports(format: SourceFormat): boolean;
  /** バイト列からテキストを抽出する。未設定の具象は {@link ExtractorNotConfiguredError} を投げる。 */
  extract(source: ExtractSource): Promise<ExtractedText>;
}

/** 形式が推定できない / 未対応のときに投げる。 */
export class UnsupportedFormatError extends Error {
  constructor(public readonly hint: string) {
    super(`F01 extract: unsupported or undetectable format (${hint})`);
    this.name = "UnsupportedFormatError";
  }
}

/**
 * レガシーバイナリ Office 形式（.doc / .xls）を検出したときに投げる。
 * OOXML（.docx / .xlsx）と異なり本レイヤのパーサでは解析できないため、変換を促す。
 * `UnsupportedFormatError` を継承するので既存の catch でも拾える一方、`suggested` で
 * 呼び出し側が「.docx に変換して再アップロード」と具体的に案内できる。
 */
export class LegacyOfficeFormatError extends UnsupportedFormatError {
  constructor(
    public readonly legacyExt: string,
    public readonly suggested: string,
  ) {
    super(`legacy binary Office format '.${legacyExt}'; convert to '.${suggested}' and re-upload`);
    this.name = "LegacyOfficeFormatError";
  }
}

/**
 * 具象抽出器がまだ依存パーサ未配線で実行できないときに投げる（フェイルクローズ）。
 * `dependency` には別 PR で追加すべきパッケージ名を入れ、配線者が一目で分かるようにする。
 */
export class ExtractorNotConfiguredError extends Error {
  constructor(
    public readonly format: SourceFormat,
    public readonly dependency: string,
  ) {
    super(
      `F01 extract: '${format}' extractor not configured; ` +
        `add dependency '${dependency}' and wire the parser (see TODO in extractors.ts)`,
    );
    this.name = "ExtractorNotConfiguredError";
  }
}

/**
 * 配線済み抽出器でパーサが解析に失敗したときに投げる（ADR-024 決定4: フェイルクローズ）。
 * パーサ例外を握りつぶして空文字を返すのは禁止 — 破損 / 暗号化 / 非対応サブ形式は
 * このエラーで上流に伝え、`cause` に元例外を保持して原因追跡できるようにする。
 */
export class ExtractFailedError extends Error {
  constructor(
    public readonly format: SourceFormat,
    public readonly dependency: string,
    cause: unknown,
  ) {
    super(
      `F01 extract: '${format}' extraction failed via '${dependency}': ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "ExtractFailedError";
  }
}
