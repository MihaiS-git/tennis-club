import type { MigrationInterface, QueryRunner } from "typeorm";

export class SupabaseAuthStorage1791462257926 implements MigrationInterface {
  name = "SupabaseAuthStorage1791462257926";

  async up(queryRunner: QueryRunner): Promise<void> {
    // Supabase's public-schema defaults otherwise expose newly created tables.
    // Cover the migration owner and the standard Supabase database owner.
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated`);
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated`);
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated`);
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated`);
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated`);
    await queryRunner.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated`);

    await queryRunner.query(`CREATE FUNCTION public.handle_auth_user_created() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
      BEGIN
        INSERT INTO public.users (id, email) VALUES (NEW.id, NEW.email);
        RETURN NEW;
      END;
      $$`);
    await queryRunner.query(`CREATE FUNCTION public.handle_auth_user_email_updated() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
      BEGIN
        IF NEW.email IS DISTINCT FROM OLD.email THEN
          UPDATE public.users SET email = NEW.email, updated_at = pg_catalog.clock_timestamp() WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END;
      $$`);
    for (const name of ["handle_auth_user_created", "handle_auth_user_email_updated"]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated, service_role`);
    }
    await queryRunner.query(`CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_created()`);
    await queryRunner.query(`CREATE TRIGGER on_auth_user_email_updated AFTER UPDATE OF email ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_email_updated()`);

    // Only Storage needs this boolean; callers cannot choose another account.
    // SECURITY DEFINER avoids granting browser roles SELECT on private users.
    await queryRunner.query(`CREATE FUNCTION public.has_active_avatar_account() RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
        SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND status = 'active');
      $$`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.has_active_avatar_account() FROM PUBLIC, anon, authenticated, service_role`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION public.has_active_avatar_account() TO authenticated`);
    await queryRunner.query(`INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES ('profile-avatars', 'profile-avatars', false, 5242880, ARRAY['image/webp'])`);
    const readable = `bucket_id = 'profile-avatars' AND (SELECT public.has_active_avatar_account())`;
    const allowed = `${readable} AND name = (SELECT auth.uid())::text || '/avatar.webp'`;
    await queryRunner.query(`CREATE POLICY profile_avatars_select ON storage.objects FOR SELECT TO authenticated USING (${readable})`);
    await queryRunner.query(`CREATE POLICY profile_avatars_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (${allowed})`);
    await queryRunner.query(`CREATE POLICY profile_avatars_update ON storage.objects FOR UPDATE TO authenticated USING (${allowed}) WITH CHECK (${allowed})`);
    await queryRunner.query(`CREATE POLICY profile_avatars_delete ON storage.objects FOR DELETE TO authenticated USING (${allowed})`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const operation of ["delete", "update", "insert", "select"]) {
      await queryRunner.query(`DROP POLICY profile_avatars_${operation} ON storage.objects`);
    }
    // Refuse to discard stored objects; empty the bucket through Storage first.
    await queryRunner.query(`DELETE FROM storage.buckets WHERE id = 'profile-avatars'`);
    await queryRunner.query(`DROP FUNCTION public.has_active_avatar_account()`);
    await queryRunner.query(`DROP TRIGGER on_auth_user_email_updated ON auth.users`);
    await queryRunner.query(`DROP TRIGGER on_auth_user_created ON auth.users`);
    await queryRunner.query(`DROP FUNCTION public.handle_auth_user_email_updated()`);
    await queryRunner.query(`DROP FUNCTION public.handle_auth_user_created()`);
    // Reverting must not reopen application tables through the Data API.
  }
}
