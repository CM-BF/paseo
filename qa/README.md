# Plugin API QA evidence

Source commit: `804d1658e` on top of upstream `83ed52669`.

These files come from isolated automated runs using temporary generic fixtures. There are no installable plugins, pet assets, or production workspaces in this evidence branch. The branch is separate from the code PR.

`validation.log` contains commands, server/loader tests, all six browser flows, and commit-hook formatting/lint/type checks. `sdk-boundaries.log` records 69 passing SDK boundary checks. `snapshots.log` records three passing immutable snapshot tests. ANSI color escapes are removed and local account/checkout/temp prefixes are replaced; other output is preserved. The intentional malformed-SVG and throwing-renderer cases emit warnings/errors and assert recovery.

Web verification ran in Chromium on macOS at desktop and compact viewport sizes. Compact web is not an iOS or Android run. Electron and native platforms have not been verified.

The recordings correspond to the six browser tests. Floating-widget fixtures deliberately use simple controls and transparent content to exercise host-provided dragging and click-through behavior. The screenshots illustrate an API fixture, not a bundled product design.
