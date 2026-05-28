# NFR05: アクセシビリティ (WCAG 2.2 AA)

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §5 から分割）
- 関連 ADR: ADR-008 (Next.js Route Handlers)
- 関連 issue: [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13)

## 概要

公立校は障害のある生徒・教員が在籍する。アクセシビリティは法的要件であり倫理的要件でもある。**WCAG 2.2 AA** を最低基準とする。

## 受け入れ条件

### 基本

- [ ] WCAG 2.2 Level AA 準拠
- [ ] スクリーンリーダー対応（aria-* 属性、セマンティック HTML）
- [ ] カラーコントラスト比 4.5:1 以上（テキスト）/ 3:1 以上（UI コンポーネント）
- [ ] キーボード操作のみで全機能利用可（tab 順序、フォーカス可視化）
- [ ] 色だけに依存しない情報伝達（凡例にラベル、警告にアイコン）

### 生徒 UI 特有

- [ ] 片手スマホ操作前提（タップ領域 44pt 以上）
- [ ] 縦持ち / 横持ち両対応
- [ ] 音声入力（[F06](../functional/F06-student-qa.md)）は読み上げ困難な生徒にも利用可

### サイネージ表示

- [ ] フォントサイズ最小 24px（教室後方からの視認性）
- [ ] アニメーションは prefers-reduced-motion 尊重

### テスト

- [ ] axe-core を CI に組み込み
- [ ] Playwright E2E に accessibility checks を含める
- [ ] 手動レビュー（NVDA / VoiceOver）を Phase 開発後半に実施

## 関連

- UI: [F01](../functional/F01-teacher-file-extraction.md)〜[F12](../functional/F12-v1-port.md) 全機能
- テスト: `__tests__/a11y/`
- 参考: [WCAG 2.2 quick reference](https://www.w3.org/WAI/WCAG22/quickref/)
