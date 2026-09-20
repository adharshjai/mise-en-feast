# Pantry — design notes

Warm dark ground, liquid-glass controls, one orange accent, and otherwise the restraint of a
serious product site: plain language, a lot of quiet, nothing that glows or floats. The glass
is the identity; everything around it stays still so the glass reads as material, not effect.

## Tokens (`shared/tokens.css`)

| Role | Light (default) | Dark (`html[data-theme="dark"]`) |
|---|---|---|
| Ground | `#F5F0E3` cream, flat (no ambient gradients) | `#12100E` near-black with a brown undertone |
| Raised surface | `#FFFCF4` for content cards | `#1C1917` |
| Text | `#23211A`; secondary `#5D5B50`; hints `#78766B` | `#F4EFE8`; secondary `#A8A29E`; hints `#8F8880` |
| Accent | `#0B6E4F` emerald fills, `#0A5C42` for text and icons, cream text on it. Primary actions only (Scan, Cook, Add to pantry, Done, Continue) | `#2EBD7C` fills, `#5FD9A0` text, dark text on it |
| Slate | `#64748B` for skip and neutral states | same |
| Freshness | green `#1FA463`, yellow `#E0A100` (`#94650A` as text), red `#D9363E` — these three appear nowhere else | `#3DD68C`, `#F5C242`, `#FF5A4E` |
| Hairline | `rgba(var(--ink), .08)` for dividers; `--ink` is the text colour as an rgb triplet | same rule, light ink |

The theme is chosen from the profile menu in the app and saved per browser; a head script on every page applies it before first paint. Layout files never hardcode a colour: use the tokens, `rgba(var(--ink), a)` for hairlines and hovers, `rgba(var(--accent-rgb), a)` for tints, and `rgba(var(--shadow), calc(a * var(--shadow-k)))` for shadows.

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
