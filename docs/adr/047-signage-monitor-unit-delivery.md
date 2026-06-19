# ADR-047: モニタ単位サイネージ配信（device_id 起点・追加モード・クラス継承 ∪ モニタ直指定）

- 状態: Proposed（2026-06-19、Desktop 判断。ユーザーが「device_id 方式で設計確認を省き実装」を明示委任＝Phase5 検討の選択肢(2)）
- 日付: 2026-06-19
- 関連: [#48-F 広告階層マージ VIEW（effective_ads_per_class）](#)、[ADR-016 サイネージ匿名コンテキスト]、[ADR-019 RLS 二層分離]、[ADR-022 TV ポーリング（device_id 解決・pull 型）]、[ADR-042 サイネージ magic-link]、[CLAUDE.md ルール1（監査）/ ルール2（RLS）/ ルール6（小さい PR）]
- 由来: portal `/admin/placements` 刷新 Phase5「配信スコープに加えてモニタを個別選択」。v2-PR1（#1061、`scope='monitor'` + `ad_target_monitors` で K3 に**保存**）に続く**読取（配信）側**の設計。

## 文脈

Phase5 で、広告を学校/学科/学年/クラスの階層スコープに加えて **特定モニタ（端末）に個別指定**できるようにした（v2-PR1 = K3 に `scope='monitor'` の広告と `ad_target_monitors`（広告⇄端末 M:N）を保存）。狙いは、クラスに属さない**廊下・昇降口等の単独モニタ**へ広告を届けること、および特定教室モニタへの**上乗せ**配信。

ところが配信**読取**側を調べると、構造的な不整合が判明した:

- サイネージ表示は **クラス単位**で駆動される。`tv_devices.signage_url` は `/signage/{classToken}` で、`classToken`（magic-link）を `resolveMagicLink` で `{schoolId, classId}` に解決し、広告は `getEffectiveAdsForClass(tx, classId)`（`effective_ads_per_class` view）で**クラスを鍵に**引く（`signage-display.ts`）。
- **表示はどの端末かを知らない**。同一クラスに複数端末があっても `classToken` は同じで区別できず、「その1台だけ」に出せない。
- **クラス無しモニタ（廊下、`class_id=null`）には `classToken` が無い**。現状の class-keyed 表示には乗れず、まさにモニタ直指定が要る対象が表示経路に存在しない。

つまりモニタ直指定を**実際に画面へ出す**には、表示経路を**モニタ識別できる**ように拡張する必要がある（view を足すだけでは不可）。

## 論点と候補

### (1) モニタをどう識別するか（端末→広告の鍵）

| 候補 | 概要 | 評価 |
|---|---|---|
| A. `classToken` に端末 PK（`tv_devices.id`）を付与 | URL に行 PK を載せる | `id` は credential ではない（推測可能な内部 ID）。URL 露出に不向き |
| **B. `signage_url` に端末の `device_id` を載せる（採用）** | TV が初回生成する**推測不能 UUIDv4 = ポーリング解決の秘密鍵**（ADR-022）。プロビジョニング時に `signage_url` に付与し、表示側が `device_id → tv_devices` を解決 | **既存の credential を再利用**（新トークン体系を増やさない）。`device_id` は既に TV だけが持つ秘密。ポーリング(ADR-022)と同じ解決鍵で一貫 |
| C. モニタ専用 magic-link トークンを新設 | 端末ごとに新 token 種別 | token 種別が増え発行・失効・再表示(ADR-042)の運用が二重化。MVP に過剰 |

### (2) クラス配信との合成（置換 vs 上乗せ）

| 候補 | 概要 | 評価 |
|---|---|---|
| A. 置換（モニタ指定時はクラス配信を出さない） | 排他 | 単独モニタには良いが、教室モニタへの「上乗せ」要望に応えられない |
| **B. 追加モード（採用・設計ロック）** | クラス継承 ∪ モニタ直指定。クラス持ち端末は両方、クラス無し端末は直指定のみ | portal 側の設計ロック（追加モード）と一致。最も表現力が高い |

### (3) クラス無しモニタ（廊下）の表示エントリ

現状ビルダー `buildSignagePayloadForClass` は `classId` 必須で、`daily_data` が無いと `null`（不可視扱い）を返す。廊下モニタ（クラス無し）は**広告のみ**を出したい。→ クラス非依存の**モニタ起点ビルダー**（クラス系セクションは空、広告はモニタ直指定）を別途用意する（本 ADR の v2-PR3 で実装）。

## 決定

**(1) device_id 起点（候補 B）/ (2) 追加モード（候補 B）** を採用する。実装は**段階化**する（ルール6・本番生徒データ repo ゆえ検証可能な単位で積む）:

- **v2-PR2（本コミット）= 読取プリミティブ**: `getEffectiveAdsForMonitor(db, classId, monitorId)` を `packages/db/src/queries/effective-ads.ts` に追加。
  - **クラス継承**（`classId` があれば `effective_ads_per_class` view 由来。無ければ空集合＝廊下）∪ **モニタ直指定**（`ads ⋈ ad_target_monitors WHERE monitor_id = monitorId`、`scope='monitor'`）を**統一型 `EffectiveAdForMonitor`**（`EffectiveAd` から `classId` を除いた形）に合成。
  - **並び順**: `(scope_rank, display_order, ad_id)`。モニタ直指定は `scope_rank=4`（class=3 の後＝最も具体的）。
  - **休止広告主の除外を整合**: クラス継承は view が `advertiser_is_deliverable()`（SECURITY DEFINER・migrations/0026）で paused を落とす。モニタ直指定は view を通らないため、配信ロールから不可視な `advertisers` を直接 JOIN せず**同じ関数**で status だけ判定する（`advertiser_id=NULL` は配信対象）。BUG-1 と同方針。
  - **RLS（ルール2）**: view は `security_invoker`、`ads`/`ad_target_monitors` は `tenant_isolation`。呼び出し接続の `app.current_school_id` で DB レベルに限定され、**他校端末の monitorId / 他校 classId を渡しても 0 件**（越境配信を構造的に防ぐ）。実 PG + RLS テストで pin（`__tests__/rls/effective-ads-monitor.test.ts`）。

- **v2-PR3（後続）= 表示・ルート配線**:
  - `device_id` で `{schoolId, classId|null, monitorId}` を解決するヘルパ（ADR-022 `pollTvConfig` と同じ system_admin context での cross-tenant 解決→当該 school の tenant context で表示組立）。
  - クラス非依存のモニタ起点ビルダー（廊下対応。クラス系セクションは空、広告は `getEffectiveAdsForMonitor`）。
  - `/signage` ルートが `device_id`（`signage_url` のクエリ）を任意で受ける（**後方互換**: 無指定＝従来のクラス専用表示）。

- **プロビジョニング（portal/firmware 側・後続）**: モニタの `signage_url` に当該端末の `device_id` を付与。これにより既設のクラス専用端末は無改修で従来どおり、モニタ指定対象の端末だけが直指定を受け取る。

## 影響

- **良い影響**: 廊下等クラス無しモニタへ配信可能になる。教室モニタへの上乗せも可能。新トークン体系・新 Job を増やさず（device_id 再利用）、RLS の越境防止をプリミティブ層で担保。段階化で各 PR が CI 検証可能。
- **コスト/リスク**: 表示が 1 端末あたり最大 2 クエリ（クラス view + モニタ直指定）に増えるが、いずれも index 等価結合で安価（NFR01 内）。`device_id` を URL に載せるため、ポーリング鍵と同じ秘匿規律（ログ非出力・credential 扱い）を表示経路にも適用する。
- **却下案の含意**: 行 PK 露出（A）/ 新トークン（C）/ 置換合成（(2)A）は上記のとおり不採用。Google 連携同等の重い認証は本件に無関係。

## 検証

- v2-PR2: `pnpm --filter @kimiterrace/db test`（実 PG・RLS）で合成順序・追加モード・廊下（classId=null）・休止広告主除外・越境 0 件を pin。`tsc`/`biome` 緑。
- v2-PR3 以降: 表示ビルダー・ルートの単体/結合テスト、実機での廊下モニタ配信 E2E。
