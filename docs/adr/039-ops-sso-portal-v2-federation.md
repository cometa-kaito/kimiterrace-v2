# ADR-039: 運営アカウントの portal↔v2 単一ログイン（SSO）— 共通 IdP への federation

- 状態: **Accepted**（2026-06-14 ユーザー判断「②で確定」。認証スタック判断としてユーザー承認済 = CLAUDE.md「ADR を覆す/スタック反転は要ユーザー確認」を充足。実装は §42.5 Phase 7・前フェーズ完了後）
- 日付: 2026-06-14
- 関連: [ADR-003 (Identity Platform)](003-identity-platform.md)、[ADR-026 (無効化/revoke エンフォース)](026-account-deactivation-role-change-enforcement.md)、[ADR-031 (MFA 段階強制)](031-mfa-phased-enforcement.md)、[ADR-032 (教員共通PW)](032-teacher-shared-password-login.md)、[ADR-018 (CRM 独自設計)](018-custom-crm-design.md)、設計起点 = `経路設計-実装設計書-2026-06-10.md` §42.4 / §42.5（Phase 7「SSO（最後）」）、[CLAUDE.md セキュリティ最優先](../../CLAUDE.md)

## 文脈

統合再設計（実装設計書 §42.5）は、運営（Rebounder 社内スタッフ）が **2 つのコンソールを別ログインで往復している**状態を最終フェーズで解消する計画を立てている。本 ADR はその Phase 7「SSO（最後）」の**方式を確定する**ためのもの。実装は本 ADR の承認後・前フェーズ（Flow A → namespace → 名寄せ → Outbox → Flow B → 効果還元）完了後に着手する。

### SSO の対象は「運営アカウントのみ」（スコープを最初に確定する）

| 利用者 | 使うコンソール | 認証基盤 | SSO 対象か |
|---|---|---|---|
| 広告主クライアント | portal（`kimiteras.rebounder.jp`）のみ | Supabase Auth（email/password） | ❌ 対象外 |
| 学校関係者（school_admin / teacher） | v2 のみ | Identity Platform（[ADR-003](003-identity-platform.md)） | ❌ 対象外 |
| 生徒 | v2（magic link 匿名） | 認証なし（[ADR-016](016-class-magic-link-anonymous-access.md)） | ❌ 対象外 |
| **運営（staff / admin / system_admin）** | **portal `/admin` + v2 `/ops` の両方** | **portal=Supabase Auth、v2=Identity Platform の二重** | ✅ **対象** |

→ **SSO が必要なのは少数の社内オペレータだけ**。広告主・教員・生徒の大規模なユーザー母集団は移行不要。この「狭いスコープ」が、後述するどの案でもコストとリスクを大幅に下げる前提になる。

### 現状（v2 コードベース実測）

- **認証スタックは 2 系統に分裂**:
  - portal = **Supabase Auth**（`auth.users` + `profiles(id=auth.users.id, role)`、RLS は `auth.uid()` 基点）。商流アカウントの SoR。
  - v2 = **Identity Platform**（[ADR-003](003-identity-platform.md)）。session cookie → Admin SDK 検証 → custom claims（`role`/`school_id`）→ RLS コンテキスト。localId = `users.id`（UUID）。
- **SSO / federation のコードは v2 に皆無**（`signInWithCustomToken`・SAML・OIDC provider・token 交換いずれも参照ゼロ。grep 実測で未着手を確認）。＝**白紙からの方式選定**。
- **境界ディープリンクは既に配線済（流用可）**:
  - v2 → portal: `PORTAL_ADMIN_URL`（既定 `https://kimiteras.rebounder.jp/admin`）を `app/_components/AppShell.tsx` と `app/ops/advertisers/page.tsx` で使用。「商流の正本は portal ↗」リンクが実在。
  - portal → v2: `V2_ADMIN_BASE_URL`（portal 側 env、portal の広告主→「v2 で配信を見る」導線）。
  - → **ディープリンク（画面遷移）は既に通っている。残課題は「遷移先で再ログインを求められる」点だけ**。SSO はこの一段を消す仕事であって、導線をゼロから作る仕事ではない。
