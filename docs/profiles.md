# Profiles

`/profile` is an authenticated application page. Active accounts have separate personal-information and tennis-profile saves. `/profile` also contains account/email information, roles, the existing password-change form (including current-password verification), with sign out in global navigation. `/account` redirects to `/profile`; anonymous visitors continue to `/login`. A missing application account, suspended account, or load failure shows an unavailable/restricted page.

## Data and authorization

`public.users` holds identity, status, timestamps, and nullable first/last name, phone, birth date, address lines, city, postal code, and country code. `updated_at` means the latest change to this row, including personal edits and role-driven touches. Auth provisioning still inserts only ID/email; email synchronization is unchanged.

Active owners may update their permitted personal fields. Existing owner/admin account reads remain in place. Status remains managed by another active administrator. Column grants and field guards prevent the owner/admin UPDATE policies from enabling each other's mutations. Identity, email, and timestamps cannot be directly updated by authenticated clients.

`public.player_profiles` is optional and created on the first tennis save. It is not created during signup. It contains display name, avatar object path, individual Sportya level (only strings `"4"` through `"9"`, or null), nullable system-managed rating, handedness, backhand, preferred game/surface, bio, and timestamps. Tennis data is readable by active authenticated users, never anonymously. Next.js verifies authentication, active status, ownership, input validation, and explicit allowed fields; RLS provides defense in depth. Rating, ownership, avatar paths, and timestamps are never accepted from tennis form inputs. No deletion feature is implemented.

Player timestamps default to `now()` on creation. Next.js explicitly sets `updated_at` on tennis updates; the ownership-checked avatar persistence RPC sets it from the database clock on avatar path changes. The user-scoped client has UPDATE permission on this column for server writes; no player timestamp maintenance trigger is used. The existing `users.updated_at` trigger behavior is unchanged.

Future `coach_profiles` will be a sibling entity. A user may have player/coach profiles, both, or neither. Profiles do not grant RBAC roles; membership remains separate from RBAC.

## Profile presentation

Admin → Users keeps its compact account table. Opening Manage user fetches current
account and personal/tennis details through the Admin-only server read, reusing
`loadProfile()` and user-scoped Supabase access. It never reads booking contact
snapshots or lists guest contacts. Missing profile values show placeholders. The
Admin-only `/admin/users/[userId]/avatar` route reuses the authenticated avatar
reader, verifies the selected user's canonical path, and serves private, no-store
WebP responses through the existing Storage RLS policy. Management controls retain
their existing authorization and confirmations.

The four full-label section buttons display one section at a time while keeping forms mounted to preserve unsaved edits. Below `sm` (640px), the selector uses one horizontal row of nonshrinking buttons, scrolling when needed. At `sm` (640px) and above, the selector uses four equal-width columns. Country selection searches English names derived locally with `Intl.DisplayNames` from the application-owned 249 ISO alpha-2 codes in `src/lib/profile/countries.ts`. Only canonical codes are submitted; server validation checks membership in that set.

## Unsaved changes and visit lifecycle

Personal information and Tennis profile each retain a local last-successful baseline. Controlled React values remain the field authority. Comparisons include only editable fields, equate null with an empty string, trim text, and uppercase country codes to match existing persistence semantics. The initially displayed effective tennis name is the initial clean value. Each form wraps its existing save action to capture a normalized submission; only a successful result advances that form's baseline. Later edits during a pending save remain dirty. Failed saves retain values and the previous baseline. Server revalidation does not overwrite another form's draft or baseline.

The Profile visit aggregates the two forms independently through a set of dirty form names; no field values enter a shared store. Section switching keeps the forms mounted and never warns. Password inputs and immediately persisted avatar operations do not contribute dirty state.

`ProfileDepartureProvider` bridges the active Profile visit to explicitly opted-in shared navigation. Only that visit registers a departure handler. `ProfileDepartureLink` uses the installed Next.js 16.3.5 supported `Link.onNavigate` API, including its native modifier-click, download, and new-tab behavior. Desktop/mobile navigation (including authenticated Matches and admin Users links), brand links, booking CTAs, footer links, and mobile loading fallback links use the wrapper. Their surrounding server-rendered structures remain Server Components. The footer's external attribution opens another tab. Profile has no departing programmatic router calls or other departing links; its section buttons and `/profile` avatar link stay within the visit. Query-flash cleanup replaces the same pathname and needs no departure interception.

The existing desktop/mobile sign-out forms use `ProfileDepartureForm` to guard submission before invoking their unchanged Server Action. There is no document click interceptor, router patch, or history manipulation. Clean departures retain Next's original Link behavior. A dirty attempt is cancelled and creates one indefinitely visible Sonner warning with Stay and Leave without saving actions. Repeated attempts replace the pending continuation using the same toast ID; Leave always invokes the latest requested destination. Dismissal only stays. Becoming clean dismisses the warning without navigating. The confirmation has a separate ID from save/error feedback. An approved departure advances the existing visit key before navigation, also covering rapid leave/return transitions. Activity cleanup and `bfcacheId` continue to create fresh visits from current server props after departures.

While either form is dirty, Profile registers `beforeunload`, calls `preventDefault()` and sets the legacy `returnValue`. It removes the listener when clean, hidden by Activity, or unmounted. Reload, close, and document departures use browser-native confirmation with browser-controlled text; browser support and user activation determine whether it is shown.

**History limitation:** Next's App Router processes same-document back/forward through non-cancellable `popstate`, with no supported blocking hook. `beforeunload` does not run on those traversals. The Navigation API also cannot reliably cancel traversal across browsers. Same-document back/forward therefore follows the established fresh-visit behavior and can discard drafts without a warning; document-level history departures use the native unload mechanism when fired. This is an explicit limitation, not a claim that `beforeunload` guards all history. No fake history entries or manual history-stack restoration are introduced.

