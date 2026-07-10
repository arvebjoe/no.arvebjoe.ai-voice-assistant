# Settings redesign: tabbed layout + per-feature token costs

Design notes only — **not implemented yet**. Follows on from
[cost-of-growth.md](./cost-of-growth.md), which quantifies what every feature
costs out of the LLM's context window. The idea: make that invisible tax
visible and controllable in the settings page, and reorganize the page so it
has room to breathe.

## The problem

1. Every feature (timers, shopping list, music, and everything still to come)
   adds instructions + tools to **every** LLM request. On small local models
   this quietly degrades smart-home reliability (see cost-of-growth.md), and
   users have no way to see or reason about it.
2. The settings page is one hard-packed scroll: ~1,000 lines, 50+ form
   groups — language, provider, three pluggable pipeline stages × four
   backends each with test buttons, web search, Bring!, Music Assistant, AI
   instructions. Adding a feature panel with toggles and a cost meter to the
   current layout would make it worse.

Both problems share a solution: a **Features tab** where every feature has an
on/off switch and a visible token price, inside a **tabbed layout** that
splits the page into digestible sections.

## Part 1 — Feature cost panel

### What the user sees

```
Features                                    (English, Ollama, num_ctx 8192)
  Smart home control          always on              ~2,100 tokens
  Weather                     [on]                     ~390 tokens
  Timers & alarms             [on]  (device-dependent) ~660 tokens
  Shopping list (Bring!)      [off]                    ~490 tokens
  Music (Music Assistant)     [on]                   ~1,650 tokens
  Web search                  [off]                    ~150 tokens
  ─────────────────────────────────────────────────────────────
  ~4,800 of 8,192 tokens  ████████░░░░░  fits, room for conversation
```

- One row per feature: toggle, label, approximate token cost (prompt block +
  tool definitions for the currently selected language).
- Smart home control is always on and shows the base cost.
- Expanding a row reveals that feature's existing config (Bring! credentials,
  Music Assistant address, …) — the toggles that already exist
  (`bring_enabled`, `music_assistant_enabled`) just move here.
- A sum bar at the bottom, always visible (sticky footer, see Part 2),
  recomputed on any toggle, language change, or `num_ctx` change.

### Design decisions

**Compute costs live, don't hardcode them.** Hardcoded numbers go stale
within releases. A small Homey API endpoint (the settings webview calls
`Homey.api(...)`) builds the real instruction text and tool JSON per feature
for the selected language and returns estimated tokens. The numbers then
track the code automatically, including translations. Estimation stays a
chars-per-token heuristic (~3.8 for English, larger penalty for non-Latin
scripts like ru/ko); a real tokenizer is too heavy for the Homey box and
false precision anyway. Always display as approximate ("~1,900").

**What the budget is compared against.** Only the local pipeline has a crisp
answer: the binding limit for Ollama is what we request via
`local_llm_num_ctx` (default 8192) — a setting on the same page, so the meter
reacts instantly when either side changes. For LM Studio / OpenAI-compatible /
Mistral the window is unknown; for the cloud realtime engines it's
effectively unlimited. Scope the red/green verdict to the local pipeline;
for other engines show the cost sum without a verdict (still useful — for
cloud engines it's a per-turn money proxy).

**Red does not mean "overhead > window".** The fixed overhead shares the
window with history (capped at 20 messages), within-turn tool results, and
the reply. Three states:

| State | Threshold | Meaning |
|---|---|---|
| green | overhead < ~50% of `num_ctx` | fits, room for conversation |
| amber | ~50–75% | works, but little room for history/tool results |
| red | > ~75% | the model will start forgetting its instructions |

**Timers are the awkward row.** Shopping and music are global toggles;
timers are gated per-device on firmware capability (`supportsTimers`). A
global "Timers" toggle is new (default on) and gets ANDed with device
support; the panel shows the potential cost with an "on devices that support
it" note. Needs a little care in `VoiceAssistantDevice` so flipping it
rebuilds sessions.

**Base cost should probably be two-plus rows.** Weather (5 tools, ~390
tokens) and web search (~150) currently ride along in the base set. This
panel is the natural moment to make them toggleable too — cheap wins for a
minimal setup, and honest: today's "base" is really "base + two features
nobody opted into". (Weather tool consolidation — five tools into one or two —
is a separate, compatible win; see cost-of-growth.md rule 4.)

