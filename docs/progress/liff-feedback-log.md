---
task: "family-tickets LIFF版 本番テスト・龍偉フィードバック対応ログ"
project: "family-tickets"
last_updated: "2026-06-15"
status: in_progress（龍偉実機テスト中）
---

# LIFF版 本番テスト 対応ログ（/dev-resume 復元用）

## 重要な本番リソース（厳守・誤記注意）
- 本番Worker: `https://family-tickets-api.row2014-2015-k.workers.dev`
- D1: `family-tickets-db` id=`e0012711-4846-4727-8bc9-2a44d3d66de6`（APAC/KIX）
- LINEログインチャネルID(LIFF用): `2010388137` / Messaging APIチャネル: `2010382769`（.env.gasのCHANNEL_ACCESS_TOKENはこちら）
- LIFF ID: 申込フォーム=`2010388137-8fUulpy5` / マイ申込状況=`2010388137-gFA7Ik77`（★4文字目は大文字 I。小文字 l は誤り＝過去に誤読してnot found多発）
- リッチメニュー: 現行 `richmenu-336dca64551d65ce4fd481c437d79ac5`（2ボタン・size 2500×843・画像 assets/richmenu.png 2500×1686・デフォルト設定済）。左=予約する(8fUulpy5)/右=マイ申込状況(gFA7Ik77)。スリム化（sublabel+tap-hintを削除・ラベル130px→180px）2026-06-14。★C1高バグ: createRichMenuDirect の size/areas が 843 だったため画像下半分が表示/タップ不能だった → Code.gs を 1686 に修正済（2026-06-15）。次回 createRichMenuDirect 実行で新メニューに置き換え必須（旧 ID `richmenu-336dca64551d65ce4fd481c437d79ac5` を削除してから再作成推奨）
- html-share slug: hnts-index / hnts-player-form / hnts-player-dashboard / hnts-admin。★バー無し実体URL=`/api/serve/<slug>`（no-store化済み・即反映）。/p/<slug>はツールバー付き
- テスト用: 選手番号 006/14/22/99/101・admin password `happinets-test`

## 完了（コード・本番反映済み）
- LIFF自動ログイン（liff-login/link-liff・誤連携やり直し）。初回のみ背番号連携、以降自動
- デザイン刷新（予約システム風・白基調+ロイヤルブルー#2456E6・モノクロ線アイコン§8b）
- 申込フォーム: 種別縦3段スリム/確定ボタン下部固定(オレンジ--accent-cta #EA580C)/試合6件展開/区切り線2px/締切後グレー/3段階表示(締切後〜試合翌日12時表示→翌日12時以降非表示)/受取方法を全種別統一(当日受取default)/戻るボタン(初期グレーアウト・進行後ページ内STEP1へ・closeWindow廃止)/日付YYYY/MM/DD/「2F自由」
- 申込確認(dashboard): LIFF ID誤字(l→I)修正で開くように・日付統一・i18n tf()修正
- 締切前日18時アナウンス: 朝通知廃止しcronを`0 9 * * *`(JST18:00)に付替（cron上限内で実現）。締切12時固定。文面=日本語全文→区切り→英語全文(broadcast)。手動プレビュー POST /api/admin/announce-deadline?dryRun=true
- 英語モード: JA/enトグルで選択言語のみ表示(併記廃止・8689369)。※LINEアナウンスのみ日英全文併記
- admin: タブ折返し・テーブルSP・KPI/LINE通知のサイレント失敗(baseURL空が原因)修正
- リッチメニュー復旧(size不一致を修正)
- C1高バグ修正: createRichMenuDirect size/areas 843→1686（画像 2500×1686 に整合）。createRichMenu_RUNONCE に「未使用legacy」コメント追記。2026-06-15

## 残・注意
- 龍偉の実機最終確認中（マイ申込状況が開くか・予約→申込→確認の通し）
- 任意: line-harness(an-line 2本)/masters-regatta-line(2本・ボート終了・孤児) のcron整理。Cloudflare無料プランcron上限5本(an-line2+masters2+family1)。18時配信は実現済みなので整理は不要

## ハマった教訓（再発防止）
- LIFF IDの l(エル)/I(アイ)/1 誤読でnot found多発→必ずコピー値で照合
- /api/serve の Cache-Control が public max-age=3600 でLINE WebViewが古い版キャッシュ→no-store化で解決。ver表示で新版判別
- api-client baseURL が 127.0.0.1(ローカル)のまま→本番Worker URLに固定
- admin の api-config baseURL空→originに飛び失敗
- QAはデータ未接続だと崩れ(バッジ表示時の縦割れ等)を見逃す→本番接続・実データ・実機状態で確認必須
- richmenu は size と画像サイズ一致＋画像アップ200＋デフォルト設定(/v2/bot/user/all/richmenu/{id})200 の両方確認しないと消える
</content>
