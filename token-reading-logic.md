# トークン読み取りロジック

tokenmaxxing は以下の 10 種類の AI エージェント・CLI ツールから LLM トークン使用量を読み取る。

- **外部ツール** (ccusage@^20 経由): Claude, Codex, OpenCode, Gemini, Copilot
- **ローカルリーダー** (直接ファイル読み取り): OMP, ZCode, Reasonix, OpenGrok, DSH

全ソースとも、読み取ったデータは内部で `(date, model, source)` をキーとする行に集約され、API に同期される。同期後は 1 行 = `UsageDayInput { date, source, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, costUsd }` として D1 に upsert される。

---

## 共通: 実行方式

`tokenmaxxing sync` がソースごとに以下のどちらかでデータを取得する:

### 外部ツール (ccusage@^20)

`bunx ccusage@^20 <subcommand> daily --json --breakdown --mode calculate`

- `--mode calculate`: 全トークンを最新の API 一覧価格で再計算する（サブスクリプションで実コストが $0 になるケースに対応）
- **ステージ先の固定**: 子プロセスの `TMPDIR` を `~/.cache/tokenmaxxing/staging` に固定する。既定の `/tmp` はクォータ付き tmpfs であることが、展開が中断されると中途半端なツリーが残って **次回 bunx がそれを再利用して SIGSEGV で落ちる**（再展開しない）。`/tmp` から切り離すことでこの連鎖を断つ
- **ランナーフォールバック**: `bunx ccusage@^20` を先に試し、失敗したら `npx -y ccusage@^20` を試す。npx は `~/.npm` にステージするため影響を受けない。成功判定は「stdout が空でない」かつ「`daily` 配列を持つ JSON がパースできる」こと（exit code 0 でも空 stdout がありうる）
- タイムアウト: 180 秒
- 失敗しても他のソースの同期は継続する

### ローカルリーダー

該当ソースのローカルファイルを直接読み取る（後述）。

---

## ソース別詳細

### 1. Claude (`ccusage claude daily`)

**対応ソフト**: [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview)

**データ取得方式**: 外部ツール

**出力形式**: `modelBreakdowns[]` + `totalCost`

```jsonc
// cusage が出力する各日の構造（抜粋）
{
  "date": "2026-07-14",
  "totalCost": 1.23,
  "costUSD": 1.23,
  "modelBreakdowns": [
    {
      "modelName": "claude-sonnet-5",
      "inputTokens": 1000,
      "outputTokens": 500,
      "cacheCreationTokens": 0,
      "cacheReadTokens": 200,
      "cost": 0.50  // ← モデルごとに内訳あり
    }
  ]
}
```

**コスト**: あり（ccusage がモデル別に計算）

### 2. Codex (`ccusage codex daily`)

