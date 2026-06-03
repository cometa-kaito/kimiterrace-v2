# ADR-031: MFA（多要素認証）の段階的エンフォース戦略

- 状態: Accepted（2026-06-03 ユーザー確定）
- 日付: 2026-06-03
- 関連: [#47](https://github.com/cometa-kaito/kimiterrace-v2/issues/47) (F11 ロール管理), [ADR-003 (Identity Platform)](003-identity-platform.md), [NFR03 (セキュリティ)](../requirements/non-functional/NFR03-security.md), [F11 受け入れ条件](../requirements/functional/F11-role-management.md), [CLAUDE.md セキュリティ最優先](../../CLAUDE.md)

## 文脈

[NFR03](../requirements/non-functional/NFR03-security.md) は「teacher 以上のアカウントに MFA を強制する」ことを要求している。一方で現状は **未実装**:

- Terraform の `identity_platform` モジュールは `mfa_config` 未設定（TODO のまま）
- アプリ側に multiFactor enrollment（登録）/ enforcement（強制）のフローが無い

公立高校の生徒データを 10 年保管前提で扱うため、教職員アカウントの乗っ取りは漏洩に直結する（CLAUDE.md「漏洩したらサービス終了」）。MFA はその主要な緩和策である。

しかし、岐南工業 PoC（2026/6〜9）の初日から全教員に MFA 初期設定（SMS/TOTP 登録）を強制すると、IT リテラシーの個人差が大きい教員集団で**導入摩擦**が大きく、PoC の本来の検証（機能・運用フィット）を阻害するリスクがある。「最短で安全に MVP/PoC へ到達」と「本番でのセキュリティ要件充足（NFR03）」のトレードオフを明文化する必要がある。

## 決定

2026-06-03 にユーザー（人間ゲート）が **段階的エンフォース**を確定した。

1. **capability は MVP で実装する**:
   - Terraform `identity_platform` の `mfa_config` を有効化（state=`ENABLED`、許可 factor は TOTP を既定、SMS は要否を実装時判断）。
   - アプリ側に **multiFactor enrollment フロー**（教員が自分の MFA を登録する画面・経路）を実装する。
   - 監査: enrollment / unenrollment / MFA challenge の成否を `audit_log` に記録（[CLAUDE.md ルール1](../../CLAUDE.md)、[NFR04](../requirements/non-functional/NFR04-audit-log.md)）。
2. **PoC（岐南工業）では MFA は任意**（enrollment は可能だが未登録でもログインを拒否しない）。導入摩擦を避け、PoC の検証目的を優先する。
3. **本番導入ゲートで teacher 以上に強制化**する。強制化の時点で、teacher / school_admin / system_admin は MFA 未登録ならログイン後に enrollment へ誘導し、未完了では保護機能へ到達できない（grace period の有無は導入計画で決める）。
4. **強制の単一ソースは Identity Platform**（[ADR-026](026-account-deactivation-role-change-enforcement.md) の思想と整合）。DB 側にミラーフラグを持たせる場合も、認証エンフォースは IdP 側で行い「DB フラグだけ立てて認証で弾かない」security theater を作らない。

## 検討した代替案

- **MVP から即・完全強制（最も安全）**: NFR03 を最初から完全充足。却下理由: PoC 初日に全教員へ MFA 初期設定を強いると導入摩擦が大きく、PoC の本来の検証を妨げる。3 クラス規模の PoC では capability があれば本番強制で要件を満たせると判断。
- **Phase 2 へ全面延期（capability も後回し）**: 実装が最短。却下理由: NFR03 未達のまま本番に進む構造リスクを残し、後付けは enrollment 経路や監査の設計を後回しにして技術的負債化する。capability は MVP で作り、強制の ON/OFF だけをゲートで切り替える方が安全かつ低コスト。
- **DB フラグのみで擬似 MFA 強制**: IdP を使わずアプリ層でフラグ管理。却下理由: ADR-026 と同じく認証の単一ソースを分散させ、cookie 有効期間中のバイパス等の穴を生む。IdP の `mfa_config` を正規に使う。

## 結果（Consequences）

- **良い影響**: NFR03 を本番で確実に満たす道筋が明文化され、PoC の検証目的と両立する。enrollment 経路と監査を MVP で先に作るため、本番での強制化は設定切り替え中心の低リスク作業になる。
- **悪い影響 / コスト**:
  - PoC 期間中は MFA 未登録教員が存在しうる＝その間のアカウント乗っ取りリスクは MFA で緩和されない（パスワード強度・revoke・監査などの既存統制に依存）。PoC は実生徒データの本番運用ではない前提でこのリスクを受容する。
  - 強制化のタイミング・grace period・factor 種別（TOTP/SMS）の詳細は導入計画で確定する必要がある（本 ADR では「本番ゲートで強制」までを確定し、運用詳細は実装/導入スライスに委譲）。
- **トレードオフ**: 「即・完全強制（最安全）」ではなく「capability 先行 + 本番ゲート強制」を選んだため、PoC 期間に MFA 緩和が効かない窓が残る。実生徒データを扱う本番では強制が前提であり、PoC の限定スコープでこの窓を許容する。
- **未確定（実装/導入で決め本 ADR に追補）**: 許可する factor 種別（TOTP のみか SMS 併用か）、本番強制化時の grace period の有無と長さ。
