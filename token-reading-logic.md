# トークン読み取りロジック

tokenmaxxing は以下の 8 種類の AI エージェント・CLI ツールから LLM トークン使用量を読み取る。

- **外部ツール** (ccusage@^20 経由): Claude, Codex, OpenCode, Gemini, Copilot
- **ローカルリーダー** (直接ファイル読み込み): OMP, ZCode, Reasonix

全ソースとも、読み取ったデータは内部で `(date, model, source)` をキーとする行に集約され、API に同期される。同期後は 1 行 = `UsageDayInput { date, source, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, costUsd }` として D1 に upsert される。

---

## 共通: 実行方式

`tokenmaxxing sync` がソースごとに以下のどちらかでデータを取得する:

### 外部ツール (ccusage@^20)

`bunx ccusage@^20 <subcommand> daily --json --breakdown --mode calculate`

- `--mode calculate`: 全トークンを最新の API 一覧価格で再計算する（サブスクリプションで実コストが $0 になるケースに対応）
- `bunx` がない場合は `npx -y cusage@^20` にフォールバック
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

### 9. OpenCode2 — ローカルリーダー

**対応ソフト**: [OpenCode 2](https://opencode.ai/v2/docs)（ベータ版、`opencode2` バイナリ）

**データ取得方式**: 直接 SQLite 読み取り（`bun:sqlite`）

**読み取り元**: `~/.local/share/opencode/opencode.db`

**クエリ**:

```sql
SELECT time_created, model, tokens_input, tokens_output,
       tokens_reasoning, tokens_cache_read, tokens_cache_write
FROM session_v2
```

**パース方法**:

- `session_v2` テーブルからトークン列が存在する全行を取得
- `time_created` (epoch ms) から日付 (YYYY-MM-DD) を算出
- `model` は JSON 文字列（`{"id":"deepseek-v4-flash","providerID":"opencode-go","variant":"max"}`）なので `id` を抽出
- `tokens_reasoning` は `outputTokens` に合算
- 日付・モデルごとに集約

**コスト**: あり（`cost` 列に記録されているが表示には使用しない）

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
- **フォールバック**: `bunx` が ENOENT の場合 → `npx -y ccusage@^20` を使用
- **バッファ**: 256 MB（巨大なデータに対応）
- **エラー処理**: 失敗 → `Option.none`（該当ソースをスキップ、他ソースに影響なし）

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