### The feature registry (the real enabler)

Today each feature's pieces are hand-wired: setting keys, a
`refresh*Tools()` method in `ToolManager`, an instruction block in
`instruction-state.mts`, a section in the settings page. Introduce one
declarative list:

```ts
{ id, label, settingKey, toolNames, instructionBlock(languageCode), deviceGated? }
```

that `ToolManager`, `InstructionState`, the cost endpoint, and the settings
page all iterate. Adding a future feature becomes one registry entry that
automatically shows up with a toggle and a price. Without the registry, the
cost panel is a fourth place to hand-wire every feature — with it, the panel
enforces cost-of-growth rule #1 ("new feature = new gate, off by default")
structurally instead of by discipline.

### Honest limitation

The meter measures *context* cost — failure mode 1 of cost-of-growth.md.
Tool-selection accuracy on small models still degrades with tool count even
when everything fits; no meter can show that. But fewer enabled features
helps both, so the UI pushes users in the right direction regardless.

## Part 2 — Tabbed layout

The Homey settings webview is plain HTML/CSS/JS, so tabs are entirely
doable — hand-rolled with a few CSS classes and a visibility toggle, the
same mechanism the page already uses for provider/backend switching
(`refreshLocalVisibility`, `refreshStageVisibility`). Homey's design system
ships no tab component, so keep it simple: a compact segmented control /
tab strip that works at the webview's narrow mobile width.

### Proposed tabs

| Tab | Contents |
|---|---|
| **General** | Language, voice provider, provider API keys + model quality, voice, additional AI instructions |
| **Local pipeline** | The three-stage STT/LLM/TTS configuration with backends, test buttons, `num_ctx`. Only visible when the provider is `local` (dynamic tab visibility — the page already hides this section per provider) |
| **Features** | The cost panel from Part 1, with each feature's config nested under its toggle (Bring! credentials, Music Assistant server, web-search backend + Brave key, weather) |

Three tabs is enough; resist a fourth until something genuinely doesn't fit
(diagnostics/advanced later, maybe).

### Save button and the sum bar

Keep the **single global Save** (per-tab saving invites half-saved states and
the current code saves all keys in one pass anyway). Make the footer sticky
and put the **token sum bar next to the Save button** — that satisfies
"always visible" from Part 1 naturally: whichever tab you're on, the budget
and the save action stay on screen. Switching tabs does not prompt or save;
unsaved edits simply persist in the DOM until Save.

### Migration notes

- The page's JS already keys load/save off flat id lists
  (`localSettingIds`, explicit `Homey.set` calls) — moving DOM nodes into
  tab containers doesn't disturb that, so the tab refactor is almost purely
  structural HTML/CSS.
- The existing conditional blocks (provider sections, per-stage backend
  blocks, `bring_settings`, `music_assistant_settings`) move as-is into
  their tabs; their show/hide logic is orthogonal to tab visibility.
- Keep ids stable. Tests don't touch the settings page, but the id ↔
  setting-key convention is the page's backbone.

## Suggested sequencing

Each step independently shippable and testable:

1. **Feature registry** — consolidate the existing gates (shopping, music,
   timers) behind one declarative list; no behavior change.
2. **Cost endpoint** — compute per-feature token costs live for the selected
   language; unit-testable against the registry.
3. **Tab layout** — structural HTML/CSS reshuffle of the existing page,
   sticky footer with global Save.
4. **Features tab** — toggles + costs + sum bar wired to the endpoint;
   move Bring!/Music/web-search config under their rows.
5. **Promote weather + web search** to toggleable features (new gates,
   default: weather on, web search follows its current provider setting).
