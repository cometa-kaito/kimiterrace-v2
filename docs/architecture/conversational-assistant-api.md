# 会話型 AI アシスタント API 契約（学校エディタ）

- 対象: 学校体験リニューアル（2026-06-13）AI レーン ⇄ UI レーン の調整契約
- 正本（型）: [`apps/web/lib/editor/assistant-chat-core.ts`](../../apps/web/lib/editor/assistant-chat-core.ts)（**こちらが単一ソース**。本 doc は人間向け要約）
- 関連: ADR-030（PII soft-gate）/ ADR-033（構造化ドラフト UX）/ ADR-036（おまかせ分類）/ ADR-034（来校者・呼び出しの個人名）/ finding 2b（会話型 UX 作り直し）

> UI shell（チャット・コンポーザ・音声ボタン・下書きカード・盤面プレビュー）はこの契約に対して描画する。
> バックエンド SSE は `assistant-chat-sse.ts` + route `POST /api/editor/assistant/chat`（PR③ で実装）。

## エンドポイント

```
POST /api/editor/assistant/chat?scope=class&targetId=<uuid>
```

- 編集対象（scope / targetId）は **クエリ**で渡す（school は targetId 不要）。`notice-draft` route と同方針。
- 認証/role gate（`EDITOR_ROLES` = teacher / school_admin）・actor 解決は route の責務。未認証 401 / role 不足 403 /
  target 不正 400 は **200 SSE を開く前に JSON** で返す。
- **許可セクションはサーバが学校/端末の実効パターンから解決**する（リクエストに含めない＝クライアントを信用しない）。

## リクエストボディ（`AssistantChatRequestBody`）

```ts
{
  messages: ChatTurn[];      // 会話履歴。末尾は必ず user（このターンの指示）。直近 24 ターンに制限。
  draft?: AssistantDraft;    // 現在の作業下書き。自然言語修正（「2限を英語に」）の文脈。省略時は空から生成。
  acknowledgePii?: boolean;  // ADR-030 soft-gate の override（氏名らしき語の警告を承知で送信）。
}

type ChatTurn = { role: "user" | "assistant"; content: string }; // content 1..4000 文字
type AssistantDraft = { schedules: ScheduleItem[]; notices: NoticeItem[]; assignments: AssignmentItem[] };
```

- `ScheduleItem` / `NoticeItem` / `AssignmentItem` は既存の検証済み型（schedule-core / notice-assignment-core）を再利用。
- **来校者(visitor)/呼び出し(callout) は本下書き型に含めない**（ADR-034 決定3/5: 氏名を Vertex に送らない・AI 自動生成しない）。
  pattern2 では会話型 AI は `schedules` のみ提案し、来校者/呼び出しは「下の手入力フォームで追加」と誘導する。

## SSE レスポンス（`text/event-stream`・1 ターン分）

| event | data | 意味 |
|---|---|---|
| `meta` | `{ pattern, allowedSections }` | ターン開始時 1 回。実効パターンと許可セクション（UI が文脈把握）。 |
| `message` | `{ delta }` | AI 会話応答（prose）の差分。逐次 append でスレッド表示。 |
| `draft` | `AssistantDraft` | 構造化下書きの**現在スナップショット**（許可セクションのみ）。最新で置換描画。 |
| `error` | `{ status, reason, suspectedSurfaces?, message? }` | 拒否（下記）。入力・完成カードは保持。 |
| `done` | `{ draft }` | 確定スナップショット。これを「反映」確認 UI に渡す。 |

`reason`: `pii_warning`（`suspectedSurfaces` 付き）/ `rate_limited` / `pii_leak` / `no_result` / `stream_failed` / `invalid` / `empty` / `too_long`。

### フレーム順序（典型）

```
meta → (message delta)* → (draft snapshot)* → done
```

エラー時は `meta` の後（または前）に `error` を 1 つ送って終了する。`pii_warning` は 200 開始後にインライン表示し、
ユーザーが「送信してよい」を選んだら `acknowledgePii: true` で再送する（入力・下書きは UI 側で保持）。

## クライアント実装メモ（UI レーン向け）

- 送信＝「現在の `messages` ＋ 新しい user ターン」を POST。応答の `message` を assistant ターンとしてスレッドに積み、
  `draft` を下書きカードに反映、`done` で「反映していい？」確定ボタンを活性化。
- **反映（保存）は本エンドポイントではなく既存の per-section save action**（`setScheduleAction` /
  `setNoticesAction` / `setAssignmentsAction`、ADR-036 決定3）で行う。本エンドポイントは下書きのみ（保存しない）。
- 盤面プレビュー内蔵（finding 2b (c)）は `draft`（許可セクションのみ）をパターン単一ソースの描画に渡す
  （その他レーンの `PATTERN_BLOCKS` 確定後に同源描画）。

## 未確定（着地待ち）

- **許可セクションの解決**: pattern→ブロックの単一ソース（その他レーン `PATTERN_BLOCKS`）を consume して
  `allowedSections` を決める。未着地の間はサーバ既定（pattern1=`[schedules,notices,assignments]` /
  pattern2=`[schedules]`）の暫定マップで駆動し、確定後に差し替える（lane 調整ポイント1）。
- **来校者/呼び出しの AI 生成可否**: ADR-034 改訂が前提（PR④・要ユーザー最終確認）。改訂されるまで本契約の下書き型は 3 セクション固定。
