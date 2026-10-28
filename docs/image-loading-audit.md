# Application image loading audit

Audited 2026-10-28 on `perf/route-prefetch`, starting from the existing uncommitted implementation. Original artwork and existing derivatives were retained. No dependencies or commits were added.

## Measurement conditions

Isolated snapshot: `/tmp/tennis-image-audit`; production server: `127.0.0.1:3217`. Both versions used `next build --webpack` (Turbopack cannot follow this snapshot's external node_modules symlink). Lighthouse 12.8.2, Mobile, **DevTools throttling**, default 412 × 823 / DPR 1.75, performance category only, fresh browser profiles. One baseline and one principal comparison per route; final verification followed the static AVIF proxy exclusion and matching svh sizes correction. Scores are individual observations, not statistically significant changes.

An accidental build command was issued from the repository root and failed during TypeScript configuration parsing. It may have touched build metadata in the root .next directory. Port 3000 was never accessed; all successful builds and browser measurements used the snapshot.

Browser request/geometry comparisons used 390 × 844 / DPR 1.75, 768 × 1024 / DPR 2, 1440 × 900 / DPR 1 and 2, and 844 × 390 / DPR 2. Each comparison used a fresh context and the same scroll sequence. All 20 combinations retained identical image geometry, focal positions, visibility and overflow behavior. Separate checks cover the new crop's boundaries and AVIF-disabled native WebP fallback.

Raw Lighthouse reports/traces, browser request logs, initial HTML, asset metadata, screenshots and side-by-side quality comparison remain in the snapshot. The tables below preserve the important measurements in the repository.

## Confirmed corrections

- Next route prefetch evaluated hero preload hints from other public pages. These downloaded high-priority photos without navigation, including through the desktop navigation hidden on mobile. Static photo destinations now explicitly disable prefetch in navigation, content links, footer, coach details and the error page. Account and booking prefetch behavior is retained.
- Literal preload links produced duplicate head markup alongside Next/React resource hints. React DOM `preload()` now emits a single hint per responsive source. EditorialHero derives exclusive hints directly from its AVIF sources; Home has complementary phone/tablet and desktop hints. All four pages preload in the initial HTML head. The native image is eager and high priority; one appropriate AVIF variant downloads and is reused in every tested viewport.
- All three editorial narrow-phone heroes discarded invisible parts of square bitmaps. Courts uses a 627 × 941 source crop (427/627px derivatives); Club and Coaching use 683 × 1024 source crops (427/683px derivatives). These preserve the original focal positions (30%, 18%, 60%), vertical source detail and existing compression settings. Club also retains more of its available vertical detail than its former 896px square candidate. The square crop remains for broader phones; the full photo remains for wide frames. Media bounds guarantee the new crop covers the entire clamped frame. Sizes now use svh to match actual hero CSS.
- Club's terrace and desktop community photographs used original full-size files. They now reuse Home's existing responsive AVIF/WebP candidates, with sizes accounting for object-cover. Originals remain intact.
- AVIF was missing from the proxy's static image exclusion and unnecessarily invoked session verification. AVIF now bypasses session refresh like WebP. Private avatar endpoints still match the proxy.
- Derivatives are committed static assets; the one-time generation scripts were removed after use. Home's coaching-session WebP candidates are byte-identical to Courts' and are served from `/images/courts/`; Home keeps its own AVIF encodes.

## Lighthouse comparisons

Image bytes are the sum of encoded image response bodies observed during each Lighthouse navigation, including native lazy loading and previously speculative heroes. These are not full-page scroll totals. Headers add approximately 300 bytes per uncached response in browser Resource Timing.

| Route | Image issue | Files changed | Image bytes before/after | LCP before/after | Lighthouse before/after |
|---|---|---|---|---|---|
| / | Other routes’ heroes prefetched; missing desktop hint | page.tsx; shared navigation | 233,501 → 100,160 B | 2.25 → 2.26 s | 97 → 97 |
| /courts | Square phone crop; speculative Home hero | courts/page.tsx; EditorialHero; narrow variants; generator | 214,316 → 133,934 B | 2.63 → 2.18 s | 96 → 98 |
| /coaching | Square phone crop; speculative Home hero; duplicate hints | coaching/page.tsx; EditorialHero; narrow variants; shared navigation | 110,976 → 39,744 B | 2.36 → 1.97 s | 97 → 98 |
| /club | Square phone crop; full-size lower photos; speculative Home hero | club/page.tsx; EditorialHero; narrow variants; shared navigation | 172,318 → 111,801 B | 2.88 → 2.68 s | 93 → 94 |

## Original asset inventory

Dimensions and actual on-disk byte sizes. Runtime pages use derivatives unless noted; retained originals are not evidence of a runtime transfer problem.

| Original | Dimensions | AVIF bytes | WebP bytes |
|---|---|---|---|
| tennis-club-aerial | 1536 × 1024 | 388159 | 489070 |
| tennis-coaching-session | 1536 × 1024 | 158329 | 234844 |
| tennis-courts-facilities | 1672 × 941 | 274017 | 366350 |
| tennis-courts-public | 1672 × 941 | 216910 | 299232 |
| tennis-hero-desktop | 1942 × 809 | 160918 | 232156 |
| tennis-hero-mobile | 1122 × 1402 | 190732 | 273626 |
| tennis-matches-community | 1536 × 1024 | 185766 | 257948 |

## Every static image instance

Rendered boxes and actual selected AVIF files after scrolling. Mobile is 390px / DPR 1.75, tablet is 768px / DPR 2, desktop is 1440px / DPR 1. Hidden pixels required by object-cover are included in source selection. Original artwork bounds intrinsic resolution; images are never upscaled during generation. Required intrinsic width is max(rendered width, rendered height × source aspect ratio) × DPR, up to the available source limit. AVIF quality remains 45 for Home/Club/Coaching and 55 for Courts; WebP remains 82. Home retains effort 5 and the other AVIF variants effort 6. All images are native picture/img, with WebP fallback. Only the first photo on each route is eager/high priority and preloaded; all remaining photos use native lazy loading and async decoding.

| Route / image | Mobile box; selected file (bytes) | Tablet box; selected file (bytes) | Desktop box; selected file (bytes) |
|---|---|---|---|
| / — hero | 390 × 363; tennis-hero-mobile-768.avif (52340) | 422 × 500; tennis-hero-mobile-1122.avif (99767) | 1440 × 677; tennis-hero-desktop-1942.avif (91102) |
| / — Aerial view of a clay-court tennis club with clubhouse and surrounding greenery | 366 × 244; tennis-club-aerial-768.avif (47820) | 704 × 469; tennis-club-aerial-1536.avif (166925) | 709 × 473; tennis-club-aerial-768.avif (47820) |
| / — Clay tennis court with clubhouse, lighting and player facilities at TennisClub | 342 × 192; tennis-courts-facilities-768.avif (32338) | 704 × 396; tennis-courts-facilities-1672.avif (127202) | 1280 × 720; tennis-courts-facilities-1672.avif (127202) |
| / — A coach guides a player during a practice session on a clay tennis court | 366 × 244; tennis-coaching-session-768.avif (30447) | 704 × 469; tennis-coaching-session-1536.avif (87949) | 700 × 467; tennis-coaching-session-768.avif (30447) |
| / — Four tennis players talking together beside a clay court | 366 × 244; tennis-matches-community-768.avif (32618) | 704 × 469; tennis-matches-community-1536.avif (91070) | 700 × 467; tennis-matches-community-768.avif (32618) |
| /courts — hero | 390 × 726; tennis-courts-public-narrow-627.avif (46663) | 768 × 860; tennis-courts-public-1672.avif (152620) | 1440 × 774; tennis-courts-public-1672.avif (152620) |
| /courts — A player sliding into a forehand on a clay court, kicking up a trail of clay dust | 390 × 293; tennis-clay-slide-768.avif (42104) | 704 × 528; tennis-clay-slide-1079.avif (68912) | 709 × 567; tennis-clay-slide-768.avif (42104) |
| /courts — A player strikes a backhand on a clay court while a coach feeds balls from a basket | 390 × 260; tennis-coaching-session-768.avif (45167) | 704 × 469; tennis-coaching-session-1536.avif (126321) | 709 × 473; tennis-coaching-session-768.avif (45167) |
| /coaching — hero | 390 × 726; tennis-coaching-session-narrow-683.avif (39744) | 768 × 860; tennis-coaching-session-1536.avif (126321) | 1440 × 774; tennis-coaching-session-1536.avif (126321) |
| /club — hero | 390 × 726; tennis-club-aerial-narrow-683.avif (78820) | 768 × 860; tennis-club-aerial-1536.avif (166925) | 1440 × 774; tennis-club-aerial-1536.avif (166925) |
| /club — A wooden bench, rackets and a basket of balls beside a clay court as the sun sets behind olive trees | 390 × 293; tennis-courts-public-story-768.avif (32981) | 704 × 528; tennis-courts-public-story-1255.avif (73938) | 538 × 673; tennis-courts-public-story-1024.avif (52910) |
| /club — Four players chatting beside a clay court after a game, with the clubhouse terrace behind them | Hidden; no request | Hidden; no request | 493 × 617; tennis-matches-community-1152.avif (55957) |
| /club — The clubhouse terrace with lounge seating and potted olive trees, set above a clay court | 390 × 293; tennis-courts-facilities-768.avif (32338) | 704 × 302; tennis-courts-facilities-1672.avif (127202) | 1280 × 549; tennis-courts-facilities-1672.avif (127202) |

The retained favicon is `src/app/favicon.ico`: 25,931 bytes with 16 × 16, 32 × 32, 48 × 48 and PNG-compressed 256 × 256 entries. It is a document icon rather than page content, is not preloaded, and does not participate in LCP. No confirmed runtime delivery problem justified replacing it.

## Remaining image-bearing components and route coverage

The complete src tree was searched for img, picture, next/image, SVG image references, CSS backgrounds, URL images and video posters. There are no remaining Next Image consumers, CSS photo backgrounds or JavaScript image-loading systems. Icons and placeholder avatars are inline SVG, with no external image requests.

- Public: /, /courts, /coaching, /club were measured before/after. Coach detail pages have no photos; only their outbound photo-route prefetch policy changed. /book has no photos. The shared header/footer correction also avoids speculative photo downloads elsewhere.
- Authentication: /login, /signup, /signup/check-email, /forgot-password, /reset-password and callback/error flows have no page photos.
- Account: /account, /profile/personal, /profile/security, /profile/tennis, /messages and detail pages, /my-activity/bookings, /my-activity/history and reservation/booking forms have no static page photos. /profile uses its existing authenticated native avatar, eager, fixed 112px mobile and 144px from sm.
- Administration and Coach: locations, court/pricing workspaces, club settings, payments, users, bookings/reservations and coaching program/price/availability/detail screens have no static photos. Admin user tennis details have a fixed 112px mobile / 208px desktop avatar frame, with no layout shift when the image arrives.
- Shared profile navigation uses a 20px or 28px native lazy avatar. Both avatar endpoints retain private, no-store delivery; stored images are normalized WebP within 512 × 512, quality 82, without enlargement. This provides adequate intrinsic resolution for the profile/admin frames at DPR 2. Reusing the existing bounded object avoids introducing runtime transformations or a new storage delivery path. No avatar code or persistence changed.

Authenticated account/admin states were source-audited; no logged-in uploaded-avatar network/quality benchmark was performed. Signed-out auth/account/admin/booking routes were checked in Chrome, including redirects.

## Lazy loading, discovery and remaining limits

Club's terrace falls from 274,017 to 32,338 bytes on mobile; community falls from 185,766 to 55,957 bytes at desktop DPR 1. The mobile-hidden community photo remains unrequested. No additional below-the-fold images are preloaded or high priority. Native lazy images may request before scrolling when near the browser's threshold or the initially streamed layout; those requests remain low priority. Under throttling, Courts' lower photographs begin after its LCP image has finished. No IntersectionObserver, forced delays or scripted lazy loading were introduced.

The reported Courts 61 KiB image-delivery opportunity concerns 768px lower photographs shown at 412px. At Lighthouse DPR 1.75, 721 intrinsic pixels are required: 768px is appropriate. Downsizing these to 480px would trade away resolution. Those working sources were retained.

Courts' principal comparison reduced hero bytes 74,705 → 46,663, image load duration about 1,992 → 1,521ms, and LCP 2.63 → 2.16s. Discovery delay stayed about 580ms with the effective, reused head hint. Lighthouse DevTools applies 562.5ms request latency; the final trace starts the hero around 589ms, before the document completes around 655ms. Two high-priority font preloads (34,940 and 48,432 bytes) start around 576ms; the 92,753-byte stylesheet starts around 592ms at very high priority. The image does not wait for hydration. These requests and connection scheduling remain; no font or dependency changes were made. Club's final narrow hero remains 78,820 bytes, with preserved source detail; no unsupported quality reduction was applied to chase a score.

AVIF-disabled browser checks select native WebP without a double download. Only AVIF is hinted, intentionally avoiding simultaneous AVIF and WebP preload downloads in browsers supporting both; older browsers discover the eager WebP fallback in picture.

## Validation

- 1,998 unit/component tests passed across 184 files; focused tests additionally verify the AVIF proxy exclusion and protected avatar endpoints.
- Full ESLint passed; changed-file lint passed after final corrections.
- Standalone typecheck passed in the isolated snapshot; final isolated production build passed its TypeScript check and all 63 generated pages.
- 20 paired viewport/route comparisons passed: matching head hint, single high-priority hero request, link-initiated preload reuse, identical image geometry/focal positions/visibility/overflow.
- 33 additional boundary, WebP fallback and signed-out route checks passed, recorded in verification.json.
- Side-by-side image quality comparison showed preserved crop and adequate detail. Static originals and all pre-existing assets were retained.
