# 本番切替 runbook（cutover）

旧 Firebase 構成から V2（Cloud Run + Cloud SQL）への**本番切替**手順。
本体アプリの切替（Firestore → PostgreSQL）に加え、firmware/サイネージ API の段階切替、
F15 TV デバイス（LP/Turso → Cloud SQL）切替と SWITCHBOT シークレット rotation を一括で扱う。

> **境界（最重要）**: Claude は **staging までを完成**させ、本 runbook を整備する。
> **本番切替の実行（本番データ移行・DNS 切替・旧 Firebase 停止判断・最終法務判断）は人間（導入フェーズ担当）**。
> 本 runbook は人間が**読みながら手を動かす台本**として書く（[README](README.md) の書き方準拠）。
> Claude / 人間の境界の一次定義は [移行・監査・コンプラ トラック §7](../testing/tracks/05-migration-audit-compliance.md)。

---

## 1. 前提（誰が、いつ実行する）

- **実行者**: 人間（導入フェーズ担当）。Claude は staging までで、本番への適用は行わない。
- **起動条件（Entry gate）** — すべて満たして初めて切替日を設定する:
  1. staging が **feature-complete**（F01–F16 + V1 互換が staging で動作）。
  2. **合成 dry-run が全 pass**（[移行トラック MIG-001〜008](../testing/tracks/05-migration-audit-compliance.md): 欠損 0 / 重複 0 / FK 整合 100% / 冪等性成立（再投入で差分 0）/ 移行後の RLS テナント分離が有効）。
  3. **本番リハーサル dry-run ×3**（本 runbook §3 Phase A、ROADMAP「dry-run 3 回」＝本番相当データでのリハーサル）が 3 回連続で green。
  4. Phase 検証の **go/no-go レポート**提出済（[#243](https://github.com/cometa-kaito/kimiterrace-v2/issues/243) / [go-no-go-report.md](../testing/go-no-go-report.md)）。
- **並行運用前提**: 切替日まで **V1 を本番として残し、V2 は staging**。切替は原則 **DNS の向き先変更のみ**で行い、いつでも V1 へ戻せる状態を保つ。並行運用期間は **2 週間想定**（[v1-v2-mapping §切替プラン](../architecture/v1-v2-mapping.md)）。
- **対象となる 3 系統の切替**:
  - **(A) 本体アプリ + データ**: Firestore → Cloud SQL（PostgreSQL）、Firebase Hosting/Functions → Cloud Run。
  - **(B) firmware / サイネージ API**: 旧 Firebase Functions エンドポイント → Cloud Run（DNS 段階切替）。
  - **(C) F15 TV デバイス**: LP（`edix-lp`）の Turso → Cloud SQL 移行 + **SWITCHBOT_WEBHOOK_SECRET rotation** + LP エンドポイント廃止。

---

## 2. 必要な権限・事前準備

- **GCP**: Cloud Run デプロイ権限 / Cloud SQL の **migrator ロール（`kimiterrace_migrator`、テーブルオーナー）** / Secret Manager 読取 / DNS ゾーン管理。
- **シークレットは Secret Manager のみ**（CLAUDE.md ルール5、JSON キーファイル禁止）。DB 接続情報は `gcloud secrets versions access` 経由で取得。
- **マイグレーションのロール不変条件**: SECURITY DEFINER 関数（`resolve_magic_link` 等）のオーナーが migrator になるよう、**migrator ロールで適用**する。詳細・検証は [db-migrations.md](db-migrations.md)（誤ると F05 生徒アクセスが fail-closed で全断）。
- **LP / TV**: Vercel CLI 認証済（`cometa-kaito`）、各 TV 実機への **ADB** アクセス（`config_endpoint` はリモート更新不可のため物理/ADB 必須）。
- **バックアップ取得**: 切替前に V1 Firestore の最終 export と V2 Cloud SQL のスナップショットを取得し、10 年保管ストレージへ退避（`backup-restore.md`（README に予定・未整備）整備後はそちらに従う）。

---

## 3. 手順

### Phase A — 本番データ移行（人間）

移行スクリプトの実体は `apps/jobs/src/migration/`（`firestore-to-pg.ts` がエントリ、`transform.ts` / `import.ts` / `ids.ts` / `types.ts`）。`ImportSummary` で件数を機械突合する。

1. **本番リハーサル dry-run ×3**: 使い捨ての本番相当 DB（または隔離スキーマ）に、本番 Firestore の export を **migrator ロール**で投入。各回で §4 の突合を実行し、**3 回連続 green** を起動条件 §1-3 とする。
   - ⚠️ Claude が回すのは **合成データの dry-run** まで（[トラック §2/§7](../testing/tracks/05-migration-audit-compliance.md)）。**本番 Firestore データでのリハーサルと本移行は人間**。
2. **移行フリーズ窓**: V1 を **read-only 化**（新規書込停止）→ 最終 Firestore export → V2 へ本 import → §4 検証クエリ。import は冪等なので、失敗時は原因修正後に再投入できる（重複は出ない）。
3. **DB マイグレーション適用**: drizzle DDL → 手書き `migrations/*.sql`（RLS / トリガ / SECURITY DEFINER）の順で migrator ロールにて適用。適用順の単一ソースは `packages/db/__tests__/_setup/global-setup.ts` の loader。手順と SECURITY DEFINER オーナー検証は [db-migrations.md](db-migrations.md)。

### Phase B — アプリ / firmware 切替（段階 DNS）

1. 移行済み Cloud SQL を指す **V2 Cloud Run 本番リビジョン**をデプロイ（まだトラフィックは向けない）。
2. firmware / サイネージ API を **DNS で段階切替（5% → 50% → 100%）**（[F12-v1-port](../requirements/functional/F12-v1-port.md)）。各段階で監視（Cloud Monitoring / Sentry / Cloud Trace）を確認してから次段へ。
3. 各段階で **スモーク**: 公開サイネージ `/signage/{classToken}` の描画 / RLS テナント分離（他校データ不可視）/ イベントロギング `POST /signage/{token}/events` / 教員入力 → サイネージ反映。

### Phase C — F15 TV デバイス + SWITCHBOT シークレット rotation

> 担当: シークレット rotation のオーケストレーション（Vercel env rotate / 露出ファイル redact / git 履歴 scrub）は Desktop/Claude で実施可。ただし **TV 実機の ADB 操作は物理アクセスが要る人間タスク**、**public リポジトリへの force-push は人間の GO 必須**。

手順は `switchbot-secret-rotation`（memory: `~/.claude/.../memory/project_switchbot_secret_rotation.md`）の 3 ステップに準拠（公開リポジトリに `SWITCHBOT_WEBHOOK_SECRET` が平文露出、cutover に rotation 一式を集約と決定済）。

1. Vercel env の **`SWITCHBOT_WEBHOOK_SECRET` を rotate**。
2. 各 TV を **ADB** で `webhook_url` / `config_endpoint` を **v2 サブドメイン + 新キー**へ更新 → 旧キーの受理を停止。
3. 露出 3 ファイル（`edix-lp/docs/POC_OPERATIONS.md` ほか）を redact + **git 履歴 scrub**（`git filter-repo`）。**public リポジトリへの force-push は外部影響＝人間の GO 必須**（[busy CEO mode](../../CLAUDE.md) の「外部に視認される一方向アクション」）。
4. **Turso → Cloud SQL 移行**（`tv_devices` と TV のリモコン発行履歴）→ **LP エンドポイント廃止**。
   - ℹ️ [F15 仕様書](../requirements/functional/F15-tv-device-management.md) は「PoC 終了後 2026-10-01 以降」と記載するが、**[STATUS 2026-05-31 ユーザー判断](../STATUS.md)で「staging 完成次第すぐ切替」へ反転済**。本 runbook は反転後の方針（staging 完成トリガ）を正とする。

---

## 4. 検証（成功確認）

- **件数突合**: V1 ↔ V2 を SQL `COUNT` で突合（school / class / user / schedule / notice / assignment / ad 等）。`ImportSummary` の件数と一致。
- **参照整合**: FK 孤児 0（移行先で参照先を欠く行が無い）。
- **テナント分離**: 本番ロール（非 BYPASSRLS の `kimiterrace_app`）で他校データが 0 行（RLS スモーク）。
- **アプリ機能**: 公開サイネージが V2 で描画 / 教員入力 → 反映が成立 / イベントロギングが記録。
- **TV**: 実機 3 台が **新キーで webhook 受理** / `config GET` 成功 / **旧キーで 401**。
- **監査**: 切替に伴う mutation が `audit_log` に記録され、ハッシュチェーンが連続（断絶なし＝改竄なし、CLAUDE.md ルール1）。
- **SECURITY DEFINER**: `resolve_magic_link` のオーナー = migrator（[db-migrations.md §検証](db-migrations.md)）。app ロールでクラストークンが 1 行解決できる。

---

## 5. 失敗時の対処（ロールバック）

並行運用中は **V1 が live** なので、**第一手は DNS を V1 へ戻す**（V2 リビジョンは残置のまま無トラフィック化）。

- **データ移行の失敗**: 本移行はフリーズ窓内で実施。import は冪等なので、原因修正後に再投入する。復旧に時間がかかるなら V1 read-only を解除して V1 継続。
- **段階 DNS で異常**: 当該段階で切替を停止し直前段へ戻す（5%→0%）。Sentry / Cloud Monitoring のアラートを起点に `incident-response.md`（README に予定・未整備）へ。
- **TV 切替の失敗**: `config_endpoint` はリモート更新不可 → **ADB で物理復旧**が必須。旧キー受理を一時復活させる場合は §3-C1 の rotate を巻き戻す（暫定）。
- **SECURITY DEFINER オーナー誤り**（生徒 `/s/{token}` が一律 410）: [db-migrations.md §失敗時の対処](db-migrations.md) でオーナーを migrator に付け替え。
- 詳細な切り戻し手順は `rollback.md`（README に予定、未整備）整備時に本節から委譲する。

---

## 6. 旧 Firebase 停止判断（人間）

- **並行運用 2 週間** + 監視 green + §4 の移行突合 OK を確認後、人間が旧 Firebase Hosting / Functions の停止を判断（[F12](../requirements/functional/F12-v1-port.md):「移行完了確認後に停止」）。
- 停止前に **最終 Firestore export を 10 年保管ストレージへ**退避（NFR04 / 法定保存）。
- 停止後も一定期間は復元可能な状態（export + V2 スナップショット）を維持する。

---

## 7. 未決事項（runbook 整備時に確定）

- **dry-run 環境の隔離方式**: 使い捨て staging/本番相当 DB か隔離スキーマか（再投入・resume 検証で DB をリセットする手段）を確定（[トラック §8](../testing/tracks/05-migration-audit-compliance.md)）。
- **コールド移送（CMP-002）**: 1 年経過監査ログの Cloud Storage Archive 日次移送を staging で dry-run できるか。未整備なら設計レビューで代替し、実移送は本番運用へ。
- **sibling runbook 未整備**: `rollback.md` / `deployment.md` / `backup-restore.md` / `disaster-recovery.md` / `incident-response.md`（README に予定、いずれも未作成）。整備後、本 runbook の該当箇所をリンクに置換する。

---

## 8. 関連

- [ROADMAP](../ROADMAP.md): 開発「staging 内部受入」（切替 runbook 完成）/ Phase 導入
- [db-migrations.md](db-migrations.md): DB マイグレーション適用（SECURITY DEFINER オーナー固定）
- [移行・監査・コンプラ トラック](../testing/tracks/05-migration-audit-compliance.md): 合成 dry-run（MIG）/ Claude・人間境界 §7 / 未決 §8
- [v1-v2-mapping](../architecture/v1-v2-mapping.md) §切替プラン: 何を移植するか（スコープ）
- [F12-v1-port](../requirements/functional/F12-v1-port.md): firmware DNS 段階切替 / 旧 Firebase 停止
- [F15-tv-device-management](../requirements/functional/F15-tv-device-management.md): TV デバイス（LP/Turso → Cloud SQL）
- switchbot-secret-rotation（memory）: SWITCHBOT シークレット rotation の 3 手順
- `incident-response.md`（README に予定・未整備）: 切替中の障害対応
- CLAUDE.md: ルール1（監査）/ ルール2（RLS）/ ルール4（PII）/ ルール5（シークレット）/ ルール8（Terraform）
- [STATUS.md](../STATUS.md) 2026-05-31 判断: cutover 前倒し（staging 完成次第、PoC 終了を待たない）
