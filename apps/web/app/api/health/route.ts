import { NextResponse } from "next/server";
import { buildHealthPayload } from "./payload";

/**
 * GET /api/health
 *
 * Cloud Run / 監視からの疎通確認用。DB アクセスや外部 I/O はしない（liveness 用途）。
 * Readiness（DB 接続確認等）は別エンドポイントで提供する予定（別 Issue）。
 */
export function GET() {
  return NextResponse.json(buildHealthPayload(process.env.GIT_COMMIT));
}
