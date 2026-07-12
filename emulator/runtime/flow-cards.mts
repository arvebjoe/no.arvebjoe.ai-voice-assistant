// Emulator flow-card support, replacing the no-op card stubs so the last
// Homey-only surface is testable without hardware:
//
// - WHEN (trigger) cards: the app fires them via getDeviceTriggerCard().trigger()
//   (timer-started/finished/cancelled, button-pressed) — each firing is logged
//   to the console with its tokens.
// - AND (condition) cards: run from the REPL (`and is-muted`) against the
//   active satellite; the run-listener's true/false is printed.
// - THEN (action) cards: run from the REPL (`then start-timer 90 pasta`),
//   invoking the same run-listener a real flow would, with args parsed from
//   the command line (positional in declared order, or name=value; the last
//   text argument swallows the rest of the line so quotes aren't needed).
//
// Card argument/token definitions are read from `.homeycompose/flow/` (the
// compose source of truth), so new cards show up here automatically. The
// run-listeners themselves are the app's real ones: VoiceAssistantDriver
// registers them through the fake homey.flow, which hands out cards from this
// registry.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOW_DIR = resolve(__dirname, '../../.homeycompose/flow');

export type FlowCardKind = 'trigger' | 'condition' | 'action';

export interface FlowArgDef { name: string; type: string; }

export interface FlowCardDef {
  id: string;
  kind: FlowCardKind;
  title: string;
  /** Non-device args in declared order (the device arg is implied). */
  args: FlowArgDef[];
  tokens: FlowArgDef[];
}

export interface RunOutcome {
  ok: boolean;
  /** The run-listener's return value (condition boolean / action tokens). */
  result?: any;
  error?: string;
}

/** What homey.flow.get*Card() returns: run-listener storage + trigger logging. */
export class EmulatorFlowCard {
  readonly id: string;
  readonly kind: FlowCardKind;
  listener: ((args: any, state?: any) => any) | null = null;

  constructor(id: string, kind: FlowCardKind) {
    this.id = id;
    this.kind = kind;
  }

  registerRunListener(fn: (args: any, state?: any) => any): this {
    this.listener = fn;
    return this;
  }

  registerArgumentAutocompleteListener(_name: string, _fn: (...a: any[]) => any): this {
    return this;
  }

  /**
   * Device-trigger form is trigger(device, tokens, state); plain triggers are
   * trigger(tokens, state). The app only uses device triggers, but both log.
   */
  async trigger(deviceOrTokens?: any, tokens?: any, _state?: any): Promise<void> {
    const isDevice = deviceOrTokens && typeof deviceOrTokens.getName === 'function';
    const device = isDevice ? deviceOrTokens : null;
    const tok = isDevice ? tokens : deviceOrTokens;
    console.log(
      `\n⚡ WHEN [${this.id}]${device ? ` on '${device.getName()}'` : ''}` +
      `${tok && Object.keys(tok).length ? `  tokens: ${JSON.stringify(tok)}` : ''}\n`,
    );
  }
}

/**
 * Parse a REPL argument line against a card's declared args. Accepts
 * `name=value` for any declared arg; everything else fills the remaining args
 * positionally, with the LAST unfilled text arg taking the rest of the line.
 * Number args are converted and validated. Missing text args default to ''
 * (Homey's UI would require them, but for quick console runs empty is fine);
 * missing number args are an error.
 */
export function parseArgLine(def: FlowCardDef, line: string): { args?: Record<string, any>; error?: string } {
  const out: Record<string, any> = {};
  const tokens = line.trim() ? line.trim().split(/\s+/) : [];

  const positional: string[] = [];
  for (const t of tokens) {
    const m = t.match(/^([A-Za-z_][\w-]*)=(.*)$/);
    const argDef = m ? def.args.find((a) => a.name.toLowerCase() === m[1].toLowerCase()) : undefined;
    if (m && argDef) out[argDef.name] = m[2];
    else positional.push(t);
  }

  const unfilled = def.args.filter((a) => !(a.name in out));
  for (let i = 0; i < unfilled.length && positional.length > 0; i++) {
    const argDef = unfilled[i];
    if (i === unfilled.length - 1 && argDef.type === 'text') {
      out[argDef.name] = positional.splice(0).join(' ');
    } else {
      out[argDef.name] = positional.shift()!;
    }
  }
  if (positional.length > 0) {
    return { error: `Too many arguments: '${positional.join(' ')}'\nusage: ${signature(def)}` };
  }

  for (const argDef of def.args) {
    if (!(argDef.name in out)) {
      if (argDef.type === 'number') return { error: `Missing <${argDef.name}>\nusage: ${signature(def)}` };
      out[argDef.name] = '';
      continue;
    }
    if (argDef.type === 'number') {
      const n = Number(out[argDef.name]);
      if (!Number.isFinite(n)) {
        return { error: `<${argDef.name}> must be a number, got '${out[argDef.name]}'\nusage: ${signature(def)}` };
      }
      out[argDef.name] = n;
    }
  }
  return { args: out };
}

