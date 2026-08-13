# Synthesis: Mobile Feedback Triage and Phase Sequence

Date: 2026-08-12
Status: Phase 1B accepted; Phase 1C implemented with physical-device gate pending
Source dossier: [`SPIKE-mobile-web-compatibility-20260812.md`](./SPIKE-mobile-web-compatibility-20260812.md)
Foundation spec: [`mobile-platform-foundation-phase1-20260812.md`](../specs/mobile-platform-foundation-phase1-20260812.md)

## Decision

The accumulated physical-device review is sufficient. Do not ask the reviewer
to repeat the Phase 1B composer checklist. The Safari stage failure was the
blocking defect, and the final iPhone pass confirmed its correction.

Work now proceeds in this order:

1. **Phase 1C — shared touch and dialog contract.** Finish the small,
   capability-gated foundation without rearranging either product surface.
2. **Phase 2A — mobile Code Review shell and arrival.** Replace the minified
   desktop composition with one primary phone surface and transient secondary
   navigation/context.
3. **Phase 2B — mobile Plan shell and navigation.** Reduce persistent Plan
   chrome, restore the blocked folder/multi-file path, and stabilize edit and
   completion controls.
4. **Phase 3 — touch selection and annotation semantics.** Prototype and
   validate multi-block Plan selection and multi-line Pierre selection as
   dedicated interactions.

This order is not a ranking of product importance alone. It separates shared
mechanical safety from information architecture, then separates layout from
the harder selection semantics. That keeps every review gate understandable
and prevents a phone workaround from mutating desktop preferences.

## Closed or already moving in parallel

| Area | Disposition | Evidence / constraint |
|---|---|---|
| Tailscale installation and HTTPS Serve | Working | Physical iPhone sessions opened through the tailnet and returned real Plan and Review feedback. |
| Mobile Safari page stage | Closed in 1B | Body scrolling and non-sticky compact Plan chrome now allow both Safari control regions to collapse; the user passed the result. |
| Primary comment composition | Closed in 1B | 16 px authoring text, deliberate touch focus, visible-viewport bounds, draft recovery, and explicit Save are implemented. |
| Release / first-use noise | Parallel stack already implemented | The release promo became a compact Grid/Clean decision; Vim, Ask AI, and analysis-layer startup announcements no longer mount. Features remain in Settings and their real surfaces. |
| New-user Code Review panel default | Merged independently | `origin/main` includes the Tree-first change. Mobile presentation must not overwrite that desktop-first product default. |
| Guided Review intro | Preserve | The reviewer found the initial Guide explanation useful. Guide is a strong candidate for mobile comprehension, not noise to remove. |
| Edit Code to Suggest | Preserve | The tested dialog was acceptable; suggestion editing is not pulled into the next layout phase. |
| All Files | Preserve and learn from | It was the cleanest Code Review presentation observed on the phone. |

## Triage matrix

`Now` means the next implementation checkpoint. `Next` is the first structural
surface phase. `Later` means deliberately deferred, not forgotten.

