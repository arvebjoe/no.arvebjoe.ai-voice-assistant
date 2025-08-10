import WebSocket from "ws";
import { createLogger } from "../helpers/logger.mjs";

/**
 * Example tool (replace with your real tools)
 * The model will call this by name with JSON args.
 * We inline a minimal JSON Schema (empty object) so we don't depend on zod here.
 */
const getTimeSpec = {
  type: "function",
  name: "get_time",
  description: "Return the current ISO timestamp.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

async function runToolByName(
  name: string,
  args: unknown
): Promise<string> {
  switch (name) {
    case "get_time":
      return new Date().toISOString();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

type Options = {
  apiKey: string;
  model?: string; // default below
  systemPrompt: string;
  inputPcm16: Buffer; // mono, 16 kHz, 16-bit, little-endian PCM
  voice?: string;     // e.g. "alloy"
  sampleRate?: number; // default 16000
};

/**
 * One call: PCM16 bytes in -> agent with tools -> PCM16 bytes out.
 * Returns a single Buffer with the synthesized speech.
 */
export async function singleHopSpeech(
  opts: Options
): Promise<Buffer> {
  const log = createLogger("AIO_AGENT");
  log.info("singleHopSpeech invoked", "INIT", { hasInput: !!opts.inputPcm16, inputBytes: opts.inputPcm16?.length });
  const {
    apiKey,
    model = "gpt-4o-realtime-preview-2025-06-03",
    systemPrompt,
    inputPcm16,
    voice = "alloy",
    sampleRate = 16000,
  } = opts;

  // Realtime WS URL with model
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    model
  )}`;

  // Connect
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
  log.info("WebSocket created", "CONNECT", { url });

  // Gathered audio we’ll return
  const outChunks: Buffer[] = [];

  // Track partial tool call args by call id
  const pendingToolArgs = new Map<string, string>();

  // A small helper to send events
  const send = (event: Record<string, unknown>) => {
    ws.send(JSON.stringify(event));
  };

  // Wait for open
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e));
  });
  log.info("WebSocket open", "CONNECT");

  // 1) Configure the session (system prompt, tools, audio i/o)
  //    (session.update)
  send({
    type: "session.update",
    session: {
      instructions: systemPrompt,
      voice,
      tools: [getTimeSpec], // add more tools here
      // We want audio in & out; formats are PCM16 @ 16k
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      modalities: ["audio", "text"],
    },
  });
  log.info("Sent session.update", "SEND", { voice, sampleRate, tools: 1 });

  // 2) Stream input audio bytes (append -> commit)
  //    (input_audio_buffer.append / commit)
  send({
    type: "input_audio_buffer.append",
    audio: Buffer.from(inputPcm16).toString("base64"),
  });
  send({ type: "input_audio_buffer.commit" });
  log.info("Input audio appended & committed", "AUDIO_IN", { bytes: inputPcm16.length });

  // 3) Ask the model to create a response that may include tool calls
  //    (response.create)
  
  send({
    type: "response.create",
    response: {
      instructions: systemPrompt,
      modalities: ["audio", "text"], // ask for speech out
      // Let the model decide when/what tool to call
    },
  });
  log.info("Requested response.create", "SEND");
  

  // 4) Handle events: tool calls, audio deltas, done
  await new Promise<void>((resolve, reject) => {
    let audioDeltaChunks = 0;
    let audioBytes = 0;
    let transcriptChars = 0;
    let toolCalls = 0;
    const toolIds: string[] = [];

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type && msg.type !== "response.audio.delta") {
          log.info(`${msg.type}`, "EVENT", msg );
        }

        // --- Audio out (streaming)
        // response.audio.delta -> base64 encoded PCM16
        if (msg.type === "response.audio.delta" && msg.delta) {
          const buf = Buffer.from(msg.delta, "base64");
            outChunks.push(buf);
            audioDeltaChunks++;
            audioBytes += buf.length;
            if (audioDeltaChunks % 25 === 0) {
              log.info("Audio streaming progress", "AUDIO_OUT", { chunks: audioDeltaChunks, bytes: audioBytes });
            }
        }

        // --- Function-call arguments (streaming JSON)
        // response.function_call_arguments.delta
        if (
          msg.type === "response.function_call_arguments.delta" &&
          msg.delta &&
          msg.call_id
        ) {
          const prev = pendingToolArgs.get(msg.call_id) ?? "";
          pendingToolArgs.set(msg.call_id, prev + msg.delta);
          if (prev.length === 0) {
            log.info("Tool call args started", "TOOL_ARGS", { callId: msg.call_id });
          }
        }

        // --- Tool call is ready (model decided to call a function)
        // response.tool_call
        if (msg.type === "response.tool_call" && msg.call) {
          const { id, name } = msg.call;
          toolCalls++;
          toolIds.push(id);
          log.info("Tool call received", "TOOL", { id, name });

          // Reconstruct full JSON args collected via deltas
          const argsStr = pendingToolArgs.get(id) ?? "{}";
          pendingToolArgs.delete(id);

          let result: unknown;
          try {
            result = await runToolByName(name, JSON.parse(argsStr));
          } catch (err) {
            result = { error: (err as Error).message };
            log.error("Tool execution failed", { id, name, error: (err as Error).message });
          }

          // Send tool output back so model can continue
          // tool.output
          send({
            type: "tool.output",
            tool_call_id: id,
            output: typeof result === "string" ? result : JSON.stringify(result),
          });
          log.info("Tool output sent", "TOOL", { id, name });
        }

        // --- Response finished
        if (msg.type === "response.done") {
          log.info("Response completed", "DONE", { audioDeltaChunks, audioBytes, transcriptChars, toolCalls });
          resolve();
        }

 
      } catch (e) {
        log.error("Message handler exception", { error: (e as Error).message });
        reject(e);
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (e) => reject(e));
  });

  ws.close();
  log.info("WebSocket closed", "CLOSE");

  return Buffer.concat(outChunks);
}


