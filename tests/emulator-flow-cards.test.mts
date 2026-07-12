import { describe, it, expect, vi } from 'vitest';
import {
  FlowCardRegistry, parseArgLine, signature, FlowCardDef,
} from '../emulator/runtime/flow-cards.mjs';

const startTimer: FlowCardDef = {
  id: 'start-timer',
  kind: 'action',
  title: 'Start a timer',
  args: [{ name: 'duration', type: 'number' }, { name: 'name', type: 'text' }],
  tokens: [],
};

const speakText: FlowCardDef = {
  id: 'speak-text',
  kind: 'action',
  title: 'Say',
  args: [{ name: 'text', type: 'text' }],
  tokens: [],
};

describe('parseArgLine', () => {
  it('fills args positionally in declared order', () => {
    expect(parseArgLine(startTimer, '90 pasta').args).toEqual({ duration: 90, name: 'pasta' });
  });

  it('lets the last text arg swallow the rest of the line', () => {
    expect(parseArgLine(startTimer, '90 pasta with extra sauce').args)
      .toEqual({ duration: 90, name: 'pasta with extra sauce' });
    expect(parseArgLine(speakText, 'Hello there, how are you?').args)
      .toEqual({ text: 'Hello there, how are you?' });
  });

  it('accepts name=value for declared args, mixed with positional', () => {
    expect(parseArgLine(startTimer, 'name=pasta 90').args).toEqual({ duration: 90, name: 'pasta' });
    expect(parseArgLine(startTimer, 'duration=90 name=pasta').args).toEqual({ duration: 90, name: 'pasta' });
  });

  it('validates number args', () => {
    const r = parseArgLine(startTimer, 'soon pasta');
    expect(r.error).toContain('must be a number');
    expect(r.error).toContain(signature(startTimer));
  });

  it('requires missing number args, defaults missing text args to empty', () => {
    expect(parseArgLine(startTimer, '').error).toContain('Missing <duration>');
    expect(parseArgLine(startTimer, '90').args).toEqual({ duration: 90, name: '' });
  });

  it('rejects surplus positional args when no text arg can absorb them', () => {
    const cancelLike: FlowCardDef = { id: 'cancel-timer', kind: 'action', title: '', args: [], tokens: [] };
    expect(parseArgLine(cancelLike, 'whoops').error).toContain('Too many arguments');
  });
});

describe('FlowCardRegistry', () => {
  it('loads card definitions from .homeycompose/flow', () => {
    const reg = new FlowCardRegistry();
    const ids = (kind: any) => reg.listDefs(kind).map((d) => d.id);
    expect(ids('trigger')).toEqual(expect.arrayContaining(['timer-started', 'timer-finished', 'timer-cancelled', 'button-pressed']));
    expect(ids('condition')).toEqual(expect.arrayContaining(['is-muted', 'timer-is-running']));
    expect(ids('action')).toEqual(expect.arrayContaining(['start-timer', 'cancel-timer', 'speak-text', 'ask-agent-output-as-text']));
    // The device arg is implied, not part of the REPL signature.
    const st = reg.listDefs('action').find((d) => d.id === 'start-timer')!;
    expect(st.args).toEqual([{ name: 'duration', type: 'number' }, { name: 'name', type: 'text' }]);
  });

  it('returns the same card instance per id, so listeners registered by the driver are found', () => {
    const reg = new FlowCardRegistry();
    const a = reg.getCard('condition', 'is-muted');
    const b = reg.getCard('condition', 'is-muted');
    expect(a).toBe(b);
  });

  it('resolves cards by unique prefix and reports ambiguity', () => {
    const reg = new FlowCardRegistry();
    expect(reg.findDef('condition', 'is-m').def?.id).toBe('is-muted');
    expect(reg.findDef('trigger', 'timer').error).toContain('ambiguous');
    expect(reg.findDef('action', 'nope-nope').error).toContain('No action card');
  });

  it('runs a condition run-listener with the device merged into args', async () => {
    const reg = new FlowCardRegistry();
    const device = { getName: () => 'Test PE', isMuted: () => true };
    reg.getCard('condition', 'is-muted').registerRunListener(async (args: any) => args.device.isMuted());
    const outcome = await reg.runCard('condition', 'is-muted', device, '');
    expect(outcome).toEqual({ ok: true, result: true });
  });

  it('runs an action run-listener with parsed args', async () => {
    const reg = new FlowCardRegistry();
    const seen: any[] = [];
    reg.getCard('action', 'start-timer').registerRunListener(async (args: any) => { seen.push(args); });
    const device = { getName: () => 'Test PE' };
    const outcome = await reg.runCard('action', 'start-timer', device, '90 pasta water');
    expect(outcome.ok).toBe(true);
    expect(seen[0]).toEqual({ device, duration: 90, name: 'pasta water' });
  });

  it('reports a throwing run-listener instead of crashing', async () => {
    const reg = new FlowCardRegistry();
    reg.getCard('action', 'cancel-timer').registerRunListener(async () => { throw new Error('no timer'); });
    const outcome = await reg.runCard('action', 'cancel-timer', {}, '');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('no timer');
  });

  it('reports when no run-listener is registered', async () => {
    const reg = new FlowCardRegistry();
    const outcome = await reg.runCard('action', 'speak-text', {}, 'hi');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('No run-listener');
  });

  it('logs device-trigger firings with device name and tokens', async () => {
    const reg = new FlowCardRegistry();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const device = { getName: () => 'Kitchen PE' };
      await reg.getCard('trigger', 'timer-finished').trigger(device, { name: 'pasta', duration: 90 });
      const line = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(line).toContain('timer-finished');
      expect(line).toContain('Kitchen PE');
      expect(line).toContain('"name":"pasta"');
      expect(line).toContain('"duration":90');
    } finally {
      spy.mockRestore();
    }
  });

  it('renders the flow list grouped by WHEN/AND/THEN', () => {
    const reg = new FlowCardRegistry();
    const text = reg.renderList();
    expect(text).toContain('WHEN');
    expect(text).toContain('AND');
    expect(text).toContain('THEN');
    expect(text).toContain('start-timer <duration:number> <name>');
    expect(text).toContain('tokens: name, duration');
    // The condition title's Homey inversion markup is flattened for display.
    expect(text).not.toContain('!{{');
  });
});
