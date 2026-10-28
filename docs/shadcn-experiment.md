# shadcn redesign experiment

Branch: `experiment/shadcn-redesign`. Preview: `bun server/index.js`, open `/shadcn.html`.
Legacy page (`/`) untouched. Both share `/api/dashboard` and localStorage keys
(`tmx_*`), so period/harness/model selections carry across pages.

## Approach: shadcn visual language, zero framework weight

Real shadcn (React + Radix + Tailwind) would add a build step and ~100KB+ of
JS to a page that currently ships none. The "shadcn look" that matters for this
call is reproducible by hand:

- zinc dark theme tokens (`--background/--card/--muted/--border/...`)
- `radius: .5rem`, Inter, `Geist Mono` numerals
- Card / Button / Badge / Tabs / Table / Progress / Dialog / Skeleton primitives

So the experiment is two hand-written files, no dependencies:

| File | Raw | Notes |
|---|---|---|
| `public/index.html` (legacy) | 54,614 B (14,413 gz) | baseline |
| `public/shadcn.html` | 46,396 B | full page, own CSS+JS |
| `public/tmx.js` | 10,852 B | shared pure data engine |
| shadcn total | 57,248 B (15,359 gz) | **+6% vs legacy** |

`tmx.js` holds the aggregation/filter/calendar math. The legacy page keeps its
inline copy, so a `public/tmx.js` regression can only ever break the experiment
page, never `/`.

## Layout decisions

1. **Sticky topbar replaces the profile row.** Brand + nav + avatar on the right
   follows the shadcn dashboard template. Saves one full row of vertical space;
   Share/Edit collapse into icon/avatar buttons (Dialog for the edit form).
2. **8 stat cards → 4 KPI cards.** Only Total Tokens, Top Model, Active Days are
   primary scans; Streak/Input/Output move into card sub-lines. Adds a Cache Hit
   Rate KPI, which the legacy page buries inside rows.
3. **Period picker moves to the page head.** DeepSeek Platform style: the control
   that affects every stat sits above them, with the resolved range label next
   to it. The chart keeps its own independent 30D/ALL toggle.
4. **Harness + Breakdown side-by-side → one Breakdown card with Models/Harness
   tabs.** The old .6fr harness column was cramped; tabs give each table full
   width. Shares render as Progress bars (shadcn Table + Progress idiom).
5. **Legend loses rank numbers.** Cleaner scan; ranking is already implied by
   order + percentage.

Kept identical: /api/dashboard contract, canvas chart engine + tooltip/pin,
stats semantics (period window, cache-hit definition), localStorage keys.

## Verification (real data, 99 days / 5 sources / 20 models)

- `node --check` on both JS blobs: clean
- Browser DOM shows 64.22B total / 30.73B top model / 99 active days on both pages
- Harness tab + mobile 390px layouts render; no console errors
- Chart tooltip, source/model toggles, custom calendar, edit dialog all wired

## Open questions for adoption

- React-ify for real, or keep the vanilla shadcn-style page? The current split
  (two pages sharing one JSON contract) is tenable but duplicates markup logic
  (`tmx.js` covers data only, not rendering).
- If adopted: fold `index.html` onto `tmx.js` too, so the engine isn't forked.
