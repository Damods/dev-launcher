# Design QA — Remove outer application outline

- Source visual truth: `C:\Users\11859\AppData\Local\Temp\codex-clipboard-2d4f85d5-b6fa-403d-aa37-1905191b8453.png`
- Implementation screenshot: `E:\local work\tests\artifacts\outer-border-removed-1.5.4.png`
- Side-by-side comparison: `E:\local work\tests\artifacts\outer-border-comparison-1.5.4.png`
- Viewport: Dev Launcher desktop window at 1360 × 860 CSS pixels, device scale approximately 1.5.
- Source pixels: 2070 × 1310. Implementation pixels: 2040 × 1293.
- State: light theme, “全部项目” selected, code-directory tree expanded, zero projects running.

## Full-view comparison evidence

The source and implementation are shown together at matching heights. The outer application surface no longer has a thin outline or inset edge, while its large rounded corners and soft elevation remain visible against the page background.

## Focused region evidence

The full-frame comparison includes all four outer corners and edges at sufficient resolution, so a separate crop is unnecessary. The internal sidebar, workspace panels, controls, and project cards retain their existing borders and radii.

## Required fidelity surfaces

- Outer edge: application-level border removed.
- Rounded silhouette: retained through the existing window radius and overflow clipping.
- Elevation: retained through the existing soft outer shadow; the 1-pixel inset shadow was removed.
- Internal hierarchy: sidebar, workspace, controls, and project-card dividers are unchanged.
- Theme behavior: shared light/dark structure remains intact.

## Findings

- No actionable P0, P1, P2, or P3 visual differences remain for the requested change.
- The empty margin around the custom-shaped window intentionally remains so the rounded outer silhouette is visible.

## Interaction and console verification

- Automated style regression test confirms the app surface uses `border: 0`, retains its radius, and has no inset 1-pixel outline.
- Electron smoke flow passed for titlebar controls, navigation, dialogs, project startup, and live logs.
- Browser/Electron console: no application errors observed during the completed smoke flow.

## Comparison history

1. The user identified a thin outer ring around the otherwise rounded application surface.
2. The application-level border and inset outline shadow were removed without changing internal panel borders.
3. Post-fix capture confirms a clean rounded outer edge with the existing visual hierarchy intact.

final result: passed
