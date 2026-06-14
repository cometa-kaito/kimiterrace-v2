import { createVertex } from "@ai-sdk/google-vertex";
import { generateText } from "ai";
import type { OcrClient, OcrResult } from "../types.js";

/**
 * Vertex Gemini マルチモーダルを実体とする {@link OcrClient} アダプタ（ADR-038）。
 *
 * **ADR-024 決定2（Cloud Vision）を ADR-038 が supersede** したバックエンド。画像を Vertex Gemini
 * （asia-northeast1 固定運用）へ inline で渡し、抽出テキストを得る。Cloud Vision のリージョナル
 * エンドポイントは asia-northeast1 のデータレジデンシー保証が前提と異なる（ADR-024 M1 / NFR07 越境ゼロ）
 * 一方、Vertex は本プロジェクトの全 AI 経路と同一リージョンに閉じられるため、**データレジデンシーを優先**して
 * Gemini 直送を採る。代償（生 PII 画像を生成モデル文脈に渡す＝ADR-024 代替B が嫌った点）は配線側の
 * 三段ガード（**オプトイン**＝教員が画像を明示アップロード / **監査**＝画像ハッシュ + ocrUsed + 文字数 /
 * **下流マスキング**＝抽出テキストは structure/draft 経路で必ず PII マスク）で縛る（ADR-038 緩和策）。
 *
 * `model/vertex.ts`（実 Vertex アダプタ）と同様、credential を要する**外部委託の境界**ゆえ単体テストは
 * `ai` `generateText` を mock して GCP 無しで配線を検証する（実呼び出しは CI に持ち込まない、ADR-012）。
 * 認証は Workload Identity / ADC（JSON キーファイル禁止・CLAUDE.md ルール5）。
 *
 * 返す `text` は **PII 未マスク**（画像中の生徒氏名・手書き等を含みうる、types.ts の契約）。逆変換不要。
 */

/** {@link createGeminiOcrClient} の設定。 */
export interface GeminiOcrConfig {
  /** GCP プロジェクト ID。 */
  project: string;
  /** リージョン。OCR も asia-northeast1 固定運用（NFR07 データ越境ゼロ）。 */
  location: string;
  /** バージョンピンしたモデル ID。既定は {@link DEFAULT_MODEL_ID}（他経路と揃える）。 */
  modelId?: string;
}

/** 既定モデル。F03/F06/F08 と揃える（ADR-017 / #289 ④: Flash tier）。 */
const DEFAULT_MODEL_ID = "gemini-2.5-flash";

/** mediaType ヒント未指定時の既定（受理 allowlist は png/jpeg のみ＝既定 png で十分安全）。 */
const DEFAULT_MEDIA_TYPE = "image/png";

/**
 * OCR 専用の指示（抽出に限定し、要約・推論・補完をさせない）。生成モデルゆえ「読み取り＝転写」に
 * 絞ることで、画像に無い事実の創作を防ぐ（下流の構造化/マスキングはこの素テキストに対して働く）。
 */
const OCR_SYSTEM = [
  "あなたは画像から文字を書き起こす OCR エンジンです。",
  "画像に写っている文字を、レイアウトの行・段落の順序を保ちつつ、できるだけ忠実にテキストとして書き起こします。",
  "- 画像に無い情報を補完・要約・推測しない（読み取れない箇所は無理に埋めない）。",
  "- 表は行ごとに、セルをタブ区切りで書き起こす。",
  "- 説明文・前置き・コードフェンスは付けず、書き起こしたテキストだけを出力する。",
].join("\n");

const OCR_USER = "次の画像の文字を書き起こしてください。";

/**
 * Vertex Gemini マルチモーダルの OCR クライアントを生成する。本番は Cloud Run の Workload Identity で
 * 認証され、テストは `ai` `generateText` を mock して GCP 無しで配線を検証する（ADR-012）。
 */
export function createGeminiOcrClient(config: GeminiOcrConfig): OcrClient {
  const vertex = createVertex({ project: config.project, location: config.location });
  const modelId = config.modelId ?? DEFAULT_MODEL_ID;

  return {
    async recognize(bytes: Uint8Array, mediaType?: string): Promise<OcrResult> {
      const result = await generateText({
        model: vertex(modelId),
        system: OCR_SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: OCR_USER },
              // ImagePart（AI SDK v5）: image=バイト列 / mediaType=IANA メディアタイプ。
              { type: "image", image: bytes, mediaType: mediaType ?? DEFAULT_MEDIA_TYPE },
            ],
          },
        ],
      });
      // Gemini は文書単位の confidence を返さないため confidence は省略（Vision との差分）。
      return { text: result.text ?? "" };
    },
  };
}
