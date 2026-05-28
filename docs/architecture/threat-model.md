# 脅威モデル (STRIDE)

> kimiterrace-v2 の脅威モデル。STRIDE フレームワーク（Spoofing / Tampering / Repudiation / Information Disclosure / Denial of Service / Elevation of Privilege）に従い、想定攻撃と対策を網羅する。

最終更新: 2026-05-28
担当: Claude Code (orchestrated)
ステータス: **Part A (Spoofing + Tampering) 初稿** — Part B/C は別 PR で追記

---

## 1. 対象範囲

このドキュメントは kimiterrace-v2（公立高校向けデジタルサイネージ + 校務補助 SaaS）の **アプリケーション層 + データ層 + 認証層** を対象とする。

### スコープ内

- Next.js Web アプリケーション（Cloud Run / asia-northeast1）
- PostgreSQL データベース（Cloud SQL + pgvector）
- 認証基盤（Identity Platform）
- magic_link を介した匿名アクセス経路（クラスごとの限定公開）
- Vertex AI / Gemini への送信経路（PII マスキング含む）
- Cloud Run Jobs（バッチ）
- サイネージ端末 firmware からの API 呼出し

### スコープ外（別ドキュメントで扱う）

- 物理サイネージ端末のハードウェア改竄（→ ハードウェア運用 runbook）
- 県教委 Wi-Fi のネットワーク層攻撃（→ ネットワーク疎通設計）
- 校内 LAN の侵入（→ 学校側責任）
- Google Cloud Platform 基盤自体の侵害（→ Google 責任共有モデル）

---

## 2. 前提（脅威評価の基準）

| 前提 | 内容 |
|---|---|
| 攻撃者像 A | 公立校生徒（内部、認証済み、興味本位） |
| 攻撃者像 B | 校外者（インターネット越し、未認証） |
| 攻撃者像 C | 元教員・退職者（過去に認証情報を持っていた） |
| 攻撃者像 D | 内部不正者（運用権限のある教員・委託先） |
| 攻撃者像 E | 標的型攻撃者（県教委・特定校を狙う） |
| データ機密性 | 生徒氏名・出欠・成績傾向は **個人情報保護法 + 文科省 GL** 対象 |
| 影響度の閾値 | 1 校 100 名以上の PII 漏洩 = Critical（サービス停止判断） |
| 法定保存期間 | 学籍関連: 5 年、健康診断: 5 年、出席簿: 20 年（学校教育法施行規則） |

---

## 3. 影響度の定義

| 区分 | 定義 | 例 |
|---|---|---|
| **Critical** | サービス停止・公表対応・監督官庁報告が必要 | 全校 PII 漏洩、データ消失、サービス全停止 |
| **High** | 単校レベルの被害、72h 以内に対応 | 1 校 PII 漏洩、認証バイパス成功 |
| **Medium** | 機能制限・限定的影響、1 週間以内に対応 | 単一ユーザーアカウント乗っ取り |
| **Low** | 影響軽微、計画的対応で可 | 軽微な情報露出、UX 低下 |

---

## 4. STRIDE カテゴリ目次

| カテゴリ | 内容 | 本ドキュメントでの状態 |
|---|---|---|
| **S — Spoofing**（なりすまし） | 認証主体の偽装 | ✅ Part A（本書） |
| **T — Tampering**（改竄） | データ・コード・通信の改竄 | ✅ Part A（本書） |
| **R — Repudiation**（否認） | 操作の事後否認 | ⏳ Part B（別 PR） |
| **I — Information Disclosure**（情報漏洩） | 機密情報の意図せぬ露出 | ⏳ Part B（別 PR） |
| **D — Denial of Service**（DoS） | サービス停止・性能劣化攻撃 | ⏳ Part C（別 PR） |
| **E — Elevation of Privilege**（権限昇格） | 権限の不正取得 | ⏳ Part C（別 PR） |

各脅威の記載項目（全カテゴリ共通）:

1. **概要** — 何が起きるか
2. **攻撃シナリオ** — 具体的な攻撃手順
3. **影響度** — Critical / High / Medium / Low
4. **対策** — 実装済み or 実装予定。対応する機能要件 (F)・非機能要件 (NFR)・アーキテクチャ判断 (ADR) を明記
5. **検知方法** — ログ / アラート / テスト

---

## 5. Spoofing（なりすまし）

