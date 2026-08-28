# andén infinito frontend design system

Status: implemented frontend design reference with the accepted product brand, mark, palette, and interaction patterns.

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

The product keeps a narrow burgundy base palette while using a deliberate semantic status palette. Both are centralized in `apps/web/src/app/globals.css`; semantic colors are data/status language, not decorative accents.

Base light palette:
- background: `#F6E4E2`;
- surface/cards: `#FFFFFF`;
- text: `#3A1B22`;
- primary accent: `#7A3B4A`.

Base dark palette:
- background: `#221016`;
- surface/cards: `#2E161C`;
- text: `#F6E4E2`;
- primary accent: `#C98A98`.

Healthy, warning, danger, unknown and evidence-state colors use dedicated green/amber/red/blue-purple tokens with light/dark variants chosen for contrast. The landing positive/delay accents and the matrix heatmap reuse or interpolate those semantic tokens. Color is never the sole state carrier: text, symbols, patterns, labels and accessible names retain the meaning independently.

Cercanías line colors are a separate transport-identity data set. They remain source identity on line badges and schematic route strokes and are not reused as generic interface status colors.

## Charts and matrices

Recharts is used for conventional trends/distributions/rankings. Charts use semantic CSS variables and concise tooltips; exact values remain available in adjacent or screen-reader-only tabular text. Animations are short and disabled by `prefers-reduced-motion`.

Timetable matrices use semantic HTML/CSS grid structures rather than canvas. Every applicable cell remains a real keyboard-operable button with a textual state and detail surface, while row/column/grid roles expose the matrix structure to assistive technology. Large matrix surfaces use TanStack Virtual after browser profiling showed the need for a bounded DOM; only the large axis is virtualized in each view. Do not introduce virtualization on smaller surfaces without measured pressure.

The live railway view is a custom accessible SVG. It is explicitly schematic. Coordinates are isolated in the network layout module and may fall back to topology-derived spacing; neither mode is presented as geographic/GPS placement.

## Motion

Default transitions are 140-240ms. The floating navigation drawer expands in place and the hamburger morphs with CSS. Live refresh uses a subtle 30-second progress indicator tied to the same refresh policy as the server live-cache interval. Reduced-motion disables nonessential interpolation and progress animation.

## Shell

The floating sticky shell adapts the interaction quality of Termómetro de Madrid without copying its product structure: in-place expansion, inert hidden menu content, focus restoration, mobile hide-on-scroll/reveal, route context, language/theme controls and a global auto-refresh switch. A narrow route-scroll coordinator preserves the intended browser semantics across App Router transitions: pathname-changing forward navigation starts at the top, while Back/Forward restores the last recorded position for the destination route instead of globally resetting every route change.

## Brand assets

The supplied final andén infinito SVG is the canonical geometry. The in-app mark uses `currentColor`, so it resolves to `#7A3B4A` in light mode and `#C98A98` in dark mode. The favicon uses the tightly cropped mark in the light primary accent. PWA icons use the same cropped mark in `#7A3B4A` on `#F6E4E2`, with a separate maskable-safe variant.

## Accessibility

Target WCAG 2.2 AA. Visible focus, 44px mobile targets where practical, semantic landmarks/headings/tables or grids, keyboard-operable SVG train controls and matrix cells, `aria-live` only for meaningful refresh state, reduced-motion support, sufficient contrast and non-color status cues are required. Automated axe checks complement, not replace, manual keyboard/screen-reader review.
