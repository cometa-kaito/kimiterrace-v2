# ADR-026: アカウント無効化 / ロール変更のエンフォース経路（Identity Platform を単一ソースとする）

- 状態: Accepted（2026-06-01）
- 日付: 2026-06-01
- 関連: [#324](https://github.com/cometa-kaito/kimiterrace-v2/issues/324)（is_active 未強制 / NFR03）, [#47 (F11)](https://github.com/cometa-kaito/kimiterrace-v2/issues/47), [#318](https://github.com/cometa-kaito/kimiterrace-v2/issues/318)（F11 member list）, [ADR-003 (Identity Platform)](003-identity-platform.md), [ADR-019 (RLS 2層テナント分離)](019-rls-two-layer-tenant-isolation.md), [CLAUDE.md ルール3/ルール5/セキュリティ最優先](../../CLAUDE.md)

## 文脈

F11（ロール管理: system_admin / school_admin / teacher）は教職員アカウントの **無効化** と **ロール変更** を提供する。#318（自校教職員一覧）は `users.is_active` を「稼働中 / 無効」として表示するが、**この状態は認証経路で一切強制されていない**（#324）。

### 現状の事実関係（grep で確認）

- 認証は **Identity Platform の custom claims** を単一の根拠にしている（ADR-003）。[`apps/web/lib/auth/session.ts`](../../apps/web/lib/auth/session.ts) の `normalizeClaims` は `role` / `school_id` / `uid` を claims から構成し、**DB の `users` 行も `is_active` も読まない**。
- [`verifySessionCookie`](../../apps/web/lib/auth/session.ts) は **`checkRevoked = true` を既定**で呼ぶ（`getAdminAuth().verifySessionCookie(cookie, true)`）。失効済み（revoked）トークンは毎リクエストで拒否され `null`（deny-by-default）に倒れる。
- ロール変更の根拠も claims。claims を再付与（`setCustomUserClaims`）しない限り、既存トークンは旧ロールのまま有効。
- [`signout/route.ts`](../../apps/web/app/api/auth/signout/route.ts) は「`revokeRefreshTokens` はアカウント無効化など強い失効が必要な操作で別途行う想定」と既に明記している（機構は認識済み・未配線）。
- 結果: `users.is_active=false` にしても、その人の session cookie が有効な限りログイン・操作を継続できる。UI の「無効」バッジはエンフォースの裏付けが無い（**security theater**）。

### 問題

「アカウント無効化」はセキュリティコントロール。DB フラグだけ立てて認証で弾かなければ、CLAUDE.md「便利だがリスク vs 不便だが安全 → 安全側」に反する。**F11 の無効化 / ロール変更 操作系スライスを実装する前提条件**として、エンフォース経路を先に確定する必要がある（本 ADR）。

### 適用範囲

本 ADR は **Identity Platform アカウントを持つ主体**（教職員 = school_admin / teacher、および system_admin）の無効化 / ロール変更が対象。**生徒のクラス magic-link 匿名アクセス（[ADR-016](016-class-magic-link-anonymous-access.md)）は対象外** — IdP アカウント / claims を持たず、失効は `magic_link` 行の `revoked_at` + 410 Gone で別系統に行う。

### ADR-003 との関係（方針の更新）

[ADR-003](003-identity-platform.md) の「悪い影響 / リスク」は当時、claims 反映遅延の暫定対策として「失効が即時に効くべき操作（アカウント無効化）は **DB 側 users 状態でも二重チェックする**」としていた。これは `revokeRefreshTokens` 配線が未確定だった前提の多層防御である。本 ADR は無効化 / ロール変更時の `revokeRefreshTokens` を必須化し（既定 `checkRevoked=true` が即時失効をエンフォース）、**エンフォースの主経路を claims/revoke に確定**する。よって ADR-003 の「DB 二重チェック」は**必須から任意の多層防御に格下げる**（本 ADR D4）。ADR-003 側にも本 ADR への参照注記を追記した。

## 決定

**Identity Platform（IdP）を認証エンフォースの単一ソースとする。DB の `users.is_active` / `users.role` は IdP 状態の mirror（表示・監査・整合チェック用の投影）であり、エンフォースの根拠にしない。**

claims がエンフォースの単一ソースである以上、状態変更は「DB を書く」だけでは不十分で、**必ず IdP 側の claims / トークン有効性を更新する**ことを操作の一部として強制する。

### D1: 無効化（deactivate）

無効化アクションは、同一トランザクション境界の責務として以下を**すべて**行う:

1. **IdP ユーザーを disable**（`getAdminAuth().updateUser(uid, { disabled: true })`）。以後の **新規トークン発行 / リフレッシュを停止**（再ログイン不可）。
2. **リフレッシュトークンを失効**（`getAdminAuth().revokeRefreshTokens(uid)`）。**既存 session cookie を次リクエストで無効化**。既定の `checkRevoked = true` が失効時刻以降のトークンを拒否するため、追加のコード変更なしでエンフォースが効く。
3. **DB `users.is_active = false`** を mirror として記録（監査カラム + `audit_log` に who/what/when、ルール1）。

> `checkRevoked = true` が「disabled ユーザー」を直接弾くかは firebase-admin のバージョン挙動に依存させない。`revokeRefreshTokens`（2）が**失効を確定的に保証**し、`disabled`（1）が再ログインを塞ぐ二層で担保する。

再有効化（reactivate）は逆操作（`updateUser(uid,{disabled:false})` + `is_active=true`、トークンは利用者が再ログインで取得）。

### D2: ロール変更（role change）

> **実装撤回（2026-06-18）**: 本 D2 を実装していた IdP seam `changeIdpUserRole`（`apps/web/lib/auth/admin-mutations.ts`）は撤去した。D2 が想定する教職員ロール変更（school_admin ↔ teacher）は **教員アカウント概念の撤去（2026-06-10、ADR-032・系統A = 学校共通PW）** で唯一の呼出側 action が消滅し、本番呼出元ゼロのまま「任意 role（system_admin 含む）/ 任意 school を claim に書ける」呼出側ガード前提の権限昇格プリミティブとして残存していたため（呼出側が存在しない以上、docstring の安全保証が空虚化）。**決定そのもの（IdP を単一ソースとし claims 再付与 + revoke でエンフォースする原則）は有効**で、再導入時は以下の設計から再生する。エンフォースの主経路である D1（無効化 / 再有効化）は引き続き稼働中。

1. **claims を再付与**（`setCustomUserClaims(uid, { role, school_id })`）。claims がロールの単一ソース。
2. **リフレッシュトークンを失効**（`revokeRefreshTokens(uid)`）。**revoke 後の既存 session は新ロールへ自動更新されるのではなく、`checkRevoked` で deny に倒れ「再ログイン強制」になる**（昇格も降格も一旦失効 → 再認証で新 claim を取得）。とりわけ **降格**（例: school_admin → teacher）では、revoke しないと旧特権 claim が cookie 有効期間（最大 14 日）残存して危険なため、降格こそ revoke が必須。
3. **DB `users.role`** を mirror として更新（監査）。

### D3: 「DB-only mutation を無効化 / ロール変更と称さない」

`is_active` / `role` の DB 行だけを書き換える操作を「無効化」「ロール変更」と UI / API で称してはならない。エンフォース（D1/D2 の IdP 更新）と一体でないミューテーションは security theater であり禁止（#324 受け入れ条件）。

### D4: DB 参照によるエンフォースは主経路にしない（却下、後述）

毎リクエストで `users.is_active` を DB 参照して deny する案（#324 選択肢2）は**主経路にしない**。理由は「却下した代替案」を参照。多層防御として将来 `withSession` に軽量整合チェックを足す余地は残すが、本 ADR では必須にしない。

## 結果 / トレードオフ

### 良くなる点

- **エンフォースが実在の機構に乗る**: 既定で有効な `checkRevoked = true` + `revokeRefreshTokens` で、追加の往復設計なしに「無効化即時失効」が成立する。
- **単一ソースの一貫性**: claims がエンフォース、DB が mirror という役割が明確になり、claims/DB のズレ（選択肢2 の弱点）が原理的に発生しない。
- **ルール3 整合**: ロールの真実は claims（既存 `normalizeClaims` の値域検証経路）に集約され、DB と二重管理しない。

### コスト / 留意

- `checkRevoked = true` は検証ごとに IdP への往復が増える（既に既定で有効 = 現状コスト据え置き）。負荷が問題化したら短期キャッシュを別途検討（#139 L1 の revoke 往復計測と論点共有）。本 ADR はコスト最適化を含めない。
- 無効化 / ロール変更が **IdP と DB の 2 系へ書く**ため部分失敗の整合が要る。IdP 更新を先に行い、成功後に DB mirror を書く順序とし、DB 失敗時は監査ログに不整合を残してリトライ可能にする（実装スライスで詳細化）。エンフォース観点では「IdP が真実」なので、DB mirror 遅延があっても**安全側（弾く側）に倒れる**。
- 無効化の反映は「次リクエスト」粒度（cookie 検証時）。即時のセッション切断（WebSocket 等）は対象外（現状 SSE/ポーリングのみ）。

## 実装ノート（F11 操作系スライスの受け入れ）

- [ ] `lib/auth` に IdP ミューテーション seam（`deactivateUser` / `reactivateUser` / `changeUserRole`）を追加。`getAdminAuth()` の `updateUser` / `revokeRefreshTokens` / `setCustomUserClaims` を束ね、DB mirror と `audit_log` を一体で書く。<br>※ `changeUserRole`（実体 `changeIdpUserRole`）は **2026-06-18 に撤回**（§D2 の撤回注記参照）。D1（`deactivateIdpUser` / `reactivateIdpUser`）は稼働中。
- [ ] F11 無効化 / ロール変更 Server Action はこの seam 経由のみ（DB-only 経路を作らない、D3）。
- [ ] **self-deactivation / last-admin ガード**: 自分自身の無効化、および「最後の有効な system_admin / school_admin」の無効化・降格を拒否する（ロックアウト防止）。
- [ ] テスト: 無効化後・ロール変更（降格含む）後に、既存 session cookie が `verifySessionCookie` で `null`（deny / 再ログイン強制）になる（emulator で `revokeRefreshTokens` → 再検証）。
- [ ] `verifySessionCookie` の `checkRevoked` を**無効化しない**ことをコメント/テストで pin（誤って `false` 化すると D1 のエンフォースが消える）。

## 既知の限界 / フォローアップ（#355）

PR #336 / #349 / #363（D1/D2 実装）の Reviewer が指摘した、本エンフォース設計に内在する限界を記録する。いずれも Low（非ブロッカー）だが、ADR を決定記録として完全化するため明示する。

### L1: 監査 actor 同定（NFR04）

`system_admin` は `users` 行ではない（`system_admins` テーブル、`audit_log.actor_user_id` の FK は `users(id)`）。そのため **system_admin による無効化 / ロール変更操作は `audit_log.actor_user_id = NULL`** で記録される（広告主操作と同規律）。「誰が操作したか」は IdP 監査ログ / アプリログ（Cloud Logging）に依存する。

- **現状の受容**: system_admin は高信頼の極小内部コホートであり、IdP/アプリログで actor を辿れるため Low。
- **将来の改善余地**: `audit_log` に system_admin 用の actor カラム（例 `actor_system_admin_id` → `system_admins(id)`）を追加するか、actor を `{type, id}` の多態で記録する。NFR04（監査完全性）の観点で、本番運用前に actor 同定経路をランブックに明文化すること。

### L2: last-admin ガードの TOCTOU レース

last-admin ガード（「対象校の有効な `school_admin` を count して ≤1 なら拒否」）は、**count（read tx）と無効化（IdP 往復 → write tx）が別トランザクション**であり、ADR-026 の IdP-first 順序ゆえ行ロックを跨げない。2 人の system_admin が同一校の最後の 2 名の school_admin を同時に無効化すると、両者とも count=2 を見て通過し、**学校が管理者ゼロになりうる**（D2 の**降格**でも同じロックアウトが起きる）。

- **重大度 Low の理由**: 高信頼コホート / サブ秒の同時手動操作が必要 / 再有効化にガードは無く同画面で**回復可能**。
- **推奨根治（実装は packages/db レーンへ）**: 「各校に有効な `school_admin` ≥1」を **DB レベルの不変条件**（トリガ or 制約関数の migration）で保証するのが本命。partial unique index では表現できない。代替は count と UPDATE を同一 tx + `SELECT … FOR UPDATE` で直列化するが、IdP-first 順序との両立設計が要る。**D2 降格に着手する前に方式を確定する**のが効率的（注: D2 ロール変更の実装 seam は 2026-06-18 に撤回済み・§D2 注記参照。本 L2 の降格レースは D2 を再導入する場合にのみ再燃する休眠論点。無効化側の last-admin レースは `setStaffActiveAction` の FOR UPDATE 再カウント + DB トリガ KT001 で根治済み）。

## 却下した代替案

- **選択肢2 単独（session/guard で毎回 DB 参照して deny）**: claims と DB の二重真実によるズレ管理が必要で、ロール変更は結局 claims 再付与が要る（claims を更新せず DB だけ見ると、RLS コンテキスト `SET LOCAL`（ADR-019）に流す role/school_id の出所が claims のままで矛盾する）。かつ毎リクエスト DB 往復を足すのに、`checkRevoked` が既に提供する失効エンフォースを上回る安全性が無い。多層防御の補助としては可だが主経路には非採用（D4）。
- **DB を単一ソースにして claims を廃止**: ADR-003（Identity Platform）の根本反転であり本 ADR の範囲外。RLS が claims 由来コンテキストに依存する現設計（ADR-019）とも整合しない。
