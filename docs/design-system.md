# Design System

## Status

The global design foundation is intentionally centralized so individual pages/components do not invent independent palettes or typography.

`src/app/globals.css` is the source of truth for theme tokens and Tailwind CSS v4 semantic mappings.

This document defines direction and usage rules. Exact color values remain owned by the current tokens in `globals.css`.

## Visual direction

The selected photography is clay-court tennis imagery.

The interface should derive its character from:

- burnt clay / terracotta;
- deep forest green;
- warm ivory / chalk;
- sand / dusty neutrals;
- dark earth tones;
- tennis-ball yellow-green used only as a small energetic accent.

The result should feel:

- warm;
- earthy;
- athletic;
- editorial;
- understated;
- contemporary.

Avoid:

- generic blue-gray SaaS styling;
- neon green;
- pure black where a softer earth/forest tone works;
- large tennis-yellow surfaces;
- arbitrary per-component palettes.

Photography should provide much of the strong clay intensity. The UI should complement it rather than compete with it.

## Color hierarchy

Use semantic tokens rather than raw color values in components.

General hierarchy:

- **background** — warm ivory;
- **surface / elevated surface** — chalk/light warm surface;
- **foreground** — dark earth;
- **primary** — deep forest;
- **accent** — clay/terracotta;
- **muted** — sand/clay-soft neutrals;
- **border** — warm neutral;
- **tennis yellow-green** — tiny accent only.

Primary actions use forest with a clearly readable light foreground.

Clay is a visible brand accent but should not flood every surface.

## Tailwind CSS v4

Expose semantic tokens through `@theme inline`.

Keep page and layout utilities in JSX, and keep reusable component styling inside the component. Preserve runtime class selection for real state or variants. Reserve `globals.css` for stable application-wide styles and tokens; do not extract static utility strings into class constants or style maps.

Prefer utilities such as:

```text
bg-background
bg-surface
bg-surface-elevated
text-foreground
text-muted-foreground
bg-primary
text-primary-foreground
bg-accent
text-accent-foreground
border-border
ring-focus
font-sans
font-heading
```

Avoid raw arbitrary values in components when a semantic token exists.

## Typography

Use:

- **Archivo** for headings/display;
- **Inter** for body text, UI, forms, and controls.

Fonts are loaded with `next/font/google`.

Global font variables should be exposed through Tailwind:

```text
font-heading
font-sans
```

Do not import Google Fonts through CSS.

## Surfaces and controls

Base UI direction:

- page background: warm ivory;
- cards: light chalk/elevated surface;
- inputs: light surface with readable dark text;
- primary buttons: forest background with light foreground;
- secondary buttons: light/transparent surface with forest text and warm border;
- focus state: semantic focus token;
- errors/success/warning/info: semantic state tokens rather than generic saturated Tailwind colors.

Avoid excessively rounded generic SaaS styling.

## Photography assets

Photography under `public/` is user-provided product material.

Do not:

- delete;
- clean;
- rename;
- replace;
- optimize destructively;

unless explicitly instructed.

When building marketing/public-facing pages, use the selected photography as a first-class visual element rather than inventing decorative substitutes.

## Scope rule

A design-system task may establish or adjust tokens and shared primitives.

Do not use a theme task as justification to redesign every page, alter business behavior, or restructure unrelated components.

Page redesigns should be explicit tasks built on the global tokens.