認証主体（ユーザー・サービス・テナント）を偽装する攻撃。Identity Platform + JWT + RLS の三層で防御するが、各層の単独突破は致命的。

### S-01: 認証バイパス（JWT 検証スキップ）

- **概要**: 攻撃者が JWT 署名検証を回避し、任意のユーザーになりすます。
- **攻撃シナリオ**:
  1. 攻撃者が API リクエストの `Authorization: Bearer <jwt>` を改竄、`alg: none` を指定する。
  2. もしくは、開発時のテスト用バイパスフラグ（`NEXT_PUBLIC_AUTH_BYPASS=true` など）が本番にも残っていた場合、認証チェックを通過。
  3. 認証済みコンテキストで `school_id` を任意指定 → 別校のデータを取得。
- **影響度**: **Critical**（全校 PII 漏洩の可能性）
- **対策**:
  - Identity Platform 公開鍵での JWT 署名検証を **すべての** Route Handler で実施（ミドルウェア化）。`alg: none` および対称鍵 `HS*` を拒否。
  - 認証バイパス用フラグは **コード中に存在させない**（`process.env.NODE_ENV === 'test'` 内のみで分岐可能、ビルド時に dead-code elimination）。
  - ミドルウェアは fail-closed（検証失敗時は 401 で停止、`next()` を呼ばない）。
  - 関連: NFR03（セキュリティ）、ADR-003（Identity Platform）、ADR-008（Route Handlers）
- **検知方法**:
  - `audit_log` に `auth.verify.fail` を必ず記録、5 分間で同一 IP から 10 件以上で Cloud Monitoring アラート。
  - 単体テスト: 改竄 JWT・期限切れ JWT・`alg: none` を **必ず拒否** することを `__tests__/auth/jwt.test.ts` で検証（落ちている状態で merge 不可）。
  - 統合テスト: Route Handler 全エンドポイントに対して「未認証アクセスは 401」を一括で確認するスナップショットテスト。

### S-02: magic_link トークン予測（暗号論的乱数の不足）

- **概要**: クラス公開用 magic_link の URL トークンが推測可能で、第三者が一覧攻撃で他クラスのリンクを取得する。
- **攻撃シナリオ**:
  1. 攻撃者が自分の所属クラスの magic_link `https://kimiterrace.example/c/AB12CD34` を取得。
  2. トークンが連番・タイムスタンプ・短いランダム文字列だった場合、隣接トークンを総当りで探索。
  3. 別校・別クラスの公開ページ（時間割・連絡）を窃取。
- **影響度**: **High**（クラス単位の限定情報漏洩、複数クラスに横展開可能）
- **対策**:
  - magic_link トークンは **128 bit 以上の `crypto.randomBytes` 由来**（URL-safe base64 で 22 文字以上）。`Math.random` 禁止。
  - トークンは DB 上で **bcrypt / argon2 ハッシュ済み** で保存。原文は発行時のみ提示し、再表示不可。
  - 一覧攻撃対策: 同一 IP から 1 分間に 30 件以上の `/c/:token` 404 でレート制限 + 一時 BAN。
  - 失効期間設定（学期単位・卒業時失効）と再発行 API。
  - 関連: F05（クラス magic_link）、ADR-016（class-magic-link-anonymous-access）、NFR03
- **検知方法**:
  - `audit_log.magic_link.lookup.404` を集計、IP 別に異常検知。
  - 統合テスト: トークン 1,000 件発行 → 任意 2 件のハミング距離測定で偏りがないことを確認（疑似乱数を間違えて使った場合の検知）。
  - 監査: 半年に 1 度、エントロピー測定スクリプトを実行（CI でレポート）。

### S-03: magic_link 漏洩からの校外者アクセス

- **概要**: magic_link URL が SNS / スクショ / メール転送で校外に漏れ、保護者以外の第三者が継続アクセスする。
- **攻撃シナリオ**:
  1. 生徒が Twitter / Discord にクラス連絡ページのスクショを投稿、URL が映り込む。
  2. 第三者が URL を踏み、無認証で時間割・行事予定を閲覧。
  3. 学校外で特定生徒の動線（部活動・下校時刻）を把握。
