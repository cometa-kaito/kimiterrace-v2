# OSS ライセンス台帳（同梱再配布アセット）

リポジトリに **バイナリとして同梱し再配布する** サードパーティ OSS アセット（フォント等）のライセンス管理表。
公立校調達審査でライセンス遵守を立証するための一次記録。

> 注: npm 依存パッケージのライセンスは `pnpm-lock.yaml` + CI の Dependency Review が一次ソース。
> 本表は **コードでなくバイナリ資産として直接コミットしているもの**（ソース追跡外）を対象とする。

| コンポーネント | バージョン | ライセンス | 出典 | 同梱パス | ライセンス本文 | 用途 |
|---|---|---|---|---|---|---|
| Noto Sans JP (Regular) | Source Han Sans 系 | SIL OFL 1.1 | https://github.com/notofonts/noto-cjk (Sans) | `apps/jobs/src/reports/../../assets/fonts/NotoSansJP-Regular.otf` | `apps/jobs/assets/fonts/OFL.txt` | F09 月次レポート PDF の日本語グリフ埋め込み（#45） |

## 遵守メモ

- **SIL OFL 1.1**: Font Software の再配布時にライセンス本文の同梱が必須（§ 条件）。本リポジトリでは
  フォントと同じディレクトリに `OFL.txt`（Copyright 表記・出典 URL・OFL 1.1 全文）を併置して充足する。
  フォント名を「Reserved Font Name」として改変配布しない限り商用同梱可。
- 新たに OSS バイナリ資産を同梱する際は、本表に行を追加し、ライセンス本文を同梱パスに併置すること。