**対応ソフト**: [OpenAI Codex CLI](https://github.com/openai/codex)

**データ取得方式**: 外部ツール

**出力形式**: `models{}` + `costUSD`

```jsonc
{
  "date": "2026-07-14",
  "costUSD": 0.75,
  "models": {
    "gpt-5": {
      "inputTokens": 2000,
      "outputTokens": 300,
      "cacheReadTokens": 0,
      "cacheCreationTokens": 0,
      "totalTokens": 2300
      // ← モデルごとの cost なし
    }
  }
}
```

**コスト**: あり（日単位の `costUSD` をトークン加重でモデル按分）

### 3. OpenCode (`ccusage opencode daily`)

**対応ソフト**: [OpenCode CLI](https://opencode.ai)

**データ取得方式**: 外部ツール

**出力形式**: `totalCost` + `modelsUsed[]`

```jsonc
{
  "date": "2026-07-14",
  "totalCost": 0.32,
  "totalTokens": 5000,
  "inputTokens": 4000,
  "outputTokens": 1000,
  "modelsUsed": ["gpt-5"]  // ← 1 要素ならそのモデル、複数時は "unknown"
  // ← モデルごとの内訳なし
}
```

**コスト**: あり（日単位の `totalCost` のみ；単一モデル時のみそのモデルに割当、複数時は `unknown`）

### 4. Gemini (`ccusage gemini daily`)

**対応ソフト**: [Google Gemini CLI](https://cloud.google.com/vertex-ai/generative-ai/docs/gemini-cli)

**データ取得方式**: 外部ツール

**出力形式**: Codex と同様（`models{}` + `costUSD`）

**コスト**: あり

### 5. Copilot (`ccusage copilot daily`)

**対応ソフト**: [GitHub Copilot CLI](https://github.com/github-community/gh-copilot)

**データ取得方式**: 外部ツール

**出力形式**: Codex と同様（`models{}` + `costUSD`）

**コスト**: あり

### 6. OMP (Oh My Pi) — ローカルリーダー

**対応ソフト**: [Oh My Pi](https://github.com/oh-my-pi)

**データ取得方式**: 直接ファイル読み取り

**読み取り元**: `~/.omp/agent/sessions/**/*.jsonl`

**パース方法**:

1. `collectJsonlFiles()` で再帰的に全 `.jsonl` ファイルを収集
2. `parseOmpSessionFile()` で各行を JSON パース:
  - `type === "model_change"` → カレントモデルを更新
  - `type === "message" && role === "assistant"` → usage フィールドから抽出
3. 各アシスタントターンから抽出するフィールド:


| フィールド            | JSON パス                                     | 備考            |
| ---------------- | ------------------------------------------- | ------------- |
| date             | `timestamp` の先頭 10 文字 (YYYY-MM-DD)          | ISO タイムスタンプから |
| model            | `message.model` → 追跡中のカレントモデル → `"unknown"` | プロバイダ接頭辞除去あり  |
| inputTokens      | `usage.input`                               |               |
| outputTokens     | `usage.output`                              |               |
| cacheReadTokens  | `usage.cacheRead`                           |               |
| cacheWriteTokens | `usage.cacheWrite`                          |               |
| costUsd          | `usage.cost.total`                          | 実際の API 費用    |


**コスト**: あり（各メッセージに実際の cost.total が記録されている）

**モデル名正規化**: `openrouter/`, `opencode-zen/`, `anthropic/`, `google/`, `openai/` の接頭辞を除去

### 7. ZCode — ローカルリーダー

**対応ソフト**: [ZCode CLI](https://zcode.ai)

**データ取得方式**: 直接 SQLite 読み取り（`bun:sqlite`）

**読み取り元**: `~/.zcode/cli/db/db.sqlite`

**クエリ**:

```sql
SELECT model_id, started_at, input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens
FROM model_usage
```

**パース方法**:

- `model_usage` テーブルから全行を取得
- `started_at` (epoch ms) から日付 (YYYY-MM-DD) を算出
- モデルごとに 1 日に集約

**コスト**:なし

### 8. Reasonix — ローカルリーダー

**対応ソフト**: Reasonix (推論特化 AI エージェント)

**データ取得方式**: 直接 JSON ファイル読み取り

**読み取り元**: `%APPDATA%/reasonix/projects/<project>/sessions/*.telemetry.json`

**ファイル名形式**: `YYYYMMDD-HHMMSS.<uniqueId>-<model-name>.jsonl.telemetry.json`

**パース方法**:

1. `%APPDATA%/reasonix/projects/` 下の全プロジェクトディレクトリを走査
2. 各プロジェクトの `sessions/` 内の `*.telemetry.json` ファイルを収集
3. ファイル名から日付とモデル名を抽出:
  - 日付: `YYYYMMDD-` プレフィックス → `YYYY-MM-DD`
  - モデル: `<uniqueId>-<model>.jsonl` の `<model>` 部分、ハイフンをスラッシュに変換
4. 各 telemetry JSON の `usage` オブジェクトから抽出:


| フィールド           | JSON パス                                                 |
| --------------- | ------------------------------------------------------- |
| inputTokens     | `usage.promptTokens`                                    |
| outputTokens    | `usage.completionTokens`                                |
| totalTokens     | `usage.totalTokens`                                     |
| cacheHitTokens  | `usage.cacheHitTokens`                                  |
| cacheMissTokens | `usage.cacheMissTokens`                                 |
| costUsd         | `usage.sessionCostUsd` → `usage.sessionCost` の順でフォールバック |


5. `usage.totalTokens` がない行はスキップ

### 9. OpenGrok — ローカルリーダー

**対応ソフト**: [Open Grok](https://github.com/mweinbach/open-grok)

**データ取得方式**: 直接 JSON ファイル読み取り

**読み取り元**: `$OPENGROK_HOME/sessions/**/usage.json`（未設定時は `~/.opengrok/sessions/**/usage.json`）

**パース方法**:

- セッションの累積 `session` ではなく、重複計上を避けるため `turns[]` を読む
- `endedAt` の日付を `YYYY-MM-DD` に変換する
- `modelUsage` のモデル別内訳を `(date, model, source)` ごとに集約する
- モデル内訳がないターンは `primaryModelId`、セッションの `primaryModelId`、`unknown` の順で補完する
- `reasoningTokens` は `outputTokens` に含める
- `totalTokens` は input、output、reasoning、cached read、cache creation の合計
- **注意**: OpenGrok の `inputTokens` は Responses ワイヤ仕様で `cachedReadTokens` を**含む**（OpenGrok 自身の `totalTokens` は input+output）。他ソースはキャッシュ読み出しを独立した加算バケットとして報告するため、`inputTokens` から `cachedReadTokens` を引いて正規化する（未補正だと二重計上になる）

**コスト**: なし（OpenGrokのコスト情報は表示に使用しない）

---

### 10. DSH (DeepSeek Harness) — ローカルリーダー

**対応ソフト**: DeepSeek Harness（`dsh`）

**データ取得方式**: 直接 JSON ファイル読み取り（+ 古いセッションのみイベントログ）

**読み取り元**: `$DSH_HOME/storages/session_projcache/sessions/*.json`（未設定時は `~/.dsh`）

**パース方法**:

- ハーネス自身が保持する投影キャッシュの `record.rows.tokenUsage.val.totals` を使う（`/cost` と同じ値）
- イベントログの usage チャンクは一部ステップしか記録しないため**合計には使わない**
- 日付は `sessionListMetadata.val.lastPromptAt`、無ければ `identity.createdAt`
- モデルは `modelSelection.val.lastUsed.model`。この行を持たない古いセッションのみ `~/.dsh/sessions/**/session*.zstd` を `zstd -dc` で展開し、最後の `request/context` の `model` を使う
- subagent セッションは投影キャッシュに現れず、親の合計に畳み込まれているため加算しない（二重計上防止）

| フィールド | JSON パス |
| ---------- | --------- |
| inputTokens | `uncachedInputTokens` |
| outputTokens | `outputTokens` |
| cacheReadTokens | `cacheReadTokens` |
| cacheCreationTokens | `cacheWriteTokens` |

**コスト**: なし

---

## 集約 (`aggregate.ts`)

## 集約 (`aggregate.ts`)

全ソースの日次レポートは `aggregateDays(source, days)` で統一フォーマットに変換される。3 種類の出力方言を統一的に扱う:


| 方言                  | 該当ソース                   | 構造               | コスト按分                                       |
| ------------------- | ----------------------- | ---------------- | ------------------------------------------- |
| `modelBreakdowns[]` | Claude, ZCode, Reasonix | モデル別にコスト内訳あり     | そのまま使用                                      |
| `models{}`          | Codex, Gemini, Copilot  | モデル別トークン数（コストなし） | 日コストをトークン加重で按分                              |
| モデル内訳なし             | OpenCode                | 日単位のトータルのみ       | `modelsUsed` が 1 要素ならそのモデル、複数時は `"unknown"` |


同一 `(date, model)` の行は常に合算される。

---

## 外部ツール (ccusage) との API

`runner.ts` が `execFile("bunx", ...)` で cusage に shell out する。

- **使用パッケージ**: `ccusage@^20`
- **サブコマンド**: `<source> daily` / `<source> session`
- **共通フラグ**: `--json --breakdown --mode calculate`
- **セッションカウント**: `--mode calculate` の session レポート（失敗しても daily の同期は継続）
- **フォールバック**: `bunx` が失敗した場合（ENOENT 以外も含む）→ `npx -y ccusage@^20` を試す。成功判定は「stdout が空でない」かつ「`daily` 配列を持つ JSON がパースできる」こと（exit code 0 でも空 stdout あり）
- **バッファ**: 256 MB（巨大なデータに対応）
- **応答圧縮**: `/api/*` の JSON はクライアントが `Accept-Encoding` で brotli / gzip を求めていれば圧縮する。レコードが 4 万行を超えると平文で 7.6MB になり、リモート（tailnet 経由のスマホ等）では転送が途中で切れることがある。実測で brotli 602KB / gzip 669KB（ 約12倍）。1KB 未満は圧縮しない。圧縮は `res.send` ではなく `stream.pipe(res)` で行う（Express は object を `res.json` に戻すため、`res.send(stream)` を上書きすると再帰して `Maximum call stack size exceeded` になる）
- **エラー処理**: 全ランナーが失敗 → `Option.none`（該当ソースをスキップ、他ソースに影響なし）。このときは.codex / opencode / claude / gemini / copilot / pi の 6 ソースが同時に失われるため、警告ログで明示する

---

## キャッシュヒット率

プロンプト側トークンのうちキャッシュから供給された割合として定義する:

```
cacheHitRate = cacheReadTokens / (inputTokens + cacheReadTokens)
```

- 分母が 0 の場合（プロンプト側トークンがない）は `—` と表示する
- 全ソースで `inputTokens` と `cacheReadTokens` は独立した加算バケットとして正規化されている（OpenGrok のみ補正あり）ため、この式が全ソースで同じ意味になる
- 表示箇所は 2 つのみ:
  - **Harness**: ソース名の下に `cache 97.2%`（トークン数の下に小文字で併記、总量的にはここが主指標）
  - **Model Breakdown**: `Cache` 列（列見出し付き。`Share` は従来どおり取得全期間に対する割合）

## グラフの表示範囲

- 既定は **直近 30 日**。カーソルで棒を狙いやすくするため、履歴が 30 日より短い場合も **最小 7 日** まで左に拡張する
- 履歴が 7 日未満なら履歴全体を 7 日へ引き伸ばす（バーが疎にならないように）
- `ALL` で全期間をプロット
- 範囲は `chartRange`（`'30d'` / `'all'`）で保持し、`chartWindow()` が実ウィンドウ、`makeCalendarBuckets(daily, from, to)` がバケット列を生成する
- 凡例の日 MODEL 割合は**表示中のウィンドウ合計**に対する割合（グラフと凡例が一致するように）
- 範囲切替時は固定中（pin）のポップアップを解除する

---

**ポイント**: 各ポイントはトークン内訳（`input` / `output` / `cacheRead` / `cacheCreation` と合計）を持つ。クライアントの期間フィルタはこのバケット単位で行うため、日付もモデルもハーネスも、期間で切り替えても再集計不要である。

## 期間フィルタ（DeepSeek Platform 風）

- 統計バー上の `7D / 30D / 90D / ALL / CUSTOM` が統計カード・Harness・Model Breakdown・フッター範囲に効く
- 日別グラフ（30D / ALL）は独立して動く。期間フィルタの影響を受けない
- プリセットは快取の最終日から遡る N 日間。CUSTOM は自前カレンダー（入力欄下 5px）か直接入力で from/to を指定
- 選択は `localStorage` に保存され、再訪時に復元される
- モデル内訳の `Share` は選択期間内合計に対する割合。`Cache` は選択期間の `cacheRead / (input + cacheRead)`

---

## 配信（API とキャッシュ）


クライアントは**生レコードを受け取らない**。サーバが `(date, source, model)` で集約した要約だけを返す。

```text
GET /api/dashboard          → 要約スナップショット（200）
GET /api/refresh            → 同期待ちで再生成して返す（手動用）
```

要約の形:

```jsonc
{
  "generatedAt": "ISO",
  "totals": { "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0 },
  "sessions": 0, "activeDays": 0, "topModel": "…", "topModelTokens": 0,
  "firstDate": "YYYY-MM-DD", "lastDate": "YYYY-MM-DD",
  "currentStreak": 0, "longestStreak": 0,
  "sources": [ { "source": "codex", "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0 } ],
  "models":  [ { "model": "gpt-5.6-luna", "source": "codex", "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0 } ],
  "daily":   [ { "date": "YYYY-MM-DD", "points": [ { "source": "codex", "model": "gpt-5.6-luna", "tokens": 0 } ] } ]
}
```

- `models` は `(source, model)` 単位。クライアントはハーネス絞り込みをこの行のフィルタで行うので、ソースを隠しても内訳が正しく引き算される
- `daily[].points` も `(source, model)` 単位。日別グラフのソース絞り込みに必要
- 実測（93日 / 33モデル行 / 188ポイント）: **20,284 バイト**、brotli で **2,862 バイト**。旧構成は 7,646,984 バイト（brotli 602,473）だったので約 380 分の 1

### 再生成は子プロセス + キャッシュファイル

集約は数百ファイルの同期読みと ccusage の spawn で **6〜18 秒**かかり、その間イベントループを占有する。そのため:

- `server/refresh-dashboard.js` を**子プロセス**で起動して集約させる（HTTP は一切ブロックされない）
- 結果は `~/.cache/tokenmaxxing/dashboard.json` に**原子的に**書く（`tmp` → `rename`）
- `server/index.js` はメモリ上のスナップショットを返すだけ。TTL (`REFRESH_INTERVAL_MS`, 既定 60s) を過ぎていたら返しつつ裏で再生成を開始する（stale-while-revalidate）
- 起動時はキャッシュを読んで**即座に配信**し、再生成は背景で走らせる。キャッシュが無い初回だけは生成完了まで待つ（503 を返してクライアントが再試行する）

実測: キャッシュありの起動では再生成中でも **1.5〜7ms** で応答。キャッシュ無しの初回のみ数秒待つ。

---

## ストレージ (D1)

集約後のデータは Cloudflare D1 の `usage_days` テーブルに upsert される:

```sql
CREATE TABLE usage_days (
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,       -- YYYY-MM-DD
  source TEXT NOT NULL,     -- claude|codex|opencode|gemini|copilot|omp|zcode|reasonix
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  total_cost REAL NOT NULL,
  synced_at TEXT NOT NULL,  -- ISO 8601
  PRIMARY KEY (device_id, date, source, model)
);
```

同期はべき等: 同じ `(device_id, date, source, model)` に対しては upsert される。