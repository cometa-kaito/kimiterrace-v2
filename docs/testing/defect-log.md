# Phase 検証 欠陥ログ（defect-log）

> Phase 検証の実行中に検出した欠陥を一元追跡する。検出 → 起票 → 修正 → 再検証 → クローズ のループを記録し、go/no-go 判断の証跡とする。
> 親: [test-strategy.md](test-strategy.md) / 最終ゲート: [go-no-go-report.md](go-no-go-report.md)

最終更新: 2026-06-04 / ステータス: 欠陥なし（§3.1 に #243 認可ゲート在否監査の証跡を追記。実行時欠陥はまだ無し）

---

## 1. 運用フロー

```
検出（トラック①〜⑤）
  → defect-log 起票（影響度判定）
  → 修正 PR（Claude 開発権限内、CLAUDE.md 8ルール遵守）
  → Reviewer Agent 別 spawn でレビュー（self-review 不可）
  → CI green + Reviewer APPROVE
  → 再検証（元ケースを再実行 = 攻撃/シナリオが防がれる/通ることを確認）
  → クローズ
```

- 影響度は [threat-model.md §3](../architecture/threat-model.md) の定義に従う（Critical=サービス停止/全校PII漏洩、High=単校PII漏洩・認証バイパス成功、Medium=単一アカウント、Low=軽微）。
- **Critical / High は go のブロッカー**。1件でも open なら no-go（③ セキュリティの合否基準と整合）。
- Medium は go-with-conditions 可（暫定回避 + フォロー issue 必須）。Low は記録のみ。
- セキュリティ系欠陥は本ログに加え、必要に応じて [threat-model.md](../architecture/threat-model.md) 本体にも追記する。

---

## 2. 欠陥一覧

| ID | 検出日 | トラック | ケースID | 概要 | 影響度 | 関連脅威ID | 状態 | 修正PR | 備考 |
|---|---|---|---|---|---|---|---|---|---|
| _(実行時に追記)_ | | | | | | | | | |

状態の値: `open` / `修正PR中` / `Reviewer中` / `再検証中` / `closed` / `既知制約(go-with-conditions)`

---

## 3. 設計時点で判明している確認点（実行前の先取り）

詳細設計のコード接地で見つかった、実行時に必ず確認すべき既知の懸念。欠陥として確定はしていないが追跡対象。

| # | トラック | 内容 | 出典 |
|---|---|---|---|
| P-1 | ② UI/UX | サイネージ `SignageClient` の `autoPlay loop` が `prefers-reduced-motion` を未尊重の可能性 | [tracks/02](tracks/02-ui-ux-gui.md) UX-003 |
| P-2 | ② UI/UX | ログインエラー表示が `color:crimson` のみで色依存（色覚多様性で識別困難の可能性） | [tracks/02](tracks/02-ui-ux-gui.md) UX-008 |
| P-3 | ⑤ 移行/監査 | `docs/runbooks/cutover.md` が ROADMAP から参照されているが未作成 | [tracks/05](tracks/05-migration-audit-compliance.md) §8 |
| P-4 | ③ セキュリティ | threat-model が参照する一部テストパス（例 `__tests__/auth/jwt.test.ts` 等）の実在は要確認 | [tracks/03](tracks/03-security-pentest.md) §7/§8 |

---

## 3.1 認可ゲート在否監査（#243 トラック①/③ E2E 整備時、2026-06-04）

`requireRole` 認可マトリクス + クロステナント分離 E2E（`apps/web/e2e/authorization-matrix.spec.ts` /
`cross-tenant-isolation.spec.ts`）の整備にあたり、recon でフラグされた特権 route の **認可/ロール/シークレット
ゲートの在否をソース確認**した。結論: **4 経路すべてゲート在。欠陥なし（patch 不要）**。E2E は現状の正しい
挙動を pin する（回帰検知のため）。

| 経路 | ゲート（ソース確認済） | 拒否時の挙動 | 判定 |
|---|---|---|---|
| `POST /api/magic-links/[id]/extend` | `getCurrentUser`→401 / `isIssuerRole`(teacher,school_admin)+`schoolId`→403 | 他校/不存在/失効は RLS で不可視→**404**（`not_found_or_revoked`） | ✅ ゲート在 |
| `POST /api/magic-links/[id]/revoke` | 同上（`isIssuerRole`+`schoolId`） | 他校/不存在/失効済は RLS 不可視→**404**（`not_found_or_already_revoked`、冪等） | ✅ ゲート在 |
| `POST /api/tv/commands/ack` | **共有シークレット** `TV_POLL_SECRET`（`?key=`/`x-tv-key`、定数時間比較）。未設定は fail-closed**401**、不一致**401**。device 単位レート制限。cross-tenant 解決は system_admin policy 経由（BYPASSRLS 不使用） | secret 不一致/未設定→401、id/device 不一致→200+`not_found` | ✅ ゲート在（ADR-022 の意図的な匿名デバイス経路 = セッション認証ではなくシークレット認証） |
| `DELETE /api/teacher-inputs/[id]` | `withSession({allowedRoles: TEACHER_INPUT_STAFF_ROLES})`→未認証401/誤ロール403 + `tenant_isolation` RLS | 他校/不存在→**404**、生徒・保護者→403 | ✅ ゲート在 |

補足:
- `POST /api/teacher/chat` は **認可（PUBLISHER_ROLES、system_admin 除外）を SSE/ボディ検証より前に評価**する
  ことをソース確認（route: `getCurrentUser`→role gate→`respondWithChatStream`）。E2E は誤ロール403 / 認可後の
  ボディ検証400 で gate 順を Vertex 非依存に pin。
- 上記はいずれも CLAUDE.md ルール2（多層防御: app 層 role gate + DB 層 RLS）に沿う。**app guard は role 境界**、
  **RLS は school 境界**を担い、クロステナント越境は後者が 404/空で止める（403 で存在を漏らさない）ことを
  `cross-tenant-isolation.spec.ts` が SCHOOL2 教員→SCHOOL1 リソースで実証する。

> この監査は「欠陥が無いことの証跡」として記録する。万一どの経路かでゲート欠落が**実行時に**判明した場合は、
> §2 の欠陥一覧へ起票し直す（本 E2E PR ではアプリコードを silent patch しない方針）。

---

## 4. 集計（go/no-go 用サマリ）

実行完了時に記入:

- Critical: open ___ / closed ___
- High: open ___ / closed ___
- Medium: open ___ / closed ___（うち go-with-conditions ___）
- Low: open ___ / closed ___

> Critical + High の open が 0 であることが go の必要条件。
