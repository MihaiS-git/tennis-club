-- Local development only. The edited Supabase migrations remain the schema source of truth.
-- Safe to repeat; the current local database may already have this column removed.
ALTER TABLE public.courts
DROP COLUMN IF EXISTS display_order;
