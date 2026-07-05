> ⚠️ **MUST: Obsidian Brain 連携（外部脳）**
> 本プロジェクトの全作業を Obsidian Vault に必ず記録する。サボり禁止。
>
> - **Vault**: `~/Desktop/ryui-workspace/obsidian-brain/`
> - **本 PJ の Sessions ノート**: `Sessions/Happinets Family Tickets.md`（既存あれば追記、なければ Templates/session-template.md から新規作成）
> - **本 PJ の Projects ノート**: `Projects/family-tickets.md`（既存あれば最新化、なければ新規作成）
> - **詳細ルール**: `~/.Codex/AGENTS.md` の「IMPORTANT: Obsidian Brain 運用ルール（外部脳）」セクション必読
>
> ### 必須アクション
> 1. **セッション開始時**: Sessions/Happinets Family Tickets.md を読込（or 新規作成） → 「## セッション履歴」へ `### YYYY-MM-DD HH:MM - <見出し>` 追記開始
> 2. **重要マイルストーン達成時**: 即時追記（後回し禁止）
> 3. **意思決定**: Decisions/YYYY-MM-DD-family-tickets-<topic>.md
> 4. **バグ・ハマり解決**: Knowledge/<technology>-<topic>.md
> 5. **バージョン更新時**: Projects/family-tickets.md 最新化
> 6. **時刻記録**: created / last_updated フロントマター + 「## 📜 更新履歴」必須・即時更新
> 7. **透明性**: Vault 読書込のたびに「Obsidian: xxx を読みました/書きました」と明示報告

# family-tickets — AGENTS.md v0.1.0

> 選手家族チケット申し込みシステム

## 起動コマンド
```bash
cd ~/Desktop/ryui-workspace/projects/happinets/family-tickets && Codex
```

## 概要
ハピネッツ選手の家族向け試合チケット申込フォーム・管理画面。
2026年5月ホームゲームから運用開始。

## 主要ファイル
- `index.html` — トップページ
- `player-form.html` — 選手家族用申込フォーム
- `player-dashboard.html` — 選手ダッシュボード
- `admin.html` — 運営管理画面
- `gas/` — Google Apps Script 連携
- `SPEC.md` / `SPEC-MASTER.md` / `SPEC-responsive.md` / `SPEC-security-ux.md` — 仕様書一式
- `家族席申込 2026年5月ホームゲーム - Google フォーム.pdf` — 元フォーム参考

## GitHub
- origin: `ryuiyamada/happinets-ticket-243en98b`

## 関連
- グローバル鉄則: `~/.Codex/AGENTS.md`
- カテゴリ: `projects/happinets/`
