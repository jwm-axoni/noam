# Current app baseline

Development uses the application source from Noam 0.1.59, source revision
`62c071f6deb44829fa1620203b0a66994d8639d5`, transferred onto the clean source root
`ce6778f6fa6531a9f61ce91c203e75dcf66e3bab`. This is a source-content migration,
not a merge of the original repository history.

The baseline retains the current app's desktop behavior, including macOS
titlebar spacing, compact account controls, responsive menus, accent and heading
preferences, note-move recovery, per-note Properties state and graph filtering.
The executable and desktop package version match 0.1.59. Server account-page
branding follows the same source revision.

Publication safeguards remain deliberate differences:

- Keep the existing first-party licensing decision and required third-party notices.
- Keep synthetic fixtures and deployment configuration free of personal defaults.
- Keep distribution updater endpoints and signing configuration disabled until a
  release workflow supplies reviewed settings.
- Preserve publication checks, documentation cleanup and the clean Git root.

Before the feature changes were carried forward, 415 of the source revision's
419 desktop frontend files matched byte-for-byte. The other four differ only in
synthetic test paths, a path example in a comment and updater documentation.
The baseline desktop suite passed 1,605 tests, with 12 skipped and one todo.
The frontend production build and tree publication scan passed.

These local results establish a tested source baseline. They do not establish
feature acceptance, hosted CI, native UI correctness, signing or notarization.
Feature integration requires fresh checks and native evidence from the new build.
