# `drizzle/` — スキーマ DDL マイグレーションと drizzle メタの規約

このディレクトリは Drizzle が生成する **スキーマ DDL**（テーブル / 列 / index / FK / enum）と、
その差分計算に使う **メタ情報**（`meta/_journal.json` + `meta/*_snapshot.json`）を持つ。

> RLS policy / 監査トリガ / `SECURITY DEFINER` 関数 / VIEW は **drizzle では表現できない**ため、
> 別ディレクトリ `packages/db/migrations/*.sql` に手書きで置く。`drizzle/` はあくまで素の DDL のみ。

---

## 適用経路：`drizzle-kit migrate` は使わない

マイグレーションの適用は **`__tests__/_setup/global-setup.ts` の loader** が唯一の正とする。
loader は `drizzle/*.sql` と `migrations/*.sql` を**依存順に手で並べて**流す（例：テーブル作成 →
RLS 有効化 → policy → 監査 FK → VIEW → 関数）。`drizzle-kit migrate` はこの interleave を再現できない
（drizzle の journal は `migrations/` 側を知らない）。

→ **drizzle の journal / snapshot は `drizzle-kit generate`（＝次の差分計算）専用のメタ**であり、
適用順の正本ではない。

---

## 規約

1. **ファイル名 ⇔ journal tag は 1:1**。`drizzle/000N_<tag>.sql` の `<tag>`（拡張子なし）が
   `meta/_journal.json` の `idx:N` エントリの `tag` と一致する。
2. **head snapshot ＝ 現行 TS スキーマ**。最大 idx の `meta/000N_snapshot.json` は
   `src/schema/*.ts` から生成されるスキーマと一致していなければならない。一致していれば
   `drizzle-kit generate` は「No schema changes」で何も吐かない。
3. **`meta/` は biome 対象外**（`biome.json` の `files.ignore`）。drizzle が生成する JSON は
   `pnpm-lock.yaml` 同様の生成物で、biome の整形と composite FK の配列表現が衝突するため。
4. **型の単一ソースは `src/schema/*.ts`**（CLAUDE.md ルール3）。SQL を手書きした場合も
   schema TS を必ず同じ形に更新する。

---

## スキーマを変えるときの手順

1. `src/schema/*.ts` を編集（単一ソース）。
2. `pnpm --filter @kimiterrace/db generate` を流す。drizzle が次番 `000M_<乱数>.sql` +
   `meta/000M_snapshot.json` + journal エントリを生成する。
3. `.sql` ファイル名と journal の `tag` を意味のある名前にリネーム（`<乱数>` を置換）。
4. **loader に登録**：`__tests__/_setup/global-setup.ts` に `000M_*.sql` を依存順の正しい位置で
   追加する（忘れると新テストだけ CI で落ちる、[[migration-loader-pattern]] / PR #110）。
5. `pnpm --filter @kimiterrace/db generate` を再度流し「No schema changes」を確認。

### drizzle で表現できない DDL（composite FK / 部分 UNIQUE index / RLS など）を足すとき

drizzle-kit が吐けない構文は **`drizzle/000M_*.sql` を手書き**し loader に登録する。ただしこのとき
schema TS を更新しただけだと drizzle メタが古いまま残り、以後の `generate` が「手書きした分」を
毎回差分として吐く（= #195 のドリフト）。そのため手書き後は必ず **head snapshot を取り直す**：

```sh
pnpm --filter @kimiterrace/db generate   # 現行スキーマの snapshot を生成させる
# → 生成された catch-up .sql は破棄（loader が手書き .sql を使うため不要）
# → 生成された meta/000M_snapshot.json を head として採用（journal の最大 idx 用にリネーム）
```

最後に `generate` が「No schema changes」、`drizzle-kit check` が「Everything's fine」になることを確認する。

---

## #195 リシンク時のメモ（2026-05-31）

`0004`〜`0009`（F02 teacher_inputs / content_versions 等の UNIQUE / #73 composite FK 群 /
#214 schools.hierarchy_mode）は drizzle メタを通さず手書きで足されたため、journal が `0003` で
止まり `generate` が毎回それらを差分として吐いていた。本 PR で **journal を idx 0–9（実ファイルと
1:1）に揃え、head（`0009`）snapshot を現行スキーマで取り直した**。

- snapshot は `0000`〜`0003`（drizzle generate era）+ `0008`（post-composite-FK の実状態）+
  `0009`（現行 = head）を置く。**中間 `0004`〜`0007` は意図的に置かない**：これらは手書き raw SQL
  であり、実在しない drizzle 生成チェックポイントを捏造しないため。`generate` は head のみ、`check`
  は存在する snapshot 連鎖（`0003`→`0008`→`0009`）のみを見るので両者とも通る（検証済）。
- 次回 `generate` は idx 10 ＝ `0010_*.sql` を吐くので loader の `0000`–`0009` と番号衝突しない。
- journal の `when` のうち idx 4–9 は実際の作成時刻ではなく単調増加のプレースホルダ値
  （`generate`/`check`/`migrate` は idx 順で動作し `when` は表示用のため挙動に影響しない）。
