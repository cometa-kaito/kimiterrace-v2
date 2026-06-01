# ADR-016: クラス magic link による生徒匿名アクセス

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-28
- 関連: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [F05](../requirements/functional/F05-class-magic-link.md), [F06](../requirements/functional/F06-student-qa.md), [v2-mvp.md §3](../requirements/v2-mvp.md)

## 文脈

生徒がサイネージ表示の延長として「自分のスマホ/タブレットからも見たい」「掲示物について質問したい」というユースケースがある（[F05](../requirements/functional/F05-class-magic-link.md), [F06](../requirements/functional/F06-student-qa.md)）。
これを実現する認証/識別手段を決める必要がある。

選択肢:
- 個別アカウント発行（Identity Platform で生徒ごとログイン）
- 学校 SSO（Google Workspace for Education / Microsoft 365 連携）
- OTP メール（Magic Link をメール送信）
- クラス単位 magic link（1 クラス 1 URL、個人特定なし）
- アクセス自由（誰でも URL を知れば見られる）

公立校特性として:
1. 生徒のメール所有率が学年差・学校差で大きく揺れる（高 1 で未所有のケースもある）
2. 学校 SSO は教育委員会経由のテナント設定が必要で、導入ハードルが高い
3. 個別アカウント発行は卒業・転入・編入で運用が破綻する（毎年 300+ 件の発行/失効が発生）
4. 一方、アクセス自由は外部漏洩で校外者が自由に閲覧できるためセキュリティ要件を満たせない
5. 生徒の学習履歴・進路情報を「個人特定 + 蓄積」する機能は MVP 対象外（[v2-mvp.md §10 将来追加機能](../requirements/v2-mvp.md)）→ **個人識別の必然性が薄い**

## 決定

**クラス単位 magic link**（1 クラスに 1 つの URL を発行、個人特定なし）を採用する。

- magic_link テーブル: `id`, `school_id`, `class_id`, `token`, `expires_at`, `revoked_at`
- 有効期限デフォルト 90 日、教員が短縮/延長/失効可能
- 生徒側は cookie で client_id (uuid) のみ保持。氏名・学籍番号等は保存しない
- 失効後は 410 Gone
- QR コード生成で印刷配布可能

## 検討した代替案

### 代替 A: 個別アカウント発行
- 却下理由: 卒業・転入・編入の運用コストが学校事務に重くのしかかる
- 副次理由: 「生徒のスマホでログインしない」運用慣例と乖離（学校配布アカウントを家でも使う前提が現場で受け入れられない）

### 代替 B: 学校 SSO (Google Workspace for Education 等)
- 却下理由: 導入は教育委員会経由のテナント設定が必要で、学校別オンボーディングが重い
- 副次理由: SSO 連携は外部 IdP 依存になり、[memory: feedback_closed_system_security](../../.claude/projects/.../memory/feedback_closed_system_security.md) (自校内完結優先) と矛盾
- 留保: 将来オプションとして検討余地は残す（Phase 2）

### 代替 C: OTP メール (Magic Link をメール送信)
- 却下理由: 生徒のメール所有が前提となり、特に高 1 序盤の運用で詰まる
- 副次理由: メール送信インフラを別途整える必要があり、攻撃面が広がる

### 代替 D: アクセス自由（認証なし）
- 却下理由: 校外者が URL を知れば誰でも閲覧でき、[NFR03 セキュリティ](../requirements/non-functional/NFR03-security.md) を満たせない
- 副次理由: 掲示物に含まれる校内固有情報（行事・スケジュール）が漏洩するリスク

## 結果（Consequences）

### 良い影響

- 学校事務の運用負荷が極小（クラス単位の URL を年度初めに 1 回発行するだけ）
- 生徒のオンボーディング摩擦ゼロ（個人情報入力不要）
- 個人特定情報を持たないため、漏洩時の影響範囲が「クラス単位の閲覧情報」に限定される
- QR コード配布で物理的に閉じた配布チャネルを確保できる

### 悪い影響 / リスク

- **学習履歴・進路情報の個人化ができない**: Phase 2 で「個人化された AI アドバイス」が要件化した場合、認証方式の再設計が必要
- **magic_link URL 漏洩リスク**: SNS 等で校外者に流出すると、その URL は失効まで誰でも閲覧可能。漏洩検知時の即時失効フローを runbook 化する必要（[F05](../requirements/functional/F05-class-magic-link.md)）
- **生徒識別不能による分析限界**: F07 イベントログでは client_id (cookie) ベースの集計は可能だが、「同一生徒が複数端末で利用」を統合できない
- **同一クラス内での「いたずら投稿」リスク**: 生徒 Q&A（[F06](../requirements/functional/F06-student-qa.md)）で個人特定なしの匿名質問が可能なため、社会的に不適切な質問が来る可能性 → rate limit + コンテンツモデレーションで対応

### トレードオフ

- 「個別認証 vs 運用簡素」のうち**運用簡素**に振った設計
- セキュリティ面では「個人情報保護」を強化し「不正アクセス検知」を犠牲にした設計
- 漏洩リスクは URL の cryptographic randomness + 失効フロー + 90 日デフォルト有効期限で抑制