- **サーバ間の信頼チャネルも前例あり（user SSO とは別物だが参考になる）**: Partner API は `PARTNER_API_SECRET`（v2）/ `PORTAL_API_SECRET`（portal）共有シークレットを SHA-256 + `timingSafeEqual` で検証（`lib/partner/secret.ts`、TV poll-secret と同方式）。これは**機械間 mTLS 相当**であって人間の SSO ではないが、「2 アプリ間で短命署名トークンを授受する」実装パターンが既にプロジェクトに存在することを示す。

### 制約・要件

- **CLAUDE.md セキュリティ最優先**: 公立校データ漏洩 = サービス終了。認証は「マネージド委譲の安全性 > 自前実装の柔軟性」（ADR-003 のトレードオフを継承）。
- **データ所在**: ただし**運営アカウントの ID は社内スタッフのものであり、生徒 PII を含まない**。ISMAP / 越境要件（ADR-003 代替 C で外部 IDaaS を却下した根拠）は**学生データ**にかかる制約であって、社内オペレータの認証 ID には直接かからない — この区別が選択肢評価で効く。
- **既存 ADR との整合**: ADR-003 は「将来 SAML/OIDC で自治体 SSO に拡張可能」と**既に余地を明記**。本 ADR はその拡張点の具体化であり、原則 ADR-003 を覆さない。
- **失効の即時性**: ADR-026（disable + `revokeRefreshTokens`）、ADR-031（MFA 段階強制）と矛盾しない設計であること。

## 決定

**運営アカウントの SSO は「② 共通 IdP（Google Workspace）への hub-and-spoke federation」を最終形として採用する。** portal（Supabase Auth）と v2（Identity Platform）を**どちらも Google Workspace を上流 IdP とする独立した RP（Relying Party）**にし、両アプリの認証を同一の Google セッションに委譲する。各アプリの**認可（portal=`profiles.role`、v2=claims/RLS）はそのまま各アプリ側に残す**。

移行は二段階:

- **暫定（前フェーズ並走・現行 §42.4）**: 「③-a ディープリンク + 短命ハンドオフトークン」。既配線のディープリンクに、送出側が HMAC 署名した短命トークン（Partner secret / TV poll-secret と同方式）を付け、遷移先が自セッションに交換して**再ログインを省く**。真の SSO ではない（資格情報ストアは 2 つのまま）が、Phase 7 到達まで運営の往復摩擦を消す。
- **最終形（Phase 7）**: **②**。両アプリに Google sign-in provider を**設定で**足す（Identity Platform は Google OIDC を native サポート、Supabase Auth は「Sign in with Google」を first-class サポート）。運営は Google で 1 回ログイン → 両コンソールにシングルサインオン。

**ADR-003 は supersede しない（併存・拡張）。** v2 は Identity Platform を認証基盤として維持し、本 ADR は Identity Platform テナントに **Google フェデレーション provider を追加する**だけ。これは ADR-003 §「将来拡張」が予告した拡張点の実現にあたる。

## 検討した代替案

評価軸 = ①セキュリティ境界 ②実装コスト ③既存配線の流用 ④公立校データ要件（CLAUDE.md）適合。

| 案 | セキュリティ境界 | 実装コスト | 既存配線流用 | 公立校データ適合 | 判定 |
|---|---|---|---|---|---|
| ① IdP（v2）へ寄せる | △ portal 認証を IdP に付替え＝ portal の認可基盤（`auth.uid()`/`profiles`）を分岐 | 大（portal 側 auth 再配線、IdP は汎用 OIDC OP ではない） | ディープリンクのみ | ○（GCP 内に寄る） | ❌ 却下 |
| **② Google Workspace で両アプリを束ねる** | **◎ 集中 MFA・集中失効・新たな資格情報ストアを増やさない** | **小（両アプリとも Google provider は設定レベル）** | **◎ ディープリンク温存＋再ログインだけ消える** | **◎（社内 ID のみ・学生 PII 不関与）** | ✅ **採用（最終形）** |
| ③-a ディープリンク＋ハンドオフトークン | ○ 短命署名・既存 HMAC 方式 | 小 | ◎ | ○ | ✅ **暫定として採用** |
| ③-b 自前 OIDC ブローカ（Keycloak 等）を GCP に常駐 | ○ 完全統制 | 大（認証サーバの運用・パッチ・監査責任） | ディープリンクのみ | △（自前運用＝ ADR-003 の却下理由と同型） | ❌ 却下 |
| ③-c portal を IdP に完全統合（Supabase Auth 全廃） | △ 広告主含む全ユーザー移行 | 特大（portal RLS 全面再設計） | ディープリンクのみ | ○ | ❌ 却下（過剰） |