- **影響度**: **High**（個人の安全に直結する情報の露出）
- **対策**:
  - magic_link は **公開情報のみ** をスコープに表示（個別生徒の氏名・出欠は表示しない）。スコープは F05 で定義。
  - 端末バインド: 初回アクセス時にデバイス fingerprint を Cookie に保存、別端末からの同 URL アクセスは追加検証ステップを要求。
  - 学期末自動失効 + 教員ダッシュボードからの即時失効。
  - URL に school 名・クラス名を含めない（推測補助情報を渡さない）。
  - 関連: F05、ADR-016、ADR-015（instant-publish-with-safety-nets）、NFR03
- **検知方法**:
  - referrer 監視: `t.co` / `discord.com` 等 SNS ドメインからの流入を `audit_log` に記録、教員ダッシュボードに警告表示。
  - 異常アクセス数アラート: クラス全生徒数 × 3 倍を超える uniq IP / 日で Slack 通知。
  - 失効後アクセス 410 Gone を必ず返し、再発行誘導。

### S-04: system_admin custom claims 偽造

- **概要**: Identity Platform の custom claims (`role: system_admin`) を偽造し、テナント横断の管理操作を実行する。
- **攻撃シナリオ**:
  1. 攻撃者が一般教員アカウントの ID トークンを取得。
  2. クライアント側でトークンを decode、payload に `role: system_admin` を挿入して再エンコード（署名なし）。
  3. サーバが署名検証を省略している経路があれば、admin API を実行 → 全校 PII エクスポート。
- **影響度**: **Critical**（全テナント横断の漏洩）
- **対策**:
  - custom claims は **Identity Platform 側でしか付与できない**設計を徹底。クライアントから受け取ったロール情報は一切信用しない。
  - サーバ側で claims を読む際は **必ず公開鍵検証を経た decoded token** から読む。生 JWT の payload を base64 decode するだけのパスを作らない。
  - `system_admin` 操作は別エンドポイント (`/api/admin/*`) に隔離、ミドルウェアで `role === 'system_admin'` + IP allowlist + MFA 必須の三重チェック。
  - role 付与・剥奪は **Terraform で管理する固定リスト**から外れた場合、CI が落ちる。
  - 関連: NFR03、ADR-003（Identity Platform）、ADR-009（Terraform）
- **検知方法**:
  - `audit_log` に `admin.*` 操作を全件記録、Critical 通知（Slack + メール + PagerDuty）。
  - 日次バッチで Identity Platform 上の `system_admin` 数を Terraform 期待値と照合、差分 0 を assert。
  - RLS テストの一部として「偽 claims では admin テーブル read 拒否」を確認。

---

## 6. Tampering（改竄）

データ・コード・通信路の改竄。RLS + 監査ログ + マイグレーション制御の三層で防御。

### T-01: DB 直接書換（migrator ロール権限の悪用）

- **概要**: マイグレーション用の昇格ロール（`BYPASSRLS` を持つ）が運用時に乱用され、テナント分離をバイパスして直接 DB を書換える。
- **攻撃シナリオ**:
  1. 内部運用者が migrator ロールで psql 接続。
  2. RLS をバイパスしてある学校の出欠を上書き、もしくは別校に転記。
  3. アプリ経路を通らないため audit_log が残らない。
- **影響度**: **Critical**（データ整合性の破壊、追跡不可）
- **対策**:
  - migrator ロールは **マイグレーション CI ジョブ専用**。人間の psql アクセスには付与しない。
  - 運用クエリ用ロールは `BYPASSRLS` を持たず、必ず `SET app.current_school_id` を要求する。
  - migrator ロール認証情報は Secret Manager 管理 + Cloud Build の Workload Identity 経由でのみ取得。ローカルからの login 不可。
  - すべての DDL/DML はマイグレーションファイル経由（`packages/db/migrations/*`）。手 SQL 禁止を CODEOWNERS で強制。
  - 関連: ルール 2（RLS）、ルール 3（Drizzle 単一ソース）、ADR-001、ADR-004、ADR-019（RLS 二層）
- **検知方法**:
  - pgaudit 拡張で **すべての DDL + BYPASSRLS セッション** を Cloud Logging に流す。
  - 日次: `pg_stat_activity` の昇格ロール接続元を集計、CI 以外の IP を発見したら Critical アラート。
  - PR レビューで `packages/db/migrations/` 以外の SQL 文字列を grep して警告（CI step）。

### T-02: リプレイ攻撃（イベントログの再送）

