# The cost of growth: instructions, tools, and the context window

Every feature this app grows — a new tool, a new instruction block, a new
integration — is paid for out of the LLM's context window on **every single
request**. This document quantifies that cost, explains where it bites, and
sets the rules for keeping the app reliable on small local models as it grows.

Measured 2026-07 by compiling the app and dumping the real English prompt and
tool JSON; tokens estimated at ~3.8 characters/token (English).

## What every request carries before the user says a word

The system prompt and the tool definitions are sent on **every** LLM call.
They are fixed overhead, independent of the conversation:

| Component | Tokens (approx.) |
|---|---|
| Core system prompt (English, no extras) | ~1,020 |
| + timer instruction block (devices with timer support) | ~340 |
| + shopping-list block (Bring! enabled) | ~245 |
| + music block (Music Assistant enabled) | ~300 |
| **Full prompt, all features on** | **~1,900** |
| Base tool set (16 tools: system, devices, weather, timers) | ~1,900 |
| + shopping tools (4) + music tools (4) | ~1,350 |
| **Full tool JSON, all features on (24 tools)** | **~3,250** |
| **Total fixed overhead, everything enabled** | **~5,100–5,500** |

The heavyweight individual items are the ones that need behavioral
hand-holding: `set_timer` (~320 tok), `play_music` (~360 tok),
`set_device_capability` (~300 tok), `add_to_shopping_list` (~245 tok).

On top of the fixed overhead, conversation history grows during a session.
Tool *results* are the bulk of it — one `get_devices` page can return 50
devices of JSON, and a turn may run up to `MAX_TOOL_ROUNDS` tool rounds.

Non-English languages cost more: non-Latin scripts (Russian, Korean)
tokenize at roughly 1.5–2× the tokens per sentence, so the same prompt sits
deeper into the window.

## Where it bites, per provider

### OpenAI / Gemini Realtime: a tax, not a wall

The cloud realtime models have large context windows; ~5k of fixed overhead
does not threaten capability. The costs are money (the overhead is billed
every turn) and a mild reliability tax — frontier models handle 24 tools
with long descriptions well. There is a lot of headroom here.

### Local pipeline: three real failure modes

1. **Context overflow.** Ollama's *own* default context window
   (`num_ctx`, 4096 tokens — 2048 on older versions) is **smaller than the
   fixed overhead with everything enabled**. Ollama does not error on an
   oversized prompt — it silently truncates the oldest part, which is the
   system prompt. The symptoms look exactly like "the model got dumber":
   ignoring standard-zone rules, answering in the wrong language,
   hallucinating tool names. This is why `ollama-client.mts` **always sends
   `options.num_ctx`** (default 8192, user-tunable via the
   `local_llm_num_ctx` setting) — never rely on Ollama's default.

2. **Tool-selection accuracy degrades with tool count.** A 7–8B model
   choosing among 24 tools is measurably less reliable than among 10 — it
   starts picking `get_devices` when it should pick
   `get_devices_in_standard_zone`, or inventing a `uri` for `play_music`.
   Cloud models shrug this off; small local models do not.

3. **Instruction-following dilutes.** The prompt is dense with behavioral
   rules (type-locking, idempotency, safety gates, confirmation flows).
   A small model follows the first N rules reliably; every added block
   competes with the smart-home rules that matter most.

## What the code already does about it

- **Feature gating is the load-bearing mitigation.** Music and shopping
  tools are only registered when their feature is enabled
  (`ToolManager.refreshMusicTools` / `refreshShoppingListTools`), the
  matching prompt blocks are gated identically (`instruction-state.mts`),
  and timer tools/instructions are gated on device support. A user who only
  wants light control pays ~2,900 tokens, not ~5,500.
- **`num_ctx` is always set explicitly** for Ollama (see above). Default
  8192; the settings page exposes it so users with RAM/VRAM to spare can
  raise it (a bigger `num_ctx` costs a bigger KV cache on their box).
- **History is compacted between turns** in `local-pipeline-provider.mts`:
  when a turn completes, tool calls and tool results are dropped (the
  user/assistant text carries the conversation) and what remains is capped
  at `MAX_HISTORY_MESSAGES` (20 messages ≈ the last 10 exchanges). An
  all-day session cannot crowd out the instructions. The cloud realtime
  providers keep history server-side; this only concerns the local seam.

## Rules for adding features

1. **New feature = new gate, off by default.** Tools registered only when
   the feature is on; its instruction block appended only when the feature
   is on. Follow the Bring!/Music Assistant pattern exactly. Never add an
   always-on tool without weighing its cost to the minimal configuration.
2. **Don't shorten tool descriptions to save tokens.** The verbose
   descriptions are verbose *because* small models need the hand-holding.
   Cutting them trades context for reliability — the wrong direction.
   Prefer gating over trimming.
3. **Keep tool results lean.** Tool output is repeated back into the model
   and (within a turn) stays in history for every subsequent round. Paginate,
   return only the fields the model needs, prefer codes over prose.
4. **Consolidate before adding.** If a feature wants five similar tools,
   consider one tool with a `kind` parameter (candidate today: the five
   weather tools, ~390 tokens combined).
5. **Re-measure after significant growth.** Rebuild and dump
   `instructionState.text` + `JSON.stringify(toolManager.getToolDefinitions())`
   and divide characters by ~3.8. If the all-features-on fixed overhead
   approaches the default `num_ctx` minus a few turns of headroom
   (say > ~6,000 tokens against 8192), raise the default or cut weight.