### 代替 ①: Identity Platform（v2 側）に寄せる

運営アカウントを Identity Platform に一本化し、portal が IdP を信頼する案。

- **却下理由（技術）**: Identity Platform は **federated identity を「消費」する IdP** であって、第三者 RP にトークンを発行する**汎用 OIDC OP（authorization endpoint を持つ）ではない**。portal を「IdP に OIDC で federate させる」構成は素直に成立しない。実装すると portal 側で Firebase ID トークン検証 or custom token 交換の独自配線が必要になり、attack surface が増える。
- **却下理由（コスト）**: portal の認可基盤は **Supabase Auth の `auth.uid()` を基点とした RLS と `profiles` 行**に深く依存。運営アカウントだけを IdP に剥がすと **portal の認証が二系統に分岐**（広告主=Supabase Auth、運営=IdP）し、portal が逆に複雑化する。SSO の目的（複雑性の削減）に反する。
- **補足**: v2 単独で見れば Identity Platform 維持は正しい（ADR-003）。問題は「portal をそこへ寄せる」部分だけ。

### 代替 ②: Google Workspace で両アプリを束ねる（採用）

Rebounder 社内スタッフは GCP / Google で業務しており、**ほぼ確実に Google Workspace アカウントを持つ**。Google を上流 IdP とし、両アプリを spoke にする:

- **v2 / Identity Platform**: Google を sign-in provider として追加（OIDC、native）。運営が Google でサインイン → Identity Platform が従来どおり Firebase トークンを発行 → **既存の claims/RLS パイプライン（ADR-003）は無改修**。
- **portal / Supabase Auth**: 「Sign in with Google」プロバイダを追加（native）。運営 `profiles` は email/password から Google サインインに切替（広告主は email/password のまま）。
- **結果**: 両アプリが同一 Google セッションに認証を委譲 = 真の SSO。**2 アプリ間のトークン交換は不要**（各々が独立に同じ IdP の RP）。認可は各アプリに温存。
- **セキュリティ境界（◎）**: 運営アカウントに Google Workspace の MFA・条件付きアクセス・**集中ライフサイクル**が効く。退職者の Google アカウント無効化 → 次回トークン更新で**両アプリから一斉に締め出し**。`hd`（hosted domain）claim を Rebounder の Workspace ドメインに固定し、社外 Google アカウントの混入を遮断。**新たな資格情報ストアを増やさない**（自前パスワードハッシュを持たない ADR-003 の思想と一致）。
- **公立校データ適合（◎）**: Google が扱うのは**社内オペレータの ID** のみ。**学生 PII は一切 Google 認証経路に乗らない**ため、ADR-003 代替 C（外部 IDaaS）を却下した越境/ISMAP 根拠は本案には当たらない（あの制約は学生データに対するもの）。むしろ ADR-005（Vertex AI）/ ADR-024 と同じく「PII は GCP 内に閉じる、社内 ID は Google マネージドに委譲」で一貫。
- **実装コスト（小）**: 両スタックとも Google provider は**設定（Terraform / コンソール）レベル**で、独自トークン検証コードを書かない。Identity Platform provider は `infrastructure/terraform/modules/identity_platform/`（ADR-003 / PR #84）に追記。

### 代替 ③-a: ディープリンク + 短命ハンドオフトークン（暫定として採用）

両認証スタックを現状維持しつつ、コンソール往復時に送出側が HMAC 署名した短命トークンを付与し、遷移先が検証して自セッションへ交換する（＝「自動ログイン」を §42.4 から一段昇格）。