- **概要**: 出欠登録・連絡投稿など状態を変える POST リクエストを攻撃者が傍受 / 再送し、二重計上・古い状態への巻き戻しを起こす。
- **攻撃シナリオ**:
  1. 攻撃者が校内 LAN のキャプチャ機材で HTTPS 終端前の WebSocket または同一端末の Cookie 共有を悪用。
  2. 出欠登録 POST `{student_id, status: '欠席'}` をキャプチャ、後日再送 → 正常な状態を上書き。
  3. 連絡削除 API を再送して既に復旧した投稿を再度削除。
- **影響度**: **High**（出欠データの信頼性が損なわれる、保護者対応で発覚）
- **対策**:
  - 状態変更 API は **冪等キー** (`Idempotency-Key` ヘッダ) を必須化、24h 重複検知。Drizzle スキーマに `idempotency_keys` テーブルを追加。
  - すべての書込みは **楽観ロック**（`updated_at` を WHERE 条件、または `version` カラム）を伴う。古い `updated_at` で送られた更新は 409 で拒否。
  - イベント駆動部分（Cloud Run Jobs / Pub/Sub）は **メッセージ ID** で de-dup。
  - HTTPS strict + HSTS preload、校内 LAN 信用しない設計。
  - 関連: NFR03、NFR04（監査ログ）、ADR-008（Route Handlers）、ルール 1（監査カラム）
- **検知方法**:
  - `audit_log` に同一 `idempotency_key` で 2 件目以降の試行があれば WARN ログ。
  - 統合テスト: 同一リクエストを 2 回送って 2 回目が 409 / 200 (no-op) を返すことを `__tests__/idempotency/` で確認。
  - 監視: 出欠登録 API の `updated_at conflict` 率が 1% を超えたら調査トリガー。

### T-03: `SET LOCAL` 漏れによる別テナント書込み

- **概要**: アプリ層で接続プール経由のセッションに `SET LOCAL app.current_school_id` を設定し忘れ、前回の接続コンテキスト（別校）のまま書込みを実行する。
- **攻撃シナリオ**:
  1. PgBouncer / Cloud SQL 接続プールでセッションが再利用される。
  2. リクエスト A 処理時に `SET LOCAL app.current_school_id = 'school-X'` を実行。
  3. リクエスト B 処理時、開発者が `SET LOCAL` を呼び忘れた経路（バッチ・Server Action のサブパス）で書込み実行 → school-X のコンテキストで school-Y のデータを上書き。
  4. RLS は USING のみで WITH CHECK が抜けていた場合、書込み側の制約が漏れる。
- **影響度**: **Critical**（テナント分離の根幹を破壊、サイレント漏洩）
- **対策**:
  - DB アクセスは **全件 `withTenantContext(schoolId, fn)` ラッパ経由**を強制。生 `db.execute` を直接呼ぶことを Biome ルールで禁止。
  - RLS ポリシーは **USING + WITH CHECK の両方** を定義（read / write 両方を school_id で縛る）。
  - 接続取得時に **必ず `RESET ALL` を実行**してから `SET LOCAL` する pattern（接続プール再利用での残留防止）。
  - 二層 RLS（school_id + parent_org_id）で取りこぼしを冗長化。
  - 関連: ルール 2、ルール 3、ADR-019（RLS 二層テナント分離）、NFR03
- **検知方法**:
  - **RLS テスト必須**: 全テナント分離テーブルに対し `__tests__/rls/` で「他校書込み拒否」「他校 read 拒否」「context 未設定で書込み拒否」の 3 ケースを必ず追加。
  - 統合テスト: 並列リクエスト（school A の POST と school B の POST）を 100 回回して交差汚染がないことを確認。
  - 監視: `audit_log` の `created_by.school_id != record.school_id` を日次バッチで検出、0 件以外は Critical。

### T-04: 公開コンテンツ（サイネージ表示）の不正書換

- **概要**: 校内サイネージに表示される連絡・行事予定の API レスポンスもしくは表示前データを改竄し、虚偽情報を全校に表示させる。
- **攻撃シナリオ**:
  1. 攻撃者がサイネージ端末の Wi-Fi を盗聴、もしくは校内 DNS を改竄。
  2. 端末が取得する JSON に「臨時休校」「避難指示」など虚偽の連絡を挿入。
  3. もしくは、教員アカウント乗っ取り後、正規経路で虚偽連絡を投稿。
