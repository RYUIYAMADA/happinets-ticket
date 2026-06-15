-- migration 0003: applicant_name カラム追加 + 重複防止 UNIQUE 再設定
-- 別レコード化: 同一 (player_id, game_id, category, applicant_name) は 1レコードまで
-- 2026-06-15 — 龍偉承認済み（本番テストデータ全クリア前提）

-- 0. 既存テストデータを全削除（本番データなし・龍偉承認済み）
DELETE FROM applications;

-- 1. applicant_name カラムを追加
ALTER TABLE applications ADD COLUMN applicant_name TEXT NOT NULL DEFAULT '';

-- 2. 新 UNIQUE: (player_id, game_id, category, applicant_name) — ステータス問わず重複禁止
--    （同一申込者が同試合・同種別に1件のみ）
CREATE UNIQUE INDEX IF NOT EXISTS uq_applications_per_applicant
  ON applications(player_id, game_id, category, applicant_name);
