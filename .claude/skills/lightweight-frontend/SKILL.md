---
name: lightweight-frontend
description: Use whenever building or changing frontend code in this project. Enforces minimal dependencies, small bundles, fast load times and a plain, uncluttered visual style.
---

# Lightweight frontend rules

## Dependencies
- Prefer semantic HTML, modern CSS (grid, flex, custom properties, :has, container queries) and vanilla JS/TS. No UI framework unless I approve it.
- Before adding ANY npm dependency, state its gzipped size and why the platform can't do it; ask first.
- No CSS frameworks or component libraries. One small stylesheet built on design tokens (colors, spacing scale, type scale) as CSS custom properties.
- Icons: inline SVG only, no icon packages.

## Performance budgets
- JS < 50 KB gzipped, CSS < 20 KB gzipped.
- LCP < 2.5s, CLS < 0.1, INP < 200ms.
- System font stack, or at most one self-hosted variable font with font-display: swap.
- Images: modern formats (AVIF/WebP), explicit width/height, loading="lazy" below the fold.
- No render-blocking third-party scripts.

## Visual style
- Restrained palette: neutrals plus one accent color.
- Generous whitespace, clear type scale, line length under ~75 characters.
- No gradients, heavy shadows or decorative animation unless they serve a purpose.
- Respect prefers-reduced-motion and prefers-color-scheme.
- Visible keyboard focus, sufficient contrast, responsive down to mobile.