Focused coverage: `npx vitest run tests/components/profile-forms.test.tsx tests/components/profile-settings.test.tsx tests/components/profile-page.test.tsx tests/components/profile-unsaved-changes.test.tsx tests/unit/profile`. Real browser coverage is included in `npm run test:e2e:auth`, including shared links, Stay/discard, fresh return, and native reload cancellation. Then run `npm run typecheck`, `npm run lint`, and `npm run build`; `/` must remain Partial Prerender and `/profile/avatar` Dynamic.

A nonempty persisted display name takes precedence. Otherwise the identity summary and Tennis profile input use the whitespace-normalized first and last name. Saving personal information never creates or updates the tennis row. Tennis saves may persist the displayed fallback as the chosen name. Sportya uses a controlled individual-level select; doubles half-levels are excluded.

Desktop navigation and the mobile drawer share a cached server-render read of the authenticated account and its avatar metadata. Active users with an avatar use the same private `/profile/avatar` endpoint as the identity summary. No path or Storage URL is sent to the browser. A failed image falls back to the profile icon, and successful avatar mutations refresh the root layout.

## Avatar workflow

After saving a tennis profile, an active owner can upload or remove an avatar. The private Supabase Storage bucket is `profile-avatars`; the sole canonical object is `<user-id>/avatar.webp`, regardless of source filename or format. Only this path is persisted in `player_profiles.avatar_path`. A NULL path renders the default icon. Storage write policies allow only the caller's canonical WebP name; the bucket accepts only `image/webp` with a 5 MiB limit.

Next.js requires a File, nonempty contents, a maximum of 5 MiB, and declared JPEG/PNG/WebP MIME. Sharp reads metadata under a 40-million-pixel decoder limit, rejects missing/nonpositive dimensions or sides above 12,000 pixels, and verifies the decoded format matches the declared MIME. Actual pixel decoding and re-encoding must succeed; truncated or corrupt input produces a controlled field error. Decoder safety remains enabled, only the first frame is processed, and transformation has a 10-second processing timeout. Sharp applies EXIF orientation, fits the image inside 512 × 512 without enlargement or cropping, strips source metadata, and encodes WebP at quality 82. Original upload bytes are never stored. The UI's existing file-picker hint and 5 MiB message remain; client checks only size, nonempty contents, and declared MIME for immediate feedback.

Server Actions allow 6 MiB request bodies to accommodate upload overhead; incoming file and bucket limits remain 5 MiB. All Supabase operations use the user-scoped server client. The authenticated `/profile/avatar` GET endpoint downloads the current user's WebP under Storage RLS and serves it with private, no-store and nosniff headers. The browser receives only a local Next.js image URL with the profile timestamp as its version. Avatars use native images; the large Profile identity image loads eagerly and small navigation images retain lazy loading.

Replacement downloads the previous canonical object, overwrites it with normalized WebP, then updates the database path and server timestamp. If persistence fails, the application attempts to restore the previous object; for an initial upload it attempts to delete the new object. Removal downloads a backup, deletes the canonical object, and clears the database path with a new timestamp; failed persistence attempts to restore the backup. There is no extension-change cleanup. Failed changes return safe feedback and log only workflow stages.

Upload and removal share one pending state; both submit controls and the file picker are disabled while either action is pending. A synchronous submission guard also rejects repeated submissions before pending UI renders.

`avatar_mutation_leases` has one row per owner, a random server-generated UUID ownership token, and a five-minute expiry. It has RLS enabled and no direct authenticated/anonymous table grants. Short, user-scoped RPCs atomically acquire the lease, persist the canonical path only for an active account with the current unexpired token, and release only the caller's matching token. Identity always comes from `auth.uid()`. A conflicting request returns controlled feedback before reading the old object or mutating Storage. Different owners proceed independently. The committed lease spans the complete backup, Storage mutation, database persistence, and bounded compensation workflow; no database transaction stays open across HTTP calls.

All requests on the mutation's user-scoped Supabase client have a ten-second HTTP timeout and a two-minute overall transport deadline, starting before acquisition. Transport refuses new calls after that deadline, including compensation from a resumed stale worker, leaving a three-minute gap before takeover is possible. Normal exits attempt token-scoped release in `finally`, including a lost acquisition response. If release cannot complete or the process terminates, a later acquisition atomically replaces the expired row. Old tokens cannot release or persist over the replacement. No heartbeat, scheduled cleanup, secret client, or in-memory mutex is needed.

Storage and database operations are not one transaction. Compensation can itself fail, and process termination or an ambiguous Storage timeout can still require inspection of the canonical object. Reload/retry is required after an error; rollback and release failures log safe workflow stages. Lease recovery restores access to future mutations, not an abandoned request's backup. No privileged repair workflow is introduced.

Old development `.jpg`/`.png` objects and references are not migrated by this workflow. Such references fail canonical-path validation and require deliberate development-data cleanup before re-uploading. A database reset still requires explicit approval.

## Development migrations and validation

Personal fields and account security belong to `20260922140728_auth_rbac_foundation.sql`. The consolidated `20260928100000_player_profiles_avatars.sql` defines player profiles, private avatar Storage, and the lease table with acquisition, release, and persistence RPCs. This is unreleased development schema; released production history must remain immutable.

The consolidated migration history requires a local rebuild before its behavior can be validated. `supabase db reset` requires explicit approval and deletes local data; it has not been run as part of consolidation. After rebuilding, run unit/components/integration and database suites as documented in `testing.md`. Profile and avatar integration tests exercise real Auth, database, and Storage operations; the avatar endpoint test substitutes only the request-cookie client factory.
