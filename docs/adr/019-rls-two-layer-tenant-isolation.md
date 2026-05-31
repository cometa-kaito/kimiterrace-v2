# ADR-019: RLS 二層分離（school_id テナント + system_admin cross-tenant）

- 状態: Accepted（2026-05-31 実装稼働により Proposed → Accepted）
- 日付: 2026-05-28
- 関連: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13), [F11](../requirements/functional/F11-role-management.md), [NFR03](../requirements/non-functional/NFR03-security.md), [v2-mvp.md §7](../requirements/v2-mvp.md), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [CLAUDE.md ルール 2](../../CLAUDE.md)

## 文脈

マルチテナント分離方式を確定する必要がある。本システムは:

- 学校テナント（school_id）が互いに完全分離されるべき（漏洩したらサービス終了）
- ただし system_admin（奥村さんのみ）は全テナント横断のアクセスが必要（CRM, 月次レポート集計）
- CRM 系テーブル（advertisers / contracts / communications）はテナント横断（school_id を持たない）

選択肢:
- アプリ層フィルタ（クエリに `WHERE school_id = ?` を書く）
- PostgreSQL RLS 単層（school_id のみ）
- PostgreSQL RLS 二層（school_id テナント + system_admin cross-tenant policy）
- スキーマ分離（学校ごとに別 schema）
- 物理 DB 分離（学校ごとに別 DB インスタンス）

## 決定

**PostgreSQL RLS 二層分離**を採用する:

### レイヤー 1: テナント分離ポリシー（全 school_id 持ちテーブル）

```sql
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON schedules
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid);
```

### レイヤー 2: system_admin cross-tenant ポリシー

```sql
CREATE POLICY system_admin_full_access ON schedules
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin');
```

### コンテキスト設定

Next.js Route Handler 内でトランザクション開始時に:

```typescript
await db.execute(sql`
  SET LOCAL app.current_user_id = ${userId};
  SET LOCAL app.current_school_id = ${schoolId};
  SET LOCAL app.current_user_role = ${role};
`);
```

### CRM テーブル（school_id を持たない）

RLS 対象外。アプリケーション middleware で system_admin チェック（[ADR-018](018-custom-crm-design.md)）。

### BYPASSRLS

migration 専用ロール (`migrator`) のみ。app/admin ロールには付与しない。

### テスト

- 許可ケース（自 school_id データ可視）
- 拒否ケース（別 school_id データ不可視）
- system_admin（全 school_id 可視）
- 未設定（settings 未セット時はアクセス拒否）
- migration ロール（全件可視、管理用途のみ）

`__tests__/rls/` に Testcontainers で実 PostgreSQL を起動して検証（[ADR-012](012-testing-stack.md)）。

### Policy 命名規約

RLS policy 名は、grep 可能性・migration 追跡性・新規テーブル追加時の判断負荷低減のため、以下の固定セットから選んで一貫使用する（PR #93 / #97 / #99 / #103 で確立、本 ADR で規約化）。新たな命名を発明しない。

| Policy 名 | 適用 FOR | 主用途 | USING / WITH CHECK の典型 |
|---|---|---|---|
| `tenant_isolation` | `FOR ALL` | 通常のテナント分離テーブル（school_id を持つ全テーブル） | `USING (school_id = current_setting('app.current_school_id', true)::uuid)` を `NULLIF(..., '')` でラップ |
| `tenant_self_read` | `FOR SELECT` | `schools` 自身など、自テナント行のみ可視にしたいテーブル | `USING (id = current_setting('app.current_school_id', true)::uuid)` |
| `tenant_isolation_modify` | `FOR UPDATE` | `schools` など、テナント分離下で UPDATE のみ別 policy 化したいテーブル | `USING` 句に同上、`WITH CHECK` で cross-tenant ID 改竄禁止 |
| `tenant_isolation_delete` | `FOR DELETE` | `schools` など、テナント分離下で DELETE のみ別 policy 化したいテーブル | `USING` 句に同上 |
| `system_admin_full_access` | `FOR ALL` | レイヤー 2: system_admin の cross-tenant 全権 | `USING (current_setting('app.current_user_role', true) = 'system_admin')` |
| `system_admin_only` | `FOR ALL` | CRM 系（advertisers / contracts / communications / system_admins）など `school_id` を持たないテーブル、および schoolId nullable で **テナント帰属が解決できない可能性がある** テーブル（例: `sensor_webhook_failures` の `unknown_device` レコード [F13](../requirements/functional/F13-presence-sensor-webhook.md)、`feedback` の匿名フィードバック [F12](../requirements/functional/F12-v1-port.md) #48-M。**`feedback` がこの予約名の初の独立 policy 実装**、[migration 0010](../../packages/db/migrations/0010_feedback_rls.sql)） | `USING (current_setting('app.current_user_role', true) = 'system_admin')`（cross-tenant 版と意味は同じだが、テーブル属性として "system_admin 以外原則アクセスなし" を policy 名で明示） |
| `weather_read_all` | `FOR SELECT` | `weather_forecasts` など **公開・非 PII の cross-tenant 参照マスタ**（school_id を持たず、サイネージ匿名セッション含む全ロールが読んでよいデータ） | `USING (true)` — 読み取りは全開放（漏れても無害な公開データに限る）、書き込みは `weather_write_system` で限定（[F14](../requirements/functional/F14-weather-forecast-signage.md) / [ADR-021](021-weather-data-source-jma.md)） |
| `weather_write_system` | `FOR INSERT/UPDATE/DELETE` | 上記公開参照マスタへの書き込みを system_admin / サービスロール（取得 Job）に限定 | `USING / WITH CHECK (current_setting('app.current_user_role', true) IN ('system_admin', 'system_service'))`（[F14](../requirements/functional/F14-weather-forecast-signage.md)） |
| `audit_log_tenant_read` | `FOR SELECT` | `audit_log` をテナントスコープで読みたい場合 | `USING (school_id = current_setting('app.current_school_id', true)::uuid OR current_setting('app.current_user_role', true) = 'system_admin')` |
| `audit_log_insert` | `FOR INSERT` | `audit_log` 書き込みで **actor_user_id 詐称防止 + テナント内ロールの actor 匿名化封じ** を WITH CHECK で強制 | `WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin' OR actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)` — **テナント内ロール (school_admin / teacher 等) は actor=NULL も拒否**、system_admin のみ NULL / 任意 uuid 許可 (cross-tenant 内部操作 / migrator 経由 INSERT のため必要、[migration 0005](../../packages/db/migrations/0005_audit_log_actor_null_school_admin.sql)) |