- **採用理由（暫定）**: 既配線のディープリンク（`PORTAL_ADMIN_URL`/`V2_ADMIN_BASE_URL`）と既存の HMAC 方式（`lib/partner/secret.ts`）をそのまま流用でき、Phase 7 到達前から往復摩擦を消せる。設計 §42.4 の現行方針そのもの。
- **最終形にしない理由**: 真の SSO ではない。**資格情報ストアが 2 つ残る**（二重 MFA enrollment、二重失効、二重監査）。運営の新規参画/離脱で両アプリを手当てする運用が消えない。あくまで Phase 7 までの橋渡し。

### 代替 ③-b: 自前 OIDC ブローカ（Keycloak / Ory / Zitadel を Cloud Run 常駐）

GCP 内に OIDC OP を立て、両アプリを federate。

- **却下理由**: 認証サーバの**運用・パッチ・脆弱性対応・監査を自社責任**で背負う。これは ADR-003 代替 B（自前認証）を却下したのと同型のリスク（公立校データでセキュリティを自己責任にしない）。② が設定で済むのにブローカ常駐は過剰。

### 代替 ③-c: portal を Identity Platform に完全統合（Supabase Auth 全廃）

①の最大版。広告主含む portal 全ユーザーを IdP へ。

- **却下理由**: portal の RLS（`auth.uid()`）と `profiles` を全面再設計する特大移行。**運営オンリーの SSO ニーズに対して過剰**。広告主母集団の移行リスクを SSO の口実で背負うのは ルール6（1 PR 1 機能・スコープ厳守）の精神に反する。

## 結果（Consequences）

### 良い影響

- **運営の往復摩擦が消える**: Google 1 ログインで両コンソール。ディープリンクは温存され、遷移先で再ログインが出ない。
- **失効・MFA・棚卸しが集中化**: 退職者処理が Google アカウント無効化に一本化（ADR-026 の「単一ソースで即時失効」と同じ思想を運営 ID に拡張）。MFA は Google Workspace 側で強制でき、ADR-031（teacher の IdP MFA）とは別母集団として整合。
- **既存スタックを壊さない**: v2 は ADR-003（Identity Platform）を維持、portal は Supabase Auth を維持。両者に provider を**足すだけ**。ADR-003 が予告した拡張点の実現。
- **スコープが狭くブラスト半径が小さい**: 触るのは運営 `profiles` と Identity Platform の ops/system_admin 経路のみ。広告主・教員・生徒は無改修。
- **学生 PII を巻き込まない**: 越境/ISMAP 上の新リスクを増やさない。

### 悪い影響 / リスク

- **単一ログアウト（SLO）のギャップ**: federation は**認証**を集中させるが、各 RP は**自前セッション**を保持する。Google でサインアウトしても、各アプリの session cookie が生きていれば即時には落ちない。失効の即時性が要る操作は、ADR-026 同様**各アプリ側でも revoke / sign-out を伝播**させる設計が必要（v2 は `revokeRefreshTokens` 既設、portal は Supabase session 失効を要実装）。
- **Google Workspace への依存**: Google 障害時に両アプリのログインが同時に止まる（可用性結合）。緩和: 運営は少数なので緊急時のブレークグラス（email/password を IdP 側に残す）を 1 経路だけ確保。
- **v2 の system_admin provisioning との接合**: 現状 v2 は localId = `users.id`（UUID）で provisioning（ADR-003）。一方 **federated（Google）ユーザーの localId は IdP/Google 側が決め、UUID を強制できない**。system_admin は `users` 行を持たず `system_admins` + `actor_identity_uid` で追跡する既存モデル（[[system-admin-not-in-users-table]]）に、**federated localId をマップする経路**が要る。「federated user に localId=UUID を強制しようとしない」ことを実装規約として明記する必要がある。
- **Workspace アカウントを持たない運営**: 全運営が Workspace 前提。例外者がいれば Identity Platform 直 email/password をフォールバックに残す（ブレークグラスと兼用）。

### トレードオフ

