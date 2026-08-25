# My TokenMaxxing

AIエージェント（Codex, OpenCode, OMP, ZCode, Reasonix など）のLLMトークン使用量をローカルから収集し、ダッシュボードに表示します。

## 機能

- **9種類のデータソース**からトークン使用量を自動収集
  - ccusage（Codex, OpenCode, Claude, Gemini, Copilot, pi）
  - OpenCode2（session_v2 SQLite）
  - OMP（Oh My Pi）セッションJSONL
  - ZCode SQLiteデータベース
  - Reasonix telemetry.json
- **グレースケールダッシュボード** – データの可視化のみカラフル
- **積み上げ棒グラフ** – 期間に応じて日別/3日/週単位に自動グループ化
- **モデル別内訳** – 使用モデルの割合と入出力トークン
- **プロフィール編集** – アイコンと名前をブラウザに保存可能
- **コスト表示なし**

## 必要条件

- [Bun](https://bun.sh) 1.3+
- Node.js 24+
- ccusage（一部のデータソースに必要）

## インストール

```bash
git clone <your-repo-url>
cd my-tokenmaxxing
bun install
```

## 起動

```bash
bun run server/index.js
# → http://localhost:3642
```

## プロフィールカスタマイズ

URLパラメータでも、画面上の `Edit Profile` ボタンからでも変更可能：

```
http://localhost:3642?name=YourName&avatar=https://example.com/avatar.png
```

変更は `localStorage` に保存され、ブラウザを閉じても保持されます。

## データソース

| ソース | 読み取り方式 | 状態 |
|--------|-------------|------|
| Codex | `ccusage codex daily` | ✅ |
| OpenCode | `ccusage opencode daily` | ✅ |
| OpenCode2 | `~/.local/share/opencode/opencode.db` (session_v2) | ✅ |
| pi | `ccusage pi daily` | ✅ |
| Claude | `ccusage claude daily` | ⚠️ 要セットアップ |
| Gemini | `ccusage gemini daily` | ⚠️ 要セットアップ |
| Copilot | `ccusage copilot daily` | ⚠️ 要セットアップ |
| OMP | `~/.omp/agent/sessions/*.jsonl` | ✅ |
| ZCode | `~/.zcode/cli/db/db.sqlite` | ✅ |
| Reasonix | `%APPDATA%/reasonix/projects/*/sessions/*.telemetry.json` | ✅ |

## プロジェクト構成

```
my-tokenmaxxing/
  server/
    index.js           # Expressサーバー（API + 静的ファイル）
    data-fetcher.js    # データ収集（ccusage / OpenCode2 / OMP / ZCode / Reasonix）
  public/
    index.html         # ダッシュボードUI
  token-reading-logic.md  # データ読み取り仕様書
  package.json
```

## ライセンス

MIT
