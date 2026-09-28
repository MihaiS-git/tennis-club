# Profiles

`/profile` is an authenticated application page. Active accounts have separate personal-information and tennis-profile saves. `/profile` also contains account/email information, roles, the existing password-change form (including current-password verification), with sign out in global navigation. `/account` redirects to `/profile`; anonymous visitors continue to `/login`. A missing application account, suspended account, or load failure shows an unavailable/restricted page.

## Data and authorization

`public.users` holds identity, status, timestamps, and nullable first/last name, phone, birth date, address lines, city, postal code, and country code. `updated_at` means the latest change to this row, including personal edits and role-driven touches. Auth provisioning still inserts only ID/email; email synchronization is unchanged.

Active owners may update their permitted personal fields. Existing owner/admin account reads remain in place. Status remains managed by another active administrator. Column grants and field guards prevent the owner/admin UPDATE policies from enabling each other's mutations. Identity, email, and timestamps cannot be directly updated by authenticated clients.

`public.player_profiles` is optional and created on the first tennis save. It is not created during signup. It contains display name, avatar object path, individual Sportya level (only strings `"4"` through `"9"`, or null), nullable system-managed rating, handedness, backhand, preferred game/surface, bio, and timestamps. Tennis data is readable by active authenticated users, never anonymously. Next.js verifies authentication, active status, ownership, input validation, and explicit allowed fields; RLS provides defense in depth. Rating, ownership, avatar paths, and timestamps are never accepted from tennis form inputs. No deletion feature is implemented.

Player timestamps default to `now()` on creation. Next.js explicitly sets `updated_at` on tennis updates and avatar path changes, including compensation updates. The user-scoped client has UPDATE permission on this column for those server writes; no player timestamp maintenance trigger is used. The existing `users.updated_at` trigger behavior is unchanged.

Future `coach_profiles` will be a sibling entity. A user may have player/coach profiles, both, or neither. Profiles do not grant RBAC roles; membership remains separate from RBAC.

## Profile presentation

The four full-label section buttons display one section at a time while keeping forms mounted to preserve unsaved edits. Mobile uses two columns; tablet and desktop use four. Country selection searches English names derived locally with `Intl.DisplayNames` from the application-owned 249 ISO alpha-2 codes in `src/lib/profile/countries.ts`. Only canonical codes are submitted; server validation checks membership in that set.

A nonempty persisted display name takes precedence. Otherwise the identity summary and Tennis profile input use the whitespace-normalized first and last name. Saving personal information never creates or updates the tennis row. Tennis saves may persist the displayed fallback as the chosen name. Sportya uses a controlled individual-level select; doubles half-levels are excluded.

Desktop navigation and the mobile drawer share a cached server-render read of the authenticated account and its avatar metadata. Active users with an avatar use the same private `/profile/avatar` endpoint as the identity summary. No path or Storage URL is sent to the browser. A failed image falls back to the profile icon, and successful avatar mutations refresh the root layout.

## Avatar workflow

After saving a tennis profile, an active owner can upload or remove an avatar. The private Supabase Storage bucket is `profile-avatars`; paths are `<user-id>/avatar.jpg`, `.png`, or `.webp`. Only the path is persisted in `player_profiles.avatar_path`. A NULL path renders the default icon.

Next.js validates declared MIME, image signatures, nonempty contents, and a maximum of 5 MiB. Files are not resized/converted. Server Actions allow 6 MiB request bodies to accommodate upload overhead; application and bucket file limits remain 5 MiB. All Supabase operations use the user-scoped server client. The authenticated `/profile/avatar` GET endpoint downloads the current user’s image under Storage RLS and serves it with private, no-store headers. The browser receives only a local Next.js image URL; no direct browser-to-Supabase access or image conversion is introduced.

Replacement overwrites the same-format object or deletes the previous format after updating the database path. Removal deletes the object and clears the path. The application downloads the previous object before mutation and attempts compensation if persistence or cleanup fails. Failed changes return safe feedback and log only workflow stages.

Storage and database operations are not one transaction. Compensation can itself fail, and simultaneous avatar changes from multiple sessions are not serialized. Reload/retry is required after an error; logged rollback failures may require inspection of the user's canonical avatar objects. No privileged repair workflow is introduced.

## Development migrations and validation

Personal fields/security belong to the edited auth/RBAC foundation migration. Player profiles and avatar Storage have separate focused migrations. No views or RPCs are added. This is unreleased development schema; released production history must remain immutable.

An edited development migration requires a rebuild before its new behavior can be validated. `supabase db reset` requires explicit approval and deletes local data. After rebuilding, run unit/components/integration and both database suites as documented in `testing.md`. Profile and avatar integration tests exercise real Auth, database, and Storage operations; the avatar endpoint test substitutes only the request-cookie client factory.
