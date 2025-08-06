import OpenAI from 'openai';

interface SynthesizeOptions {
  model?: string;
  voice?: string;
  response_format?: 'flac' | 'mp3' | 'opus' | 'aac' | 'wav' | 'pcm';
}

/**
 * Synthesizes speech from text using OpenAI TTS API.
 * @param text - The text to synthesize.
 * @param apiKey - Your OpenAI API key.
 * @param opts - Optional model, voice, and response_format.
 * @returns Promise<Buffer> - FLAC audio buffer.
 */
export async function synthesize(
  text: string,
  apiKey: string,
  opts: SynthesizeOptions = {}
): Promise<Buffer> {
  if (!apiKey) throw new Error('No OpenAI API key provided');
  const openai = new OpenAI({ apiKey });
  const response = await openai.audio.speech.create({
    model: opts.model || 'gpt-4o-mini-tts',
    voice: opts.voice || 'alloy',
    response_format: opts.response_format || 'flac',
    input: text,
  });
  // Convert the response to a Buffer
  return Buffer.from(await response.arrayBuffer());
}
