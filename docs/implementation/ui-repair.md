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
