# ADR-003: Identity Platform を採用、Firebase Auth は移行

- 状態: Proposed
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [#48-B (#113)](https://github.com/cometa-kaito/kimiterrace-v2/issues/113), [F11 ロール管理](../requirements/functional/F11-role-management.md), [NFR03 セキュリティ](../requirements/non-functional/NFR03-security.md), [NFR04 監査ログ](../requirements/non-functional/NFR04-audit-log.md), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [ADR-016 (magic link)](016-class-magic-link-anonymous-access.md), [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [CLAUDE.md スタック表](../../CLAUDE.md)

## 文脈

V1（旧キミテラス）は **Firebase Auth（UI + Web SDK）** で教員ログインを実装していた。V2 は GCP ネイティブ構成への全改修（[ADR-001](001-postgres-vs-firestore.md) で Firestore→Cloud SQL）であり、認証基盤も改めて選定する必要がある。

要件は:

- **教員系アカウント認証**: school_admin / teacher は ID/パスワード（+ MFA 強制、[NFR03](../requirements/non-functional/NFR03-security.md)）。system_admin（奥村さんのみ）も同基盤。
- **ロール + テナントの claim 保持**: ログインセッションから `role`（system_admin / school_admin / teacher）と `school_id` を取り出し、リクエストごとに PostgreSQL RLS コンテキスト（`SET LOCAL app.current_user_id / app.current_school_id / app.current_user_role`、[ADR-019](019-rls-two-layer-tenant-isolation.md)）に流し込む必要がある。
- **custom claims の改竄防止**: ロール付与はフロントから直接書込み不可、特権ロール（Cloud Run のサービスアカウント）経由のみ（[F11 受け入れ条件](../requirements/functional/F11-role-management.md)）。
- **生徒は別経路**: 生徒は個別アカウントを持たず、クラス単位の magic link で匿名アクセス（[ADR-016](016-class-magic-link-anonymous-access.md)）。本 ADR の対象は教員系認証。
- **データ所在**: 公立校データの 10 年保管・ISMAP 要件のため、認証データも asia-northeast1 / GCP 内に閉じたい。

選択肢:

- **Identity Platform**（GCP マネージド、Firebase Auth の上位互換 GCP 製品）
- Firebase Auth 継続
- 自前認証（Auth.js / Lucia 等 + Cloud SQL に users 自前管理）
- 外部 IDaaS（Auth0 / Clerk / Supabase Auth）

## 決定

**Google Cloud Identity Platform を採用**し、Firebase Auth から移行する。

- **session 検証経路**: ログイン後に発行される ID トークンを **session cookie** として保持し、Next.js の **middleware / Server Component で Admin SDK を用いて検証**する。検証結果の custom claims（`role` / `school_id`）を取り出し、DB トランザクション冒頭で `SET LOCAL` して RLS コンテキストを確立する（[ADR-019](019-rls-two-layer-tenant-isolation.md)）。
- **custom claims 更新**: ロール付与・テナント割当は Cloud Run の特権サービスアカウント（Workload Identity、[ADR-005](005-vertex-ai.md) 系の SA 運用と同様、JSON キー禁止 = [CLAUDE.md ルール5](../../CLAUDE.md)）経由でのみ実行。フロント / クライアント SDK から claims を書き換える経路は持たない。
- **MFA**: teacher 以上は MFA を強制（[NFR03](../requirements/non-functional/NFR03-security.md)）。Identity Platform の MFA（SMS / TOTP）を利用。
- **将来拡張**: 県教委・自治体 SSO が必要になった場合、Identity Platform の **SAML / OIDC プロバイダ連携**で対応可能（現フェーズでは ID/パスワード + MFA のみ、[[closed-system-security]] に沿い外部連携は後送り）。
- **Terraform 管理**: テナント・プロバイダ設定は `infrastructure/terraform/modules/identity_platform/` で管理（[ADR-009](009-terraform.md)、既に PR #84 で module 実在）。

migration（Firebase Auth → Identity Platform）は、Identity Platform が Firebase Auth と**同一のユーザーストア・API 互換**であるため、プロジェクト設定の有効化と claims 移送で完結する（ユーザー再登録不要）。

## 検討した代替案

### 代替 A: Firebase Auth 継続
- 却下理由: [ADR-001](001-postgres-vs-firestore.md) で確定した「GCP ネイティブへの全改修」方針と不整合。Firebase Auth は Firebase コンソール側の管理面が強く、Workload Identity / GCP IAM との統合・監査が Identity Platform より弱い。
- 副次理由: SAML/OIDC（将来の自治体 SSO）・マルチテナント機能が Identity Platform 側にしかない。
- 補足: 移行コストはほぼゼロ（同一ストア）なので「継続する積極的理由」が立たない。

### 代替 B: 自前認証（Auth.js / Lucia + Cloud SQL の users 自前管理）
- 却下理由: MFA・パスワードリセット・ブルートフォース対策・トークン失効・SAML を**自前で実装し続ける運用責任**が発生。公立校データを扱う本システムでセキュリティを自己責任にするのはリスクが高すぎる（[セキュリティ最優先の心構え](../../CLAUDE.md)）。
- 副次理由: 認証情報（パスワードハッシュ等）を自 DB に持つと、漏洩時の影響範囲が認証基盤にまで拡大する。マネージドに委譲してアプリ DB を「認証 secret を持たない」状態に保つ方が安全。

### 代替 C: 外部 IDaaS（Auth0 / Clerk / Supabase Auth）
- 却下理由: 認証データが GCP / asia-northeast1 の外に出る。ISMAP・データ所在要件、[ルール4](../../CLAUDE.md)（外部委託の最小化思想）と整合しない。
- 副次理由: 従量課金のコスト膨張（学校無料モデルで MAU が読みにくい）+ ベンダーロックイン。

## 結果（Consequences）

### 良い影響
- GCP IAM / Workload Identity / Cloud Logging と統合され、認証イベントの監査が一元化（[NFR04](../requirements/non-functional/NFR04-audit-log.md)）。
- custom claims に `role` + `school_id` を載せることで、RLS コンテキスト（[ADR-019](019-rls-two-layer-tenant-isolation.md)）を session から決定的に復元できる。
- Firebase Auth と同一ストアのため V1 ユーザーを再登録なしで移行可能。
- MFA / SAML / OIDC がマネージドで提供され、自治体 SSO 等の将来要件に拡張余地。
- 認証 secret をアプリ DB に持たないため、Cloud SQL 漏洩時に認証情報まで巻き込まれない。

### 悪い影響 / リスク
- **custom claims のサイズ制限（約 1000 bytes）**: `role` + `school_id` 程度なら余裕だが、claims を肥大化させない設計規律が必要（権限の詳細は DB 側で解決）。
- **claims 反映の遅延**: ロール変更後、ID トークンの再発行（再認証 or トークンリフレッシュ）まで旧 claims が残る → 失効が即時に効くべき操作（アカウント無効化）は DB 側 users 状態でも二重チェックする。
- **session cookie 検証のコスト**: 毎リクエストの Admin SDK 検証はキャッシュ可能だが、middleware の実装次第でレイテンシに影響 → 公開鍵キャッシュ + 短期 session 検証を [#48-B](https://github.com/cometa-kaito/kimiterrace-v2/issues/113) で設計。
- **Identity Platform の設定複雑性**: Firebase Auth よりコンソール / Terraform 設定項目が多い → Terraform 化（[ADR-009](009-terraform.md)）で再現性を担保。

### トレードオフ
- 「マネージド委譲の安全性 vs 自前実装の柔軟性」のうち **マネージド委譲の安全性**に振った（公立校データのセキュリティ最優先）。
- 「GCP ロックイン vs マルチクラウド可搬性」のうち、[ADR-001](001-postgres-vs-firestore.md) と同じく **GCP 統合**に振った（PostgreSQL + Identity Platform は標準仕様寄りで、最悪の移行経路は残る）。
- 生徒の匿名アクセスは本基盤に載せず magic link（[ADR-016](016-class-magic-link-anonymous-access.md)）に分離 — 認証基盤を「教員系のみ」に保ち、攻撃面を最小化。
