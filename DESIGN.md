# Atodotren frontend design system

Status: frontend alpha implementation reference. This document defines visual intent, not final brand acceptance.

## Principles

Atodotren combines three modes without becoming three products: **Civic Flow** on the landing/overview, **Transit Canvas** for live schematic state, and **Evidence Ledger** for historical analysis. The interface is editorial and flat. Hierarchy comes from type, spacing, rules and semantic color before elevation. Cards are reserved for independently actionable, selectable, stateful or portable blocks.

The voice is factual and incisive: show the evidence, expose missing evidence, and never turn inferred feed state into false precision. Landing surfaces may be energetic; analytical surfaces are calmer. Every data view keeps freshness, coverage, finalization and precision visible.

## Typography and layout

- Primary family: system sans stack, optimized for fast standalone/PWA rendering.
- Numerical values use tabular numerals.
- Measure: 72rem maximum content width; long methodology text stays around 70 characters.
- Base spacing unit: 4px. Primary rhythm: 8 / 12 / 16 / 24 / 32 / 48 / 64px.
- Compact radii: 6px controls, 10px stateful blocks, 16px floating shell. Avoid decorative pill overload.
- Shadows: only floating navigation, popovers and true overlays; ordinary analysis sections use borders/separators.

## Color

Semantic tokens live in `apps/web/src/app/globals.css`; chart/line constants live in `lib/design/tokens.ts`. Light and dark themes share meaning rather than literal colors.

Delay states:

- early/on-time: <= 120s, green semantic state;
- mild: 121-300s, yellow/amber;
- delayed: 301-600s, orange;
- severe: >600s, red;
- canceled/skipped/missing/pending: separate patterns/text labels, never encoded by hue alone.

Coverage/freshness:

- healthy: fresh feed and normal coverage;
- partial: usable but incomplete coverage;
- stale: source timestamp beyond the live freshness threshold;
- outage: no usable current source;
- cached/offline: last successful important response, always timestamped;
- overnight: no active trains is a valid state, not an outage.

Cercanías colors use source line colors when available; fixture fallback colors are centralized. Text never depends on a line color for legibility.

## Charts and matrices

Recharts is used for conventional trends/distributions/rankings. Charts use semantic CSS variables and concise tooltips; exact values remain available in adjacent text. Animations are short and disabled by `prefers-reduced-motion`.

The timetable matrix is semantic HTML/CSS, not canvas. Rows are stops, columns are scheduled journeys. Every applicable cell displays scheduled time, has a textual state, is keyboard focusable and exposes detail. Delay background is supplementary to symbols/labels. No virtualization is introduced until measured DOM/render cost justifies it.

The live railway view is a custom accessible SVG. It is explicitly schematic. Coordinates are isolated in the network layout module and may fall back to topology-derived spacing; neither mode is presented as geographic/GPS placement.

## Motion

Default transitions are 140-240ms. The floating navigation drawer animates measured height and the hamburger morphs with CSS. Live refresh uses a subtle 30-second progress indicator while retaining existing content. Reduced-motion disables nonessential interpolation and progress animation.

## Shell

The floating sticky shell adapts the interaction quality of Termómetro de Madrid without copying its product structure: measured-height expansion, inert hidden menu content, focus restoration, mobile hide-on-scroll/reveal, route context, language/theme controls and a global auto-refresh switch.

## Brand replacement boundary

Working name, wordmark, symbol label, PWA colors and placeholder train mark are centralized under `lib/brand`. Product strings are not scattered through components. The placeholder geometric train symbol is deliberately simple and replaceable.

## Accessibility

Target WCAG 2.2 AA. Visible focus, 44px mobile targets where practical, semantic landmarks/headings/tables, keyboard-operable SVG train controls and matrix cells, `aria-live` only for meaningful refresh state, reduced-motion support, sufficient contrast and non-color status cues are required. Automated axe checks complement, not replace, manual keyboard/screen-reader review.
