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
reacts instantly when either side changes. LM Studio's window is configured
in the LM Studio UI at model-load time, but its REST API reports it back
(`GET /api/v0/models` → `loaded_context_length`, or `max_context_length` as
an upper-bound fallback), so the meter reads it live through the app's
`/lmstudio-context` endpoint (the webview can't reach the LAN itself) and
gives the same verdict; when LM Studio is unreachable the meter degrades to
an honest "Limit set in LM Studio" label. For OpenAI-compatible / Mistral
the window is unknown; for the cloud realtime engines it's effectively
unlimited — those engines show the cost sum without a verdict (still useful —
for cloud engines it's a per-turn money proxy).

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

## Part 2 — Section navigation (dropdown, not tabs)

**Decision: a dropdown section switcher instead of a tab strip.** Vertical
space on a phone is scarce and the webview is narrow; a tab strip wide
enough for "General / Custom pipeline / Features" plus one more section
already scrolls or truncates, while a native `<select>` costs one row,
gets the platform's own picker UI on mobile, and scales to any number of
sections. It also unlocks a nicer structure: **each feature is its own
option in the list** (no separate "Features" section needed). Option
labels are the plain feature names only — both token costs and on/off
state in the option text were tried and rejected (costs word-wrap badly
in the native picker, and the state suffix adds noise); state and costs
live in the feature sections and the footer breakdown instead.

The Homey settings webview is plain HTML/CSS/JS, so this is hand-rolled
with the same visibility-toggle mechanism the page already uses for
provider/backend switching (`refreshLocalVisibility`,
`refreshStageVisibility`).

### Proposed sections (dropdown options)

| Group | Option | Contents |
|---|---|---|
| Setup | **General** | Language, **AI provider** (renamed from "Voice provider"), provider API keys + model quality, voice, additional AI instructions |
| Setup | **Custom pipeline** | The three-stage STT/LLM/TTS configuration with backends, test buttons, `num_ctx`. The `local` provider is presented as **"Custom pipeline"** in the UI; this dropdown option is **disabled** unless that provider is selected |
| Features | **Smart home control** | Always on; shows the base cost |
| Features | **Weather** | Toggle + OpenWeather key |
| Features | **Timers & alarms** | Toggle (device-dependent note) |
| Features | **Shopping list** | Toggle + Bring! credentials |
| Features | **Music** | Toggle + Music Assistant server |
| Features | **Web search** | Toggle + backend + Brave key |

Each feature section: toggle at the top, a "cost on every request" line
(instructions + tools, per selected language), then that feature's config,
greyed out while the feature is off. Future features append one option.

### Sticky footer: budget bar + save

Keep the **single global Save** (per-section saving invites half-saved
states and the current code saves all keys in one pass anyway). The footer
is sticky: **budget meter above the Save button**, visible on every
section. The meter shows the enabled total, the `num_ctx` budget and the
green/amber/red verdict (local pipeline only; cloud engines get the sum
with a "no context limit" note). Tapping the meter expands a **breakdown
sheet** — every feature with its cost and an inline toggle — so features
can be flipped from anywhere without hunting through the dropdown.
Switching sections does not prompt or save; unsaved edits persist in the
DOM until Save.

### Mockup

An interactive, phone-testable mockup of this design (dropdown nav,
per-feature costs with real measured numbers, live budget bar with all
three states, breakdown sheet, light/dark) was built as a Claude artifact —
`settings-mockup.html`, published 2026-07. It also demonstrates two
nuances: language multipliers apply only to the instruction share (tool
JSON stays English), and switching to a cloud provider changes the meter
from a verdict to a neutral per-turn-spend readout.

### Migration notes

- The page's JS already keys load/save off flat id lists
  (`localSettingIds`, explicit `Homey.set` calls) — moving DOM nodes into
  section containers doesn't disturb that, so the reshuffle is almost
  purely structural HTML/CSS.
- The existing conditional blocks (provider sections, per-stage backend
  blocks, `bring_settings`, `music_assistant_settings`) move as-is into
  their sections; their show/hide logic is orthogonal to section
  visibility.
- Keep ids stable. Tests don't touch the settings page, but the id ↔
  setting-key convention is the page's backbone.

## Implementation status (2026-07)

Steps 2–5 below **shipped** in one pass:

- **Gates**: `weather_enabled` and `timers_enabled` (new, default on) and
  web search (`web_search_provider` = `'disabled'` now unregisters the tool
  instead of refusing in the handler). Each has a `refresh*Tools()`
  reconciler in `ToolManager` mirroring the Bring!/Music pattern; the device
  restarts the provider when a gate flips. The timers instruction block is
  gated on `esp.supportsTimers` AND the setting.
- **Cost endpoint**: `GET /feature-costs` → `src/settings/feature-costs.mts`
  computes per-feature tokens live from the real instruction modules
  (selected language, per-language chars/token) and a measurement
  ToolManager (`registerAllToolsForMeasurement()` + `FEATURE_TOOLS`
  grouping). The page prices the live extra-instructions textarea
  client-side using the returned `charsPerToken`.
- **Settings page**: dropdown sections, feature sections with switches +
  cost lines (config greyed while off), sticky footer with meter,
  tap-to-expand breakdown with mirror toggles, single global Save. Verdict
  only when provider = Custom pipeline AND LLM backend = Ollama, against the
  live `local_llm_num_ctx` field.

**Deferred: step 1, the feature registry.** The gates are still hand-wired
per feature (five `refresh*` methods, per-feature blocks in the device's
settings handler, `FEATURE_TOOLS` map, page's `FEATURES` array). Fine at
six features; worth doing when the next feature lands.

## Original suggested sequencing

1. **Feature registry** — consolidate the existing gates (shopping, music,
   timers) behind one declarative list; no behavior change. *(deferred)*
2. **Cost endpoint** — compute per-feature token costs live for the selected
   language; unit-testable against the registry. *(shipped)*
3. **Dropdown layout** — structural HTML/CSS reshuffle of the existing page
   into sections behind the dropdown, sticky footer with global Save.
   *(shipped)*
4. **Feature sections + budget bar** — toggles + costs + sum bar and
   breakdown sheet wired to the endpoint; move Bring!/Music/web-search
   config under their toggles. *(shipped)*
5. **Promote weather + web search** to toggleable features (new gates,
   default: weather on, web search follows its current provider setting).
   *(shipped)*