- 「集中 IdP の利便・統制 vs 可用性結合」のうち、**運営が少数で集中統制の価値が大きい**ため集中側に振る（可用性はブレークグラス 1 経路で緩和）。
- 「真の SSO（②）への一足飛び vs 段階移行」のうち、**暫定 ③-a を挟む段階移行**に振る（Phase 7 が来る前に往復摩擦を先に消し、②は前フェーズ完了後に落ち着いて入れる）。
- 「portal を IdP に寄せる（①）vs 両アプリを上流 IdP に寄せる（②）」のうち、**どちらのアプリの認可基盤も触らない②**に振る（①は portal 認証を分岐させ複雑性が増える）。

## 段階移行プラン

設計 §42.5 の Phase 順（Flow A → namespace → 名寄せ → Outbox → Flow B → 効果還元 → **SSO**）を維持し、SSO 内部を 3 ステップに分割する。

| ステップ | 内容 | 規模 | 前提 |
|---|---|---|---|
| **S0（並走・暫定）** | ③-a ハンドオフトークン: 既配線ディープリンクに HMAC 短命トークンを付け、遷移先で自セッション交換（再ログイン省略）。送出/検証は `lib/partner/secret.ts` と同方式の薄い lib を追加。 | 小（≤200 行） | 既存ディープリンク・HMAC 方式（実在） |
| **S1** | v2 Identity Platform に Google OIDC provider を追加（`infrastructure/terraform/modules/identity_platform/`）、`hd` 制約・ops/system_admin の federated localId マッピング、`revokeRefreshTokens` 経路の維持確認。 | 中 | ADR-003 / ADR-026 / 本 ADR 承認 |
| **S2** | portal Supabase Auth に「Sign in with Google」を追加、運営 `profiles` を Google サインインへ切替（広告主は email/password 維持）、Supabase session 失効の伝播実装。 | 中 | S1 完了・portal 側 §44 権限規律 |
| **S3（退役）** | 運営の email/password 経路を**ブレークグラス 1 経路を除き撤去**（§43 の「足す＝退役」原則）。S0 のハンドオフトークンは②到達で不要化 → 撤去。 | 小 | S1+S2 安定後・モニタ期間経過 |

- **Done 条件（§43 退役ペア）**: 各ステップで対応する旧経路（二重ログイン / ハンドオフトークン）を read-only 化 → 撤去まで含める。加法だけで Done にしない。
- **検証**: 運営アカウントで「Google 1 ログイン → portal `/admin` と v2 `/ops` 双方にアクセス」「Google 無効化 → 両アプリが次回更新で締め出し」を E2E で確認（[[ref_staging_browser_e2e_needs_user_login]] によりブラウザ実 E2E は本人ログイン必須 → 必要ならコードレベル検証へフォールバック）。

## ADR-003 との関係（明記）

- **supersede しない。併存・拡張。** v2 の認証基盤は Identity Platform のまま（ADR-003 は Accepted 維持）。本 ADR は Identity Platform テナントに **Google フェデレーション provider を 1 つ追加する**運営向け SSO であり、ADR-003 §「将来拡張」（「SAML / OIDC プロバイダ連携で対応可能」）が**予告した拡張点の実現**にあたる。
- ADR-003 の provisioning 規約（localId = `users.id`）は **password ユーザー**に対する規約。**federated ユーザーには適用しない**（localId は IdP が決定）。この差分を本 ADR が補足する（上記「悪い影響」参照）。
- portal 側は ADR の管轄外（v2 リポジトリの ADR は v2 を律する）が、本 ADR は portal にも対称の Google provider 追加を**前提として要求**する。portal 側の意思決定記録は portal リポジトリの ADR で別途残すこと（設計 §44.3 の portal `.claude`/ADR 整備と整合）。

> **確定（2026-06-14・ユーザー判断）**: 採用案 = **②**（運営アカウントは Google Workspace を共通上流 IdP とする hub-and-spoke federation）。暫定は **③-a**（ディープリンク + 短命ハンドオフトークン）。
>
> **実装フェーズで詰める事項（本決定の前提を覆さない実装パラメータ）**: (a) 暫定 S0 を挟むか / Phase 7 まで現行ディープリンクのままにするか、(b) ブレークグラス経路の具体（IdP 直 email/password を何アカウント残すか）、(c) portal 側 ADR の起票主体。これらは §42.5 Phase 7 着手時（前フェーズ完了後）に確定する。
