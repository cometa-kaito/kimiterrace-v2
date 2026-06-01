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

1. **claims を再付与**（`setCustomUserClaims(uid, { role, school_id })`）。claims がロールの単一ソース。
2. **リフレッシュトークンを失効**（`revokeRefreshTokens(uid)`）。旧ロール claim を載せた既存 session を無効化し、利用者の再ログインで新ロール claim を反映させる。失効しないと旧ロールが cookie 有効期間（最大 14 日）残存する。
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

- [ ] `lib/auth` に IdP ミューテーション seam（`deactivateUser` / `reactivateUser` / `changeUserRole`）を追加。`getAdminAuth()` の `updateUser` / `revokeRefreshTokens` / `setCustomUserClaims` を束ね、DB mirror と `audit_log` を一体で書く。
- [ ] F11 無効化 / ロール変更 Server Action はこの seam 経由のみ（DB-only 経路を作らない、D3）。
- [ ] テスト: 無効化後に既存 session cookie が `verifySessionCookie` で `null` になる（emulator で `revokeRefreshTokens` → 再検証）。ロール変更後に旧 claim session が新ロールへ更新される（再ログイン経路）。
- [ ] `verifySessionCookie` の `checkRevoked` を**無効化しない**ことをコメント/テストで pin（誤って `false` 化すると D1 のエンフォースが消える）。

## 却下した代替案

- **選択肢2 単独（session/guard で毎回 DB 参照して deny）**: claims と DB の二重真実によるズレ管理が必要で、ロール変更は結局 claims 再付与が要る（claims を更新せず DB だけ見ると、RLS コンテキスト `SET LOCAL`（ADR-019）に流す role/school_id の出所が claims のままで矛盾する）。かつ毎リクエスト DB 往復を足すのに、`checkRevoked` が既に提供する失効エンフォースを上回る安全性が無い。多層防御の補助としては可だが主経路には非採用（D4）。
- **DB を単一ソースにして claims を廃止**: ADR-003（Identity Platform）の根本反転であり本 ADR の範囲外。RLS が claims 由来コンテキストに依存する現設計（ADR-019）とも整合しない。
