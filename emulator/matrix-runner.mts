// Custom-pipeline backend matrix runner (TODO item 30).
//
// Exercises every configured STT / LLM / TTS backend IN ISOLATION against its
// real endpoint, using the app's real clients built through the same
// stage-tester builders the settings page's Test buttons use:
//
//   - STT: transcribe a known reference clip and diff against the expected
//     words (plus the streaming path when the backend has one).
//   - LLM: one plain round ("Reply with exactly: PONG") and one two-round
//     tool-call trip (model must call get_current_time, then use its result).
//   - TTS: synthesize a fixed sentence, sanity-check duration, save the WAV
//     under emulator/matrix-out/ for listening.
//
// Config: emulator/matrix.json (copy matrix.example.json; git-ignored — it can
// hold API keys). Run all entries or a subset:
//
//   node --import tsx --import ./emulator/register.mjs ./emulator/matrix-runner.mts [id ...]
//
// Exit code 0 = every enabled (selected) entry passed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildSttClient, buildLlmClient, buildTtsClient, StageTestRequest,
} from '../src/llm/providers/local/stage-tester.mjs';
import { OllamaClient } from '../src/llm/providers/local/ollama-client.mjs';
import { ChatMessage, LlmToolDef } from '../src/llm/providers/local/llm-client.mjs';
import { pcmToWav } from '../src/helpers/wav.mjs';
import { loadRecording } from './runtime/recordings.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.MATRIX_CONFIG
  ? resolve(process.env.MATRIX_CONFIG)
  : resolve(__dirname, 'matrix.json');
const OUT_DIR = resolve(__dirname, 'matrix-out');

interface MatrixEntry extends StageTestRequest {
  id: string;
  enabled?: boolean;      // default true
  numCtx?: number;        // ollama only: verify item 36's num_ctx plumbing
}

interface MatrixConfig {
  /** Reference clip (in emulator/recordings/) and the words it must transcribe to. */
  sttClip: string;
  sttClipExpect: string;
  language?: string;
  entries: MatrixEntry[];
}

interface EntryResult {
  id: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const TEST_TIMEOUT_MS = 120_000; // cold local models are slow on first load

function withTimeout<T>(work: Promise<T>, ms = TEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms);
    work.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

/** Lowercase, strip punctuation, collapse whitespace. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Fraction of expected words present in the transcript (order-insensitive). */
function wordScore(expected: string, actual: string): { score: number; missing: string[] } {
  const have = new Set(normalize(actual).split(' '));
  const want = normalize(expected).split(' ').filter(Boolean);
  const missing = want.filter((w) => !have.has(w));
  return { score: want.length ? (want.length - missing.length) / want.length : 0, missing };
}

// ---------------------------------------------------------------- STT ------

async function runStt(entry: MatrixEntry, cfg: MatrixConfig): Promise<string> {
  const client = buildSttClient(entry);
  if (!client.hasCredentials()) throw new Error('API key missing');
  if (!client.isConfigured()) throw new Error('not configured');
  await client.check();

  const clipPath = resolve(__dirname, 'recordings', cfg.sttClip);
  if (!existsSync(clipPath)) throw new Error(`reference clip missing: ${clipPath}`);
  const rec = await loadRecording(clipPath);
  const lang = cfg.language || 'en';

  // Batch path (every backend has it).
  const batchText = await withTimeout(client.transcribe(rec.pcm, lang));
  const batch = wordScore(cfg.sttClipExpect, batchText);
  if (batch.score < 0.8) {
    throw new Error(`batch transcript too far off (${Math.round(batch.score * 100)}%): "${batchText}" (missing: ${batch.missing.join(', ')})`);
  }

  // Streaming path (only backends exposing createStream — e.g. Mistral realtime).
  let streamNote = '';
  if (client.createStream) {
    const stream = client.createStream(lang);
    const CHUNK = 3200; // 100 ms of 16 kHz PCM16
    for (let off = 0; off < rec.pcm.length; off += CHUNK) {
      stream.append(rec.pcm.subarray(off, Math.min(off + CHUNK, rec.pcm.length)));
      await new Promise((r) => setTimeout(r, 10)); // gentle pacing
    }
    const streamText = await withTimeout(stream.finish());
    const s = wordScore(cfg.sttClipExpect, streamText);
    if (s.score < 0.8) {
      throw new Error(`stream transcript too far off (${Math.round(s.score * 100)}%): "${streamText}"`);
    }
    streamNote = ` | stream ok (${Math.round(s.score * 100)}%): "${streamText.slice(0, 60)}"`;
  }

  return `batch ok (${Math.round(batch.score * 100)}%): "${batchText.slice(0, 60)}"${streamNote}`;
}

// ---------------------------------------------------------------- LLM ------

const TIME_TOOL: LlmToolDef = {
  name: 'get_current_time',
  description: 'Returns the current local time. Call this whenever the user asks about the time.',
  parameters: { type: 'object', properties: {}, required: [] },
};

async function runLlm(entry: MatrixEntry): Promise<string> {
  // Ollama entries build directly so numCtx reaches the client (item 36).
  const client = entry.backend === 'ollama' || !entry.backend
    ? new OllamaClient({
      host: String(entry.host ?? ''), port: Number(entry.port) || 11434,
      model: String(entry.model ?? ''), numCtx: entry.numCtx,
    })
    : buildLlmClient(entry);
  if (!client.hasCredentials()) throw new Error('API key missing');
  if (!client.isConfigured()) throw new Error('not configured');
  await client.check();

  // Round 1 — plain reply, no tools.
  const plain = await withTimeout(client.chat(
    [{ role: 'user', content: 'Reply with exactly: PONG' }], [],
  ));
  if (!/pong/i.test(plain.content ?? '')) {
    throw new Error(`plain round: expected PONG, got "${(plain.content ?? '').slice(0, 80)}"`);
  }

  // Round 2 — the model must CALL the tool...
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a smart home voice assistant. Use the available tools to answer questions. Answer briefly.' },
    { role: 'user', content: 'What time is it right now?' },
  ];
  const toolRound = await withTimeout(client.chat(messages, [TIME_TOOL]));
  const call = toolRound.toolCalls.find((c) => c.name === TIME_TOOL.name);
  if (!call) {
    throw new Error(`tool round: model did not call ${TIME_TOOL.name} (content: "${(toolRound.content ?? '').slice(0, 80)}")`);
  }

