---
task: "申込データ連携フロー監査"
created: "2026-06-14"
last_updated: "2026-06-14"
status: "audit_complete"
---

# 申込データ連携フロー監査

実データ（D1: family-tickets-db / 本番Worker）確認済み。修正なし・事実記録のみ。

---

## 1. フロー全体図

```
[player-form.html]
  ① LIFF認証 or 背番号ログイン → POST /api/auth/liff-login or /api/auth/login
     → sessions テーブルに token 保存（TTL 6h）
  
  ② ページロード時: GET /api/games → games 変数にセット（3段階表示フィルタ済み）
  
  ③ ページロード時: GET /api/applications → sessionStorage['myApplications'] にキャッシュ
  
  ④ 申込送信: POST /api/applications
     body: { gameId, category, quantityAdult, quantityChild, quantityInfant,
              seatType, seatRequest, receiverName, pickupMethod, paymentMethod,
              parkingCount, note, lang, source }
     → Worker: handleCreateApplication
       → parseApplicationInput (domain.js) でバリデーション
       → createApplication (repo.js)
         → findGameByIdentifier で game.id 解決
         → 締切判定: game.deadline + "T03:00:00.000Z" < nowIso → 410
         → ensureNoDuplicateApplication: 同player_id × 同game_id × 同category × status != 'cancelled' → 409
         → applications テーブルに INSERT
         → audit_log に submit 記録
       → sendApplicationConfirmPush（非同期・失敗しても申込成功を妨げない）
     → 201 { applicationId }
     → 成功後: rememberSubmittedApplication でsessionStorage['myApplications']に push
  
  ⑤ 申込送信後: LIFF dashboard(gFA7Ik77)にリダイレクト（2秒後）
```

```
[player-dashboard.html]
  ⑥ 表示: loadData() で GET /api/games + GET /api/applications を並列取得
     → applications = appsRes.data.filter(a => a.status !== 'cancelled') でフィルタ
     → updateSummary(), renderList() で表示
```

```
[admin.html]
  ⑦ GET /api/admin/applications?gameId=&category=&status=&playerId=
     → listAdminApplications (repo.js) で JOIN した完全データ返却
     → Googleシート出力: 未実装（export_state テーブルは存在するが、GAS側のエクスポート連携コードは未確認）
```

---

## 2. applicationsテーブル スキーマ（全カラム）

| カラム | 型 | 意味 |
|---|---|---|
| id | INTEGER PK | 内部連番 |
| app_id | TEXT | UUID（クライアントに返すID） |
| player_id | INTEGER FK | players.id |
| game_id | INTEGER FK | games.id（game_noではなくid） |
| category | TEXT | invite / family / paid |
| quantity_adult | INTEGER | 大人枚数（0-10） |
| quantity_child | INTEGER | 子供枚数（0-10） |
| quantity_infant | INTEGER | 幼児枚数（0-10） |
| seat_type | TEXT | 座席種別（空文字可） |
| seat_request | TEXT | 座席希望（自由記述） |
| receivers | TEXT | JSON配列 [{name: string}] |
| pickup_method | TEXT | pre=事前 / day=当日 |
| payment_method | TEXT | salary/cash/free/空文字 |
| parking | INTEGER | 駐車場台数（0-10） |
| note | TEXT | 備考 |
| status | TEXT | pending / confirmed / rejected / cancelled |
| lang | TEXT | ja / en |
| source | TEXT | web / line |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

---

## 3. 「現在N枚申込済み」表示の経路

```
loadApplications() [player-form.html:2264]
  → GET /api/applications
  → sessionStorage['myApplications'] = result.data（全件・cancelledも含む）
  
buildInviteGrid() / buildFamilyGrid() [player-form.html:2451/2532]
  → getExistingQty(gameId, ticketType) [player-form.html:2441]
     → sessionStorage['myApplications'] を読む
     → status !== 'cancelled' でフィルタ
     → quantity_adult の合計を返す
  → qty-summary に "現在 {count} 枚申込済み" 表示
```