#### 適用ルール

1. **追加・変更時は本表を更新する**: 新たな policy 名が必要になった場合、まず本表に行を追加してから migration を書く。CHANGELOG として ADR-019 を更新することで、policy 全体像が ADR 1 本で追跡可能になる
2. **`current_setting(..., true)` は必ず `NULLIF(..., '')` でラップ**: missing_ok モードが空文字列を返して `''::uuid` でキャストエラー → fail-closed が fail-loud に化ける既知バグの再発防止（PR #99 で全 27 箇所修正済）
3. **`tenant_isolation` 系と `system_admin_full_access` は同じテーブル上で共存させる**: PostgreSQL の RLS は OR 結合なので、テナント条件と system_admin 条件のどちらかが true なら可視。アプリ側で `app.current_user_role` をテナントロールに切替えれば一般経路では system_admin policy が発火しない設計
4. **`system_admin_only` は cross-tenant policy ではなく、そのテーブルが system_admin 専用であることを明示する命名**: `system_admin_full_access` と USING 句は同等だが、`tenant_isolation` 系と共存しないテーブルでは `system_admin_only` を使う（CRM、`sensor_webhook_failures` 等）
5. **`audit_log_insert` の WITH CHECK は actor 詐称防止 + 匿名化封じのため必須**: テナント内ロール (school_admin / teacher 等) の `actor_user_id` は SET LOCAL された自分の user_id に完全一致のみ可、NULL も拒否 (NFR04 Repudiation 強化、乗っ取られた school_admin が actor を匿名化して操作痕跡を消す攻撃を policy 層で防止)。system_admin のみ `actor_user_id` NULL / 任意 uuid 許可 — これは cross-tenant 集計 (月次レポート生成等) / migrator 経由 bootstrap INSERT / 内部システムジョブで actor を持たない正当な書き込みのため必要 (migration 0005 / Issue #105 で確立)
6. **公開参照マスタ (`weather_read_all` + `weather_write_system`) は「全ロール SELECT 可・書き込み system のみ」の特例**: school_id を持たず、漏れても無害な**公開・非 PII データ**（天気予報等）に限り、SELECT を `USING (true)` で全開放する。`system_admin_only`（読み書きとも system 限定）とは異なり「読みは全開放・書きのみ閉じる」。**この緩和の適用条件は「school_id を持たない」かつ「公開・非 PII」の両方**であり、school_id を持つ / PII を含むテーブルには絶対に使わない（[F14](../requirements/functional/F14-weather-forecast-signage.md) / [ADR-021](021-weather-data-source-jma.md)、`weather_forecasts` が初出。サービスロール `system_service` は取得 Job 用）
7. **匿名 INSERT は SECURITY DEFINER 関数 1 本に閉じ込める（SELECT 面は policy のまま不変）**: 非認証経路（テナント context も role も持たない）からの書き込みが必要なテーブルは、`system_admin_only`（または `tenant_isolation`）のままにしつつ、**INSERT だけ**を `SET search_path = ''` + 完全修飾 + `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO kimiterrace_app` の SECURITY DEFINER 関数に閉じ込める。所有者は対象テーブルに `FORCE ROW LEVEL SECURITY` を**付けない**ことで RLS をバイパスして 1 行 INSERT でき、通常接続 (`kimiterrace_app` = 非所有者) は policy に従う。初出は `resolve_magic_link`（[migration 0012](../../packages/db/migrations/0012_f05_magic_link_resolve_fn.sql)、F05 匿名 SELECT 1 行）、横展開が `submit_feedback`（[migration 0010](../../packages/db/migrations/0010_feedback_rls.sql)、F12 #48-M 匿名 INSERT 1 行）。**これは §代替E の却下対象ではない**: 代替E が却下したのは「cross-tenant **SELECT** を SECURITY DEFINER で実装し、誤用で越境 SELECT を生む」案。本パターンは関数が SELECT 行を一切返さず INSERT（または有効行 1 件の解決）に限定し、引数で値を受け動的 SQL を持たず、**閲覧面は `system_admin_only` のまま**なので越境 SELECT は構造的に発生しない。新規に SECURITY DEFINER 関数を足す場合は、(a) 返却を最小化（INSERT は id のみ / 解決は最小列）、(b) `FORCE RLS` 不在の確認、(c) `PUBLIC` から EXECUTE 剥奪、(d) migration コメントに「RLS 単独で代替不能な理由（匿名 context）」を明記、の 4 点を必須とする

## 検討した代替案

### 代替 A: アプリ層フィルタのみ
- 却下理由: アプリのバグで `WHERE school_id = ?` が抜けた場合、全テナント漏洩する設計上のリスクが致命的
- 副次理由: [CLAUDE.md ルール 2](../../CLAUDE.md) に明示反対: 「DB レベルで強制する」
- 副次理由: 監査要件（[NFR07](../requirements/non-functional/NFR07-compliance.md)）に対して「アプリ防御のみ」では説明が苦しい

### 代替 B: RLS 単層（system_admin の cross-tenant は別経路）
- 却下理由: system_admin 用に別の管理 DB ロールを用意すると、認可ロジックがアプリ層と DB 層に二重化する
- 副次理由: system_admin 操作も audit_log で追跡したいが、別ロールだとセッション設定がねじれる

### 代替 C: スキーマ分離（学校ごとに別 schema）
- 却下理由: 学校数 100 校規模で schema 数が増加し、migration 運用が破綻
- 副次理由: cross-tenant クエリ（system_admin の月次集計）が UNION ALL の動的生成になり実装複雑化

### 代替 D: 物理 DB 分離（学校ごとに別 Cloud SQL インスタンス）
- 却下理由: コスト膨張（学校数 100 校で Cloud SQL 100 インスタンス）
- 副次理由: 接続プール・migration・バックアップが学校ごとになり運用負荷甚大

### 代替 E: SECURITY DEFINER 関数で cross-tenant 実装
- 却下理由: SECURITY DEFINER は RLS をバイパスする副作用があり、誤用すると意図しないテナント越境
- 副次理由: [CLAUDE.md ルール 2](../../CLAUDE.md) に NG パターンとして明記

## 結果（Consequences）

### 良い影響

- DB レベルでテナント分離が強制され、アプリ層のバグが即漏洩につながらない
- system_admin の cross-tenant 操作も同じ RLS 機構で表現でき、認可ロジックが一元化
- RLS テストが SQL レベルで書けるため、Firestore セキュリティルール時代より検証容易（[CLAUDE.md ルール 2](../../CLAUDE.md)）
- migration ロールに BYPASSRLS を集約することで、特権境界が明確
- [NFR03](../requirements/non-functional/NFR03-security.md), [NFR07](../requirements/non-functional/NFR07-compliance.md) の監査要件に対して「DB レベル強制」と説明可能

### 悪い影響 / リスク

- **`SET LOCAL` の漏れリスク**: トランザクション境界外（コネクションプール再利用）で context が残ると別ユーザーに混入 → middleware で SET LOCAL を必須化、テスト必須
- **`current_setting(..., true)` の `true` 引数**: missing_ok を指定しないと未設定時に ERROR、true だと NULL を返して `school_id = NULL` が False になり結果として拒否 → 拒否がデフォルトになる設計だが、明示テスト必要
- **RLS のパフォーマンス影響**: 大規模テーブルで全クエリに `WHERE school_id = X` が暗黙追加されるためインデックス設計が重要 → school_id を全 RLS テーブルの先頭インデックスに含める
- **CRM テーブルの RLS 対象外問題**: アプリ層 system_admin チェック漏れが全広告主漏洩に直結 → middleware の system_admin チェック必須化、CRM ハンドラ専用 e2e テスト必須

### トレードオフ

- 「アプリ防御 vs DB 防御」のうち **DB 防御** に振った設計
- 「単層シンプル vs 二層柔軟」のうち **二層柔軟** に振った設計（system_admin cross-tenant 要件に対応するため）
- 「物理分離の堅牢性 vs 論理分離のコスト効率」のうち **論理分離のコスト効率** に振った設計
- 将来 ISMAP 要件等で「物理分離必須」が来た場合、本 ADR を Superseded として再評価可能