| Owner | Findings | Severity | Why grouped here | Disposition |
|---|---|---:|---|---|
| Closed in Phase 1B | MOB-010, MOB-031 | P1 | Safari page-stage and primary composer defects passed the physical iPhone gate. They remain regression contracts, not open design work. | **Closed / protect** |
| Phase 1C: shared touch/dialog | MOB-005, shared portion of MOB-012, shared dialog portion of MOB-014/MOB-030/MOB-032 | P1 | Undersized shared controls and unbounded shared dialogs are mechanical platform defects. Fixing the primitives first gives later layouts safe components without deciding their IA. | **Now** |
| Phase 2A: Review shell/arrival | MOB-002, MOB-003, MOB-017, MOB-020, MOB-021, MOB-030, MOB-032, MOB-033 | P1 | These are one failure: desktop workspace regions remain simultaneous on a phone. Fixing panels separately would preserve the wrong composition. | **Next** |
| Phase 2B: Plan shell/navigation | MOB-001, MOB-004, MOB-013, MOB-015, MOB-016, MOB-018, MOB-019, MOB-028 | P0/P1 | Plan reading now works, but navigation, editing completion, auxiliary arrival state, and persistent annotation chrome still fail or dominate. Folder navigation is the only current P0. | **After 2A** |
| Phase 3A: Plan touch selection | MOB-008, MOB-009, MOB-029 | P1 | Pinpoint proves tap targeting can work, but ordinary native selection conflicts with Safari and multi-block intent has no interaction model. This needs prototypes, not CSS. | **Later, prototype first** |
| Phase 3B: Review touch selection | MOB-006, MOB-007 | P1 | Single-line selection works; extending a range does not. Pierre rendering and line mapping are regression-sensitive and need their own guarded physical-device gate. | **Later, Pierre-guarded** |
| Surface hardening | MOB-011 secondary inputs, MOB-014 Settings, MOB-022 HTML, MOB-024 diagnostics | P2 | These are real but should adopt the shared contract within their owning surfaces rather than expanding the first structural phase. | **Later** |
| Delivery/performance/trust | MOB-023, MOB-025, MOB-026, MOB-027 | P1/P2 | Payload, tailnet trust, hook handoff, and reconnect behavior are cross-cutting delivery work, not layout work. They can be researched in parallel without changing current mobile IA. | **Independent track** |

## Immediate next implementation: Phase 1C

### Outcome

Shared buttons and shared dialog close controls are physically safe to touch,
shared dialogs remain reachable inside the visible Safari viewport, and fine-
pointer desktop geometry is unchanged.

### In scope

- Introduce the shared `--pn-touch-target` token and
  `data-pn-touch-target` marker.
- Apply coarse-pointer 44×44 minimum hit regions to the two incumbent shared
  button primitives and the shared dialog close control.
- Bound the shared dialog primitive to the visible viewport and safe-area
  contract established in 1A/1B.
- Gate hover-only effects to hover-capable fine pointers in touched primitives.
- Provide immediate, restrained press feedback and a reduced-motion path.
- Convert only representative shared dialogs needed to prove the contract.
- Verify iPhone and iPad geometry, including hybrid iPad touch plus pointer.

### Explicitly out of scope

- No mass expansion of every hand-authored Plan or Review toolbar control.
- No Plan toolstrip redesign, bottom action bar, or mobile navigation.
- No Code Review panel, Dockview, header, Guide, or diff composition change.
- No Split/Unified preference write based on viewport.
- No Pierre, `DiffViewer`, line-selection, or suggestion-editing changes.
- No new sheet system or visual language.

### Implementation seam

The expected source boundary remains:

- `packages/ui/theme.css`
- `packages/ui/components/ui/button.tsx`
- `packages/ui/components/core/button.tsx`
- `packages/ui/components/ui/dialog.tsx`
- focused component and geometry tests

If a correct 44 px target breaks a dense hand-authored row, record it for its
surface phase rather than introducing an undocumented compact exception.

### Gate for the next joint review

The checkpoint is ready for review when:

- representative button and dialog-close hit boxes measure at least 44×44 on
  a coarse pointer and do not overlap;
- a shared dialog at 320×568, 390×844, and keyboard-reduced height keeps its
  close control and primary action reachable;
- press feedback appears on touch-down without leaving sticky hover styling;
- reduced-motion and hardware-keyboard dismissal remain functional;
- iPad portrait/landscape and a touch-plus-trackpad path remain usable;
- desktop screenshots and computed geometry show no layout change under a
  fine pointer;
- production Plan and Review builds, focused tests, and typecheck pass.

The reviewer should expect a short physical-device check of representative
controls and one shared dialog—not another end-to-end Plan or Code Review
critique.

### Phase 1C implementation checkpoint

