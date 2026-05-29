export type HealthPayload = {
  status: "ok";
  commit: string;
};

/**
 * health エンドポイントのレスポンス body を構築する純粋関数。
 * Route Handler から I/O 切り離してテスト可能にするため別ファイルに分けている。
 */
export function buildHealthPayload(commit: string | undefined): HealthPayload {
  return {
    status: "ok",
    commit: commit ?? "dev",
  };
}
