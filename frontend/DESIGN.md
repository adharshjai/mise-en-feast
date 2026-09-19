# Pantry — design notes

Warm dark ground, liquid-glass controls, one orange accent, and otherwise the restraint of a
serious product site: plain language, a lot of quiet, nothing that glows or floats. The glass
is the identity; everything around it stays still so the glass reads as material, not effect.

## Tokens (`shared/tokens.css`)

| Role | Value |
|---|---|
| Ground | `#12100E` near-black with a brown undertone, flat (no ambient gradients) |
| Raised surface | `#1C1917` for content cards |
| Text | `#F4EFE8`; secondary `#A8A29E`; hints `#8F8880` |
| Accent | `#FF7A1A` flat orange, dark text on it. Primary actions only (Scan, Cook, Add to pantry, Done, Continue) |
| Slate | `#64748B` for skip and neutral states |
| Freshness | green `#3DD68C`, yellow `#F5C242`, red `#FF5A4E` — these three appear nowhere else |
| Hairline | `rgba(255,255,255,.08)` for dividers |
| Radii | 24px cards, 28px sheets, pills for buttons |
| Glass | `.glass`: translucent white gradient, `backdrop-filter: blur(28px) saturate(170%)`, a 1px specular top edge, neutral shadow. Navigation layer only: nav capsule, buttons, badges, sheets, side panel, toasts. Never on content blocks. |
| Shadows | neutral and grey only. No coloured glow shadows, no `0 0 Npx` halos. |

## Type

- Headlines on the landing page: **Source Serif 4** regular, with one italic word ("A pantry that fills *itself*").
  Hero 56px, section titles 32px. Letter-spacing -0.01em.
- Everything else, including the app: **Outfit**. Dish names on cards 34px/800 tight (they are the one
  loud thing on a card); sheet titles 24/700; body 15; captions 13; key hints 11.

Google Fonts link for the landing: `https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;1,8..60,400&display=swap`
The app and login load Outfit only.

## Components

- **Primary button**: `.prominent` flat orange pill, dark text. **Secondary**: `.glass` pill.
  Hover: a 2px lift and a brighter surface. No glow.
- **Cards** (dishes): opaque `#1C1917`, 24px radius, three stacked neutral shadows, no border. Photo on top
  (real Unsplash photographs, credits in `img/CREDITS.md`), then the name, a meta line, ingredient chips.
  Badge over the photo: tinted glass pill with a plain coloured dot, no halo.
- **Sheets / panel**: denser glass (`.sheet.glass`), 28px radius, neutral shadow. Veil `rgba(18,16,14,.62)`.
- **Toast**: glass pill, top centre under the bar.
- **Icons**: inline stroke SVG, currentColor. No emoji. No icon on every row.

## Landing page

One centred column: 1100px max for the nav and grids, 760px for the hero, 640px for reading sections.
Sections are separated by space and single hairlines, never boxes. No animation of any kind on the
page (no floating cards, no sway, no parallax). The product is shown once, as the real card.

## Writing

Plain and specific, in the words a person would use. No invented numbers, testimonials, logos or
prices; a missing fact is a visible placeholder like [HACKATHON NAME].