Implementation is complete on `codex/mobile-phase-1c-touch-dialog` and ready
for the short physical-device gate above. The shared contract now:

- marks both incumbent button primitives and the shared dialog close control;
- applies the 44 px minimum and immediate press feedback only when a coarse
  pointer exists, with a non-animated reduced-motion state;
- guards touched hover treatments behind hover-capable fine pointers;
- centers portaled shared dialogs inside the reactive visible-viewport and
  safe-area stage from Phase 1A/1B; and
- migrates `ConfirmDialog` to that shared primitive while preserving its
  non-dismissible backdrop and Command/Ctrl+Enter behavior. The migration also
  intentionally improves desktop accessibility by containing focus, focusing
  the safe Cancel action first when present, and restoring the opening control.

Responsive browser preflight found no horizontal overflow and kept the real
Plan confirmation popup within 16 px visible-stage padding at 320×568,
390×844, 390×500 keyboard-height, 844×390 phone landscape, 768×1024 iPad
portrait, and 1180×820 iPad landscape. At 1280×720 with a fine pointer, the
incumbent Plan header controls remained 138.17×28 px and 92.54×28 px, matching
the pre-change measurements. Browser emulation does not expose a coarse input
device, so the 44×44 hit region, touch-down state, and hybrid iPad path remain
the deliberate physical-device acceptance check rather than a claimed browser
result.

## Phase 2A preview: mobile Code Review shell and arrival

Phase 2A is the first structural redesign. Its job is to make the review
artifact, not the desktop workspace, own the phone viewport.

### Fixed principles

- One primary full-width surface at a time on phone.
- Tree remains the best new-user desktop default and is never overwritten by a
  mobile presentation decision.
- File navigation, PR context, annotations, AI, and agents become transient
  phone surfaces instead of flex siblings that squeeze the diff.
- Empty PR sections do not render structure merely to announce absence.
- The phone header exposes location, navigation, and one contextual action;
  desktop-only controls move behind progressive disclosure.
- A phone-friendly Unified presentation may be a session/device override, but
  it must not rewrite the user's desktop Split preference.
- Guide and All Files are the two strongest observed mobile starting points.
  The entry decision should be made through working prototypes and physical
  review, not assumed from responsive screenshots.

### Phase 2A review gate

Before implementation is accepted, the reviewer will compare at least two
working phone compositions using the same GitHub PR:

1. artifact-first All Files / Unified arrival;
2. Guide-first arrival with a direct route to the raw diff.

The chosen composition must preserve desktop behavior, make file/PR context
reachable without narrowing the artifact, keep the destination decision fully
visible, and support a complete single-line comment and approve/send journey.
Multi-line touch selection is explicitly evaluated in Phase 3, not used as a
gate for the shell.

## Why selection is not bundled into layout

The user's Plan feedback established that Pinpoint is currently the only
reliable touch path. A tap opens its contextual toolbar; Comment then opens the
composer. Ordinary Select taps do nothing, native drag selection invokes the
iOS Copy / Find Selection menu, and neither Plan nor Code Review offers a
credible way to accumulate several logical targets.

This is not a hit-box bug. It is an unresolved gesture and state model. The
selection phase must prototype explicit accumulation, visible range state,
cancel/undo, scroll coexistence, and assistive-technology behavior. Review
selection must additionally preserve Pierre's line mapping and desktop mouse
range selection. Treating it as incidental work inside a layout PR would make
both changes harder to review and easier to regress.

## Desktop preservation contract

Every phase keeps these invariants:

- mobile presentation state is ephemeral or device/session-scoped;
- desktop Tree/Split/panel preferences are never rewritten by phone width;
- fine-pointer geometry and keyboard shortcuts remain incumbent unless the
  phase explicitly names a desktop defect;
- shared changes are capability-gated and tested in a strict
  `@plannotator/ui` consumer;
- no existing working surface is deleted until physical and desktop parity is
  confirmed.
