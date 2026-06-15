-- migration 0004: UNIQUE を partial index（WHERE status != 'cancelled'）に変更
-- cancelled 後に同一申込者が再申込できるよう修正（A10対応）
-- 2026-06-15 — 龍偉UX要件（キャンセル後の同名再申込許可）

-- 旧UNIQUE削除
DROP INDEX IF EXISTS uq_applications_per_applicant;

-- 新UNIQUE: cancelled 以外のみ重複禁止（cancelled は何度も INSERT 可能）
CREATE UNIQUE INDEX uq_applications_active_per_applicant
  ON applications(player_id, game_id, category, applicant_name)
  WHERE status != 'cancelled';