**重要**: buildInviteGrid/buildFamilyGrid は loadGames() の後（initFormAfterAuth内）で呼ばれるが、
loadApplications() は loadGames() の後に呼ばれる。
**問題**: `await loadGames()` → `await loadApplications()` の順で呼ばれるが、
buildInviteGrid/buildFamilyGrid は loadGames() 内で呼ばれる。
つまり **loadApplications() より先に grid が描画される** = 初回ロード時は常に「現在0枚」になる。

---

## 4. 重複チェックの実装詳細

### Worker側（repo.js:125-132）
```javascript
export async function ensureNoDuplicateApplication(db, playerId, gameId, category) {
  const existing = await db.prepare(
    `SELECT app_id FROM applications
     WHERE player_id = ?1 AND game_id = ?2 AND category = ?3 AND status != 'cancelled'`
  ).bind(playerId, gameId, category).first();
  if (existing) throw new HttpError(409, "DUPLICATE", "Duplicate application");
}
```

**条件**: 同 player_id × 同 game_id × 同 category × status が cancelled でない行が1件でもあれば 409。

### フロント側（player-form.html:2273-2280）
```javascript
function hasExistingApplication(gameId, ticketType) {
  const existingApps = JSON.parse(sessionStorage.getItem('myApplications') || '[]');
  return existingApps.find(a =>
    String(a.gameId) === String(gameId) &&
    a.ticketType === ticketType &&
    a.status !== 'cancelled'
  );
}
```
Workerと同じロジックをフロントでもチェックし、送信前にエラー表示する二重ガード。

---

## 5. findApplicationForConfirmPush の累計集計ロジック

```javascript
// repo.js:278-284
const totalRow = await db.prepare(
  `SELECT COALESCE(SUM(quantity_adult), 0) AS total
   FROM applications
   WHERE player_id = ?1 AND game_id = ?2 AND status != 'cancelled'`
).bind(row.player_id, row.game_id).first();
```

- 累計 = 同選手 × 同試合の cancelled 以外の quantity_adult 合計
- 今回の申込も含む（申込後に集計するため）
- **種別(category)を問わず合算している**（invite + family + paid の合計になる）

---

## 6. 実データ確認結果（006 = #6 赤穂雷太）

| app_id(短縮) | category | qty_adult | status | game_no | date |
|---|---|---|---|---|---|
| 195e8d52 | invite | 3 | **pending** | G02 | 2026-10-15 |
| 65aa09c7 | family | 2 | cancelled | G02 | 2026-10-15 |
| d72eb095 | family | 1 | cancelled | G03 | 2026-10-22 |

API GET /api/applications の実レスポンス: 3件返却（cancelled含む）  
DB と API の返却値は一致。データは正しく保存・取得されている。

---

## 7. 問題(a): 「招待チケットは既に申込済み」で追加申込ができない

### 根本原因
`ensureNoDuplicateApplication` が **同 player × 同 game × 同 category × status != cancelled** の行が1件でもあれば 409 DUPLICATE を返す。

006選手の場合:
- G02 × invite × status=pending の行(195e8d52)が存在する
- → 同試合に再度 invite を送信すると必ず 409

**これは仕様通りの動作**。意図的な重複防止。現行ロジックは「1申込 = 1行・追加不可」設計。

### 選択肢（仕様判断が必要）
| 選択肢 | 内容 | DBへの影響 |
|---|---|---|
| A: 現状維持 | 追加申込不可（キャンセル→再申込のみ） | 変更なし |
| B: 上書き方式 | 同 player × game × category の既存行を UPDATE（枚数置換） | 1行を更新 |
| C: 加算方式 | 既存行の quantity_adult を加算 UPDATE | 1行を更新 |
| D: 複数行許可 | UNIQUE制約を外して複数行を許可 | スキーマ変更 + 集計ロジック変更 |

**推奨（技術観点のみ）**: 選択肢B（上書き）が最もシンプル。  
- 管理側で「最終確定枚数」が1行で確認できる  
- 集計・Googleシート出力がシンプルなまま  
- 選択肢D（複数行）は集計クエリの修正範囲が広く、バグリスクが高い

---

## 8. 問題(b): 申込履歴がフォームの「現在N枚」とdashboardに反映されない

### 原因1（フォーム）: buildGrid が loadApplications より先に実行される

