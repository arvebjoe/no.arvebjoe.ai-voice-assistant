import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { getLmStudioContext } from '../src/llm/providers/local/lmstudio-context.mjs';

// Fake LM Studio: GET /api/v0/models returns whatever `models` currently holds.
let server: http.Server;
let port: number;
let models: any[] = [];
let status = 200;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.url === '/api/v0/models') {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ object: 'list', data: models }));
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as any).port;
});

afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
});

const qwen = {
    id: 'qwen2.5-7b-instruct', object: 'model', type: 'llm', state: 'loaded',
    max_context_length: 32768, loaded_context_length: 8192,
};
const llama = {
    id: 'meta-llama-3.1-8b-instruct', object: 'model', type: 'llm', state: 'not-loaded',
    max_context_length: 131072,
};
const embedding = {
    id: 'text-embedding-nomic', object: 'model', type: 'embeddings', state: 'loaded',
    max_context_length: 2048,
};

describe('getLmStudioContext', () => {
    it('prefers the loaded context length over the model max for a configured model', async () => {
        status = 200;
        models = [llama, qwen];
        const r = await getLmStudioContext({ host: '127.0.0.1', port, model: 'qwen2.5-7b-instruct' });
        expect(r).toEqual({
            ok: true, model: 'qwen2.5-7b-instruct', state: 'loaded',
            contextLength: 8192, source: 'loaded',
        });
    });

    it('falls back to max_context_length when no loaded length is reported', async () => {
        models = [llama];
        const r = await getLmStudioContext({ host: '127.0.0.1', port, model: 'meta-llama-3.1-8b-instruct' });
        expect(r.ok).toBe(true);
        expect(r.contextLength).toBe(131072);
        expect(r.source).toBe('max');
    });

    it('auto-picks the loaded chat model, skipping embeddings (mirrors LmStudioClient)', async () => {
        models = [embedding, llama, qwen];
        const r = await getLmStudioContext({ host: '127.0.0.1', port });
        expect(r.ok).toBe(true);
        expect(r.model).toBe('qwen2.5-7b-instruct');
    });

    it('auto-picks the first chat model when none is loaded', async () => {
        models = [embedding, llama];
        const r = await getLmStudioContext({ host: '127.0.0.1', port });
        expect(r.ok).toBe(true);
        expect(r.model).toBe('meta-llama-3.1-8b-instruct');
    });

    it('reports a missing configured model by name', async () => {
        models = [qwen];
        const r = await getLmStudioContext({ host: '127.0.0.1', port, model: 'nope' });
        expect(r.ok).toBe(false);
        expect(r.message).toContain("'nope'");
    });

    it('reports an empty model list', async () => {
        models = [];
        const r = await getLmStudioContext({ host: '127.0.0.1', port });
        expect(r.ok).toBe(false);
        expect(r.message).toContain('no models');
    });

    it('reports a missing context length instead of returning 0', async () => {
        models = [{ id: 'weird', type: 'llm', state: 'loaded' }];
        const r = await getLmStudioContext({ host: '127.0.0.1', port, model: 'weird' });
        expect(r.ok).toBe(false);
        expect(r.message).toContain('weird');
    });

    it('reports HTTP errors from LM Studio', async () => {
        status = 500;
        models = [];
        const r = await getLmStudioContext({ host: '127.0.0.1', port });
        expect(r.ok).toBe(false);
        expect(r.message).toContain('500');
        status = 200;
    });

    it('reports an unreachable server without throwing', async () => {
        // A just-closed ephemeral port: connection refused.
        const dead = http.createServer(() => {});
        await new Promise<void>((done) => dead.listen(0, '127.0.0.1', done));
        const deadPort = (dead.address() as any).port;
        await new Promise<void>((done) => dead.close(() => done()));

        const r = await getLmStudioContext({ host: '127.0.0.1', port: deadPort });
        expect(r.ok).toBe(false);
        expect(r.message).toBeTruthy();
    });

    it('rejects a missing host without a network call', async () => {
        const r = await getLmStudioContext({ host: '' });
        expect(r.ok).toBe(false);
        expect(r.message).toContain('host');
    });
});