/** e.g. `then start-timer <duration:number> <name>` */
export function signature(def: FlowCardDef): string {
  const cmd = def.kind === 'condition' ? 'and' : 'then';
  const args = def.args
    .map((a) => (a.type === 'number' ? `<${a.name}:number>` : `<${a.name}>`))
    .join(' ');
  return `${cmd} ${def.id}${args ? ` ${args}` : ''}`;
}

export class FlowCardRegistry {
  private cards = new Map<string, EmulatorFlowCard>();
  private defs: FlowCardDef[] | null = null;

  /** Same instance per id, so the driver's run-listener and later runs meet. */
  getCard(kind: FlowCardKind, id: string): EmulatorFlowCard {
    const key = `${kind}:${id}`;
    let card = this.cards.get(key);
    if (!card) {
      card = new EmulatorFlowCard(id, kind);
      this.cards.set(key, card);
    }
    return card;
  }

  /** Card definitions from .homeycompose/flow (lazy, cached). */
  listDefs(kind?: FlowCardKind): FlowCardDef[] {
    if (!this.defs) {
      this.defs = [];
      const dirs: [string, FlowCardKind][] = [
        ['triggers', 'trigger'], ['conditions', 'condition'], ['actions', 'action'],
      ];
      for (const [dir, defKind] of dirs) {
        let files: string[] = [];
        try {
          files = readdirSync(join(FLOW_DIR, dir)).filter((f) => f.endsWith('.json'));
        } catch { /* missing dir = no cards of that kind */ }
        for (const file of files.sort()) {
          const raw = JSON.parse(readFileSync(join(FLOW_DIR, dir, file), 'utf8'));
          this.defs.push({
            id: file.replace(/\.json$/, ''),
            kind: defKind,
            title: raw.title?.en ?? '',
            args: (raw.args ?? [])
              .filter((a: any) => a.type !== 'device')
              .map((a: any) => ({ name: a.name, type: a.type })),
            tokens: (raw.tokens ?? []).map((t: any) => ({ name: t.name, type: t.type })),
          });
        }
      }
    }
    return kind ? this.defs.filter((d) => d.kind === kind) : this.defs;
  }

  /** Resolve a card by exact id, unique prefix, or unique substring. */
  findDef(kind: FlowCardKind, query: string): { def?: FlowCardDef; error?: string } {
    const defs = this.listDefs(kind);
    const q = query.toLowerCase();
    const exact = defs.find((d) => d.id.toLowerCase() === q);
    if (exact) return { def: exact };
    let matches = defs.filter((d) => d.id.toLowerCase().startsWith(q));
    if (matches.length === 0) matches = defs.filter((d) => d.id.toLowerCase().includes(q));
    if (matches.length === 1) return { def: matches[0] };
    if (matches.length > 1) {
      return { error: `'${query}' is ambiguous: ${matches.map((d) => d.id).join(', ')}` };
    }
    return {
      error: `No ${kind} card matching '${query}'. Available: ${defs.map((d) => d.id).join(', ') || '(none)'}`,
    };
  }

  /**
   * Run a condition/action card the way a real flow would: resolve the card,
   * parse the arg line, and invoke the registered run-listener with
   * { device, ...args }. Listener exceptions come back as { ok:false } — on a
   * real Homey they mark the flow card as failed, they don't crash the app.
   */
  async runCard(kind: 'condition' | 'action', query: string, device: any, argLine: string): Promise<RunOutcome> {
    const { def, error } = this.findDef(kind, query);
    if (!def) return { ok: false, error };

    const card = this.getCard(kind, def.id);
    if (!card.listener) {
      return { ok: false, error: `No run-listener registered for '${def.id}' (has a driver booted?)` };
    }

    const parsed = parseArgLine(def, argLine);
    if (parsed.error) return { ok: false, error: parsed.error };

    try {
      const result = await card.listener({ device, ...parsed.args });
      return { ok: true, result };
    } catch (e: any) {
      return { ok: false, error: `Card '${def.id}' threw: ${e?.message ?? e}` };
    }
  }

  /** The `flow` command: all cards grouped WHEN/AND/THEN with usage. */
  renderList(): string {
    const lines: string[] = [];
    const kinds: [FlowCardKind, string][] = [
      ['trigger', 'WHEN  (fired by the app — logged automatically as ⚡)'],
      ['condition', 'AND   (run with: and <card>)'],
      ['action', 'THEN  (run with: then <card> [args])'],
    ];
    for (const [kind, heading] of kinds) {
      const defs = this.listDefs(kind);
      if (defs.length === 0) continue;
      lines.push(heading);
      for (const def of defs) {
        const usage = kind === 'trigger'
          ? def.id + (def.tokens.length ? `  → tokens: ${def.tokens.map((t) => t.name).join(', ')}` : '')
          : signature(def).replace(/^(and|then) /, '');
        const title = def.title ? `  — ${def.title.replace(/!\{\{(\w+)\|[^}]*\}\}/g, '$1')}` : '';
        lines.push(`  ${usage}${title}`);
      }
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }
}

export const flowCards = new FlowCardRegistry();