  // ...and then USE the result we feed back.
  messages.push({ role: 'assistant', content: toolRound.content ?? '', toolCalls: toolRound.toolCalls });
  messages.push({ role: 'tool', content: '{"time":"14:37"}', toolCallId: call.id, toolName: call.name });
  const answer = await withTimeout(client.chat(messages, [TIME_TOOL]));
  if (!/14[:.\s]?37|2[:.\s]?37/.test(answer.content ?? '')) {
    throw new Error(`tool round: answer ignored the tool result: "${(answer.content ?? '').slice(0, 100)}"`);
  }

  return `plain ok ("${plain.content.trim().slice(0, 20)}") | tool call ok (${call.name}) | result used ("${answer.content.trim().slice(0, 60)}")`;
}

// ---------------------------------------------------------------- TTS ------

const TTS_SENTENCE = 'The quick brown fox jumps over the lazy dog.';

async function runTts(entry: MatrixEntry): Promise<string> {
  const client = buildTtsClient(entry);
  if (!client.hasCredentials()) throw new Error('API key missing');
  if (!client.isConfigured()) throw new Error('not configured');
  await client.check();

  const { pcm, sampleRate } = await withTimeout(client.synthesize(TTS_SENTENCE));
  const ms = Math.round((pcm.length / 2 / sampleRate) * 1000);
  if (ms < 800) throw new Error(`suspiciously short audio: ${ms} ms at ${sampleRate} Hz`);

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, `${entry.id}.wav`);
  writeFileSync(outPath, pcmToWav(pcm, sampleRate, 1));
  return `${ms} ms @ ${sampleRate} Hz -> ${outPath}`;
}

// ---------------------------------------------------------------- main -----

async function main(): Promise<void> {
  // Strip a UTF-8 BOM — Windows editors (and PowerShell redirects) add one.
  const cfg: MatrixConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const selected = cfg.entries.filter((e) =>
    (only.length === 0 || only.includes(e.id)) && e.enabled !== false);

  if (selected.length === 0) {
    console.error(only.length
      ? `No enabled entries match: ${only.join(', ')}`
      : 'No enabled entries in matrix.json');
    process.exit(2);
  }

  console.log(`Matrix: ${selected.length} entr${selected.length === 1 ? 'y' : 'ies'} (config: ${CONFIG_PATH})\n`);
  const results: EntryResult[] = [];

  for (const entry of selected) {
    const started = Date.now();
    process.stdout.write(`>> ${entry.id} [${entry.stage}/${entry.backend}] ... `);
    try {
      let detail: string;
      switch (entry.stage) {
        case 'stt': detail = await runStt(entry, cfg); break;
        case 'llm': detail = await runLlm(entry); break;
        case 'tts': detail = await runTts(entry); break;
        default: throw new Error(`unknown stage '${entry.stage}'`);
      }
      results.push({ id: entry.id, ok: true, ms: Date.now() - started, detail });
      console.log(`PASS (${Date.now() - started} ms)\n   ${detail}`);
    } catch (err: any) {
      const cause = err?.cause?.code || err?.cause?.message;
      const detail = String(err?.message ?? err) + (cause ? ` (${cause})` : '');
      results.push({ id: entry.id, ok: false, ms: Date.now() - started, detail });
      console.log(`FAIL (${Date.now() - started} ms)\n   ${detail}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== MATRIX SUMMARY =====');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(22)} ${String(r.ms).padStart(6)} ms  ${r.detail}`);
  }
  console.log(`==========================\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('matrix-runner fatal:', e); process.exit(2); });
