# andén infinito frontend design system

Status: frontend alpha implementation reference with the accepted product brand, mark, and palette.

## Principles

andén infinito combines three modes without becoming three products: **Civic Flow** on the landing/overview, **Transit Canvas** for live schematic state, and **Evidence Ledger** for historical analysis. The interface is editorial and flat. Hierarchy comes from type, spacing, rules and semantic treatment before elevation. Cards are reserved for independently actionable, selectable, stateful or portable blocks.

The voice is factual and incisive: show the evidence, expose missing evidence, and never turn inferred feed state into false precision. Landing surfaces may be energetic; analytical surfaces are calmer. Every data view keeps freshness, coverage, finalization and precision visible.

## Typography and layout

- Primary family: system sans stack, optimized for fast standalone/PWA rendering.
- Numerical values use tabular numerals.
- Measure: 72rem maximum content width; long methodology text stays around 70 characters.
- Base spacing unit: 4px. Primary rhythm: 8 / 12 / 16 / 24 / 32 / 48 / 64px.
- Compact radii: 6px controls, 10px stateful blocks, 16px floating shell. Avoid decorative pill overload.
- Shadows: only floating navigation, popovers and true overlays; ordinary analysis sections use borders/separators.

## Color

The final product palette is intentionally narrow and is centralized in `apps/web/src/app/globals.css`.

Light:
- background: `#F6E4E2`;
- surface/cards: `#FFFFFF`;
- text: `#3A1B22`;
- primary accent: `#7A3B4A`.

Dark:
- background: `#221016`;
- surface/cards: `#2E161C`;
- text: `#F6E4E2`;
- primary accent: `#C98A98`.

All interface accents, charts, focus treatment, icons, freshness markers and delay-state emphasis are derived from those colors. Delay and evidence states are differentiated through intensity, symbols, labels and patterns rather than introducing unrelated green/amber/red/blue accent hues.

Cercanías line colors are the deliberate exception: they remain source transport-identity data on line badges and schematic route strokes. They are not part of the andén infinito interface palette, and surrounding UI never reuses them as generic accents.

## Charts and matrices

Recharts is used for conventional trends/distributions/rankings. Charts use semantic CSS variables and concise tooltips; exact values remain available in adjacent text. Animations are short and disabled by `prefers-reduced-motion`.

The timetable matrix is semantic HTML/CSS, not canvas. Rows are stops, columns are scheduled journeys. Every applicable cell displays scheduled time, has a textual state, is keyboard focusable and exposes detail. Delay background is supplementary to symbols/labels. No virtualization is introduced until measured DOM/render cost justifies it.

The live railway view is a custom accessible SVG. It is explicitly schematic. Coordinates are isolated in the network layout module and may fall back to topology-derived spacing; neither mode is presented as geographic/GPS placement.

## Motion

Default transitions are 140-240ms. The floating navigation drawer animates measured height and the hamburger morphs with CSS. Live refresh uses a subtle 30-second progress indicator while retaining existing content. Reduced-motion disables nonessential interpolation and progress animation.

## Shell

The floating sticky shell adapts the interaction quality of Termómetro de Madrid without copying its product structure: measured-height expansion, inert hidden menu content, focus restoration, mobile hide-on-scroll/reveal, route context, language/theme controls and a global auto-refresh switch.

## Brand assets

The supplied final andén infinito SVG is the canonical geometry. The in-app mark uses `currentColor`, so it resolves to `#7A3B4A` in light mode and `#C98A98` in dark mode. The favicon uses the tightly cropped mark in the light primary accent. PWA icons use the same cropped mark in `#7A3B4A` on `#F6E4E2`, with a separate maskable-safe variant.

## Accessibility

Target WCAG 2.2 AA. Visible focus, 44px mobile targets where practical, semantic landmarks/headings/tables, keyboard-operable SVG train controls and matrix cells, `aria-live` only for meaningful refresh state, reduced-motion support, sufficient contrast and non-color status cues are required. Automated axe checks complement, not replace, manual keyboard/screen-reader review.