- **影響度**: **High**（パニック誘発・授業妨害・社会的影響）
- **対策**:
  - サイネージ端末 ↔ API は **mTLS** で相互認証。端末証明書は Workload Identity 連携で発行。
  - レスポンスペイロードに **server-side 署名** を付与（HMAC-SHA256 + ローテーション可能なシークレット）、端末側で検証してから表示。
  - 連絡投稿は **二段階確認**（投稿者と別アカウントの承認）を緊急種別に対して義務化。緊急種別の閾値・要件は F05 / F06 で別途定義。
  - 投稿には **取り消し API** と 5 分間の編集猶予、5 分以内であれば即時取り下げ。
  - 関連: F05, F06（投稿要件 — 今後ドラフト）、ADR-015（instant-publish-with-safety-nets）、NFR03
- **検知方法**:
  - 端末側署名検証失敗を `device_logs` に送信、5 分間で 5 端末以上の検証失敗が出たら Critical アラート（DNS 攻撃疑い）。
  - 緊急連絡投稿は audit_log に投稿者 + 承認者 + IP + timestamp を必ず記録。
  - 日次レビュー: 「緊急」タグの連絡を全件人間レビュー対象として教員ダッシュボードに表示。

---

## 7. Repudiation（否認） — Part B（別 PR）

このセクションは Part B で追記する。スコープ予約のみ。

- R-01: 教員による出欠改竄の事後否認（予定）
- R-02: 生徒による不適切投稿の否認（予定）
- R-03: 管理者操作ログの欠落（予定）
- R-04: 委託先運用者の操作否認（予定）

---

## 8. Information Disclosure（情報漏洩） — Part B（別 PR）

このセクションは Part B で追記する。スコープ予約のみ。

- I-01: Vertex AI へのプロンプト経由の PII 漏洩（予定）
- I-02: エラーレスポンスの情報露出（予定）
- I-03: ログへの PII 混入（予定）
- I-04: バックアップからの漏洩（予定）

---

## 9. Denial of Service（DoS） — Part C（別 PR）

このセクションは Part C で追記する。スコープ予約のみ。

- D-01: API レート超過（予定）
- D-02: Vertex AI コスト爆発攻撃（予定）
- D-03: DB クエリ過負荷（予定）
- D-04: ファイルアップロード容量攻撃（予定）

---

## 10. Elevation of Privilege（権限昇格） — Part C（別 PR）

このセクションは Part C で追記する。スコープ予約のみ。

- E-01: 教員 → system_admin 昇格（予定）
- E-02: SECURITY DEFINER 関数経由の RLS バイパス（予定）
- E-03: サービスアカウント鍵悪用（予定）
- E-04: 委託先からの権限昇格（予定）

---

## 11. レビューサイクル

- **四半期に 1 度** このドキュメント全体を読み直し、実装変更との整合をとる。
- 新しい機能を追加するときは、その PR で関連する脅威項目を更新する（PR テンプレートにチェック項目あり）。
- 重大なインシデント発生時は **24h 以内** に該当項目を改訂し、対策の実装計画を ADR に記録する。

---

## 12. 関連ドキュメント

- 機能要件: [docs/requirements/functional/](../requirements/functional/)（F01-F07、特に F05 magic_link）
- 非機能要件: [docs/requirements/non-functional/](../requirements/non-functional/)（NFR03 セキュリティ、NFR04 監査ログ）
- 全体 MVP 要件: [docs/requirements/v2-mvp.md](../requirements/v2-mvp.md)
- ADR-003: [Identity Platform](../adr/003-identity-platform.md)
- ADR-008: [Next.js Route Handlers](../adr/008-nextjs-route-handlers.md)
- ADR-015: [instant-publish-with-safety-nets](../adr/015-instant-publish-with-safety-nets.md)
- ADR-016: [class-magic-link-anonymous-access](../adr/016-class-magic-link-anonymous-access.md)
- ADR-019: [rls-two-layer-tenant-isolation](../adr/019-rls-two-layer-tenant-isolation.md)
- CLAUDE.md ルール 1（監査）/ ルール 2（RLS）/ ルール 4（PII マスキング）/ ルール 5（Secret Manager）

> **注記**: 上記のうち F05, NFR03, NFR04, ADR-015/016/019, v2-mvp.md は本 PR 時点では未存在 or ドラフト中。リンクは将来パスを予約する形で記載しており、各文書の初稿提出時に整合性を再確認する。
