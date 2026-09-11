# UI repair after v148 feedback

The v148 visual changes were not acceptable to the owner. Passing tests did not establish visual quality or the feel of the installed phone app.

## Corrections

- Remove broad 44px minimum-size and wrapping overrides that inflated the header, reader toolbar and navigation. Preserve the earlier soft-card shadows, subtle rims, tinted summary card and text-size controls.
- Replace the collapsed “Today's big picture” block with a visible “In brief” list of the five leading stories. No native disclosure marker or extra navigation row above it.
- Restore Settings through the masthead and Saved through the search control. The search control clears a previous query when reopened.
- Hide both bars when scrolling down and restore them when scrolling up, retaining horizontal centering. The prior override set `transform:none`, removing the bottom bar's `translateX(-50%)` centering and shifting it sideways.
- Keep a compact 48px single-row navigation bar on every phone; use Index and Stories labels at narrow widths. The wordmark, date cycler and dashboard buttons also remain on one row; narrow phones omit the visible year while retaining the full date in its accessible label. Respect horizontal safe-area insets in landscape.
- Restore Mapbox Satellite Streets as the map style, retaining lazy loading.
- Preserve full-page sliding between articles. Adjacent opaque pages are prepared between gestures; both pages follow the finger at 1:1 displacement. Release settles from the current offset in 80–220ms according to remaining distance and velocity. Cancellation returns to the same story. There is no fade or static article-swap animation.
- Keep the reader frame opaque and remove temporary panels after completion, cancellation, exit and reduced-motion navigation.

## Verification

Phone-width matrix: 280, 320, 350, 360, 375, 390, 412, 440, 480 and 600 CSS pixels, plus 844×390 landscape. The 280px check initially caught clipped navigation; shorter narrow-screen labels resolved it. Header controls stay in bounds. The navigation remains horizontally centered during its vertical hide/reveal transition.

Browser touch-event checks: dragging -110px put the outgoing page at -110px and incoming page at +330px in a 440px viewport. Next/previous, under-threshold cancellation, direction reversal, first-story boundary and reduced-motion cleanup passed without browser errors. The satellite style loaded and Settings/Search navigation worked. Light/dark previews inspected. Automated tests include five new carousel behavior checks alongside the existing suite.

These are browser/emulated-touch checks, not a claim of physical-device testing or owner approval. The owner's visual and motion feedback remains the acceptance standard.

## Disclosure and spacing refinement (v152)

- Replace native disclosure triangles and UI navigation arrow glyphs with a thin SVG chevron. Native summaries rotate it down when open; story-group expansions use the same shape. Map playback uses SVG play/pause icons.
- Restore the daily overview as a compact, collapsed disclosure, keeping the five quick story lines visible beneath it. Weekly and reference disclosures share its typography and marker treatment.
- Use Index and Stories at all screen sizes. Index contains People, Companies and Terms; existing deep-link routes stay compatible. Replace the former Storylines wording in navigation, headings, help copy and return links.
- Align comparable card padding (12px vertical, 14px horizontal), list gaps (8px), block gaps (12px), and section separation (20px). Preserve reading paragraphs, timeline structure, safe areas, one-row chrome and directional auto-hide.
- Browser checks: 280–1024px width matrix, no horizontal overflow and one navigation row; Briefing, Weekly, Index/Terms, Stories, Desk and Status rendered without runtime errors. Inspected light/dark and expanded states; keyboard disclosure toggling and full-page finger-tracked reader swiping passed. These are emulated browser checks, not physical-device certification.

## Shared dropdown and bottom-edge correction (v153)

Daily and weekly disclosures now use the same `synthesis-dropdown` component, not just matching chevrons. Computed closed height (50px), padding, tint, border, radius, shadow and summary typography match exactly. Body typography also shares one rule.

Story hold previews attach to bottom:0 with square bottom corners, rounded top corners and home-indicator padding inside the sheet. The close control no longer floats into and narrows the hero image. Opening the preview through a touch hold and tapping Open story now works on the first tap even when the prevented release generated no synthetic click.

The navigation keeps one row, reduces its side gutters to 8px (or the larger safe-area inset), and rests at max(6px, bottom safe area). Content clearance includes the same safe area. Verified preview bottom equals viewport bottom at 280, 320, 390 and 440px portrait widths and 844px landscape; no horizontal overflow. Desktop preview width remains capped. Browser checks do not substitute for physical iPhone inspection.