実行順序（initFormAfterAuth: player-form.html:2072）:
```
loadGames()          ← 内部で buildInviteGrid() / buildFamilyGrid() を呼ぶ（grid描画）
  └ renderPaidGameOptions()
  └ buildInviteGrid()   ← ★ここでgetExistingQty()が呼ばれるがまだsessionStorageは空
  └ buildFamilyGrid()
  └ updateAvailBadges()
loadApplications()   ← ★この後にsessionStorage['myApplications']が書き込まれる
```

`buildInviteGrid/buildFamilyGrid` が `getExistingQty()` を呼ぶ時点では `sessionStorage['myApplications']` が未設定 → 常に0枚表示。

### 原因2（フォーム）: API返却データの ticketType フィールドが key 不一致の可能性

`getExistingQty(gameId, ticketType)` は `a.ticketType` を参照するが、  
API `/api/applications` のレスポンスは `mapApplicationRow` が返す:
```javascript
ticketType: row.category,  // ← "invite"/"family"/"paid"
```
こちらは一致している（`ticketType` フィールドは存在する）。

### 原因3（フォーム）: 申込成功後の rememberSubmittedApplication が quantity を持たない

```javascript
function rememberSubmittedApplication(gameId, ticketType) {
  existingApps.push({ gameId, ticketType, status: 'pending' });  // quantityAdultなし
}
```
`getExistingQty` は `parseInt(a.quantityAdult) || 0` を使うが、  
`rememberSubmittedApplication` で追加された行は `quantityAdult` プロパティが undefined → 0扱い。  
→ 申込成功直後のセッション内では「現在N枚」の数値が増えない。

### 原因4（dashboard）: games キャッシュ（TTL 5分）は問題なし

dashboardは `loadData()` で毎回 `/api/applications` を叩く（applications にキャッシュなし）。  
DBには正しく保存されており、APIも正しく返す（実データ確認済み）。  
→ **dashboard の表示は正しいはず**（ただしセッション有効期限切れで再ログインが必要な場合あり）。

---

## 9. バグ・連携漏れ一覧

| # | 場所 | 種別 | 内容 | 深刻度 |
|---|---|---|---|---|
| 1 | player-form.html:2096-2097 | バグ | `loadGames()` 内で buildGrid が呼ばれるが、その後で `loadApplications()` が呼ばれる。初回ロード時に「現在N枚申込済み」が必ず0になる。 | HIGH |
| 2 | player-form.html:2288 | バグ | `rememberSubmittedApplication` に `quantityAdult` が含まれないため、申込直後のセッション内でも「現在N枚」が0のまま。 | MEDIUM |
| 3 | Worker repo.js:279 | 設計問題 | `findApplicationForConfirmPush` の累計が category を問わず合算（invite+family+paid）。通知文言が意図と合っているか要確認。 | LOW |
| 4 | repo.js:125 | 仕様判断待ち | 同 game × 同 category への2回目申込を一律 409 で弾く。追加申込ユースケースへの対応が必要かは龍偉判断。 | CRITICAL（仕様） |
| 5 | Googleシート出力 | 未実装 | `export_state` テーブルは存在するが、GAS→Worker or Worker→GAS のエクスポート連携は未実装。 | LOW（今後） |

---

## 10. 仕様判断が必要な点

### [要判断①] 追加申込の扱い（問題(a)）
- 現状: 同試合・同種別に2回目を送ると「既に申込済みです」で弾く
- 選択肢: A=現状維持（キャンセル→再申込） / B=上書き / C=加算 / D=複数行許可
- 推奨: **B（上書き）** - 管理側の確認がシンプル

### [要判断②] findApplicationForConfirmPush の累計集計（問題 #3）
- 現状: 同試合の全種別(invite+family+paid)の quantity_adult を合算して通知
- 意図: 同種別のみにすべきか、全種別合算でよいか

### [要判断③] rememberSubmittedApplication に quantity を含めるか
- 現状: `{ gameId, ticketType, status: 'pending' }` だけ記録（quantity なし）
- 修正: `quantityAdult` を追加すれば申込直後から「現在N枚」が正しくなる
- **これはバグ修正として即対応可能**（仕様判断不要）

---

## 更新履歴
- 2026-06-14 — 初版作成（実データ確認 + コード全調査）
