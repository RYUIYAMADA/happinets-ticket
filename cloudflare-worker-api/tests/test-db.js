import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

/**
 * テスト用 in-memory SQLite DB を初期化
 * migrations/000X.sql をすべて適用して D1互換の環境を構築
 */
export function createTestDatabase() {
  const db = new Database(":memory:");

  // migrations を順番に適用
  const migrationsDir = path.join(import.meta.dirname, "..", "migrations");
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort(); // 0001, 0002, 0003, 0004 の順

  for (const file of migrationFiles) {
    let sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    // better-sqlite3 用に ?1, ?2 ... 形式を ? に変換（複数ステートメント対応）
    sql = sql.replace(/\?(\d+)/g, "?");
    db.exec(sql);
  }

  // D1互換ラッパー: Cloudflare Workers D1の prepare().bind().first() / .all() / .run() をシミュレート
  return {
    prepare(sql) {
      // D1 API は ?1, ?2, ... 番号付きプレースホルダを使うが、
      // better-sqlite3 は ? (位置的）プレースホルダを使う
      // SQL を変換して ? に統一する
      const convertedSql = sql.replace(/\?(\d+)/g, "?");
      const stmt = db.prepare(convertedSql);
      return {
        bind(...values) {
          return {
            async first() {
              return stmt.get(...values) || null;
            },
            async all() {
              return { results: stmt.all(...values) };
            },
            async run() {
              const info = stmt.run(...values);
              return {
                success: true,
                meta: {
                  changes: info.changes,
                  last_row_id: info.lastInsertRowid,  // AUTOINCREMENT ID取得用
                },
              };
            },
          };
        },
      };
    },
    async batch(statements) {
      // 複合実行（複数ステートメント）：各ステートメントの bind() と run() を呼ぶ
      const results = [];
      for (const boundStmt of statements) {
        try {
          // boundStmt は既に bind() されている状態
          const result = await boundStmt.run?.();
          results.push(result);
        } catch (err) {
          // UNIQUE 制約違反など、batch内で発生した エラーを伝播
          throw err;
        }
      }
      return results;
    },
  };
}
