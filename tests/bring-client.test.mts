import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BringClient } from '../src/helpers/bring-client.mjs';

/**
 * Routes the client's fetch calls to canned responses by URL so the Bring! flow
 * (login -> resolve list -> read/PUT) can be exercised without a network.
 * `putBodies` records every list-change PUT for assertions.
 */
function installFetchMock(opts?: { purchase?: Array<{ name: string; specification: string }> }) {
    const putBodies: string[] = [];
    const purchase = opts?.purchase ?? [{ name: 'Milk', specification: '2' }];
    let authCount = 0;

    const mock = vi.fn(async (url: string, init?: any) => {
        const u = String(url);
        if (u.endsWith('/bringauth')) {
            authCount++;
            return new Response(JSON.stringify({
                access_token: 'tok', uuid: 'user-1', bringListUUID: 'list-1', expires_in: 3600,
            }), { status: 200 });
        }
        if (u.endsWith('/bringusers/user-1/lists')) {
            return new Response(JSON.stringify({
                lists: [
                    { listUuid: 'list-1', name: 'Groceries' },
                    { listUuid: 'list-2', name: 'Hardware store' },
                ],
            }), { status: 200 });
        }
        if (/\/bringlists\/list-\d$/.test(u) && (!init || init.method === undefined)) {
            return new Response(JSON.stringify({ purchase, recently: [] }), { status: 200 });
        }
        if (/\/bringlists\/list-\d$/.test(u) && init?.method === 'PUT') {
            putBodies.push(String(init.body));
            return new Response('', { status: 200 });
        }
        throw new Error(`unexpected fetch: ${u}`);
    });

    (globalThis as any).fetch = mock;
    return { mock, putBodies, authCount: () => authCount };
}

describe('BringClient', () => {
    let realFetch: any;
    beforeEach(() => { realFetch = (globalThis as any).fetch; });
    afterEach(() => { (globalThis as any).fetch = realFetch; vi.restoreAllMocks(); });

    it('logs in and parses the purchase items', async () => {
        installFetchMock({ purchase: [{ name: 'Milk', specification: '2' }, { name: 'Bread', specification: '' }] });
        const client = new BringClient();
        client.setCredentials('user@example.com', 'pw');
        const snap = await client.getList();
        expect(snap.listName).toBe('Groceries');
        expect(snap.items).toEqual([
            { name: 'Milk', specification: '2' },
            { name: 'Bread', specification: '' },
        ]);
    });

    it('reuses the auth session across calls', async () => {
        const h = installFetchMock();
        const client = new BringClient();
        client.setCredentials('user@example.com', 'pw');
        await client.getList();
        await client.getList();
        expect(h.authCount()).toBe(1);
    });

    it('resolves a named list, falling back to the default when unknown', async () => {
        installFetchMock();
        const client = new BringClient();
        client.setCredentials('user@example.com', 'pw', 'Hardware store');
        const snap = await client.getList();
        expect(snap.listUuid).toBe('list-2');
    });

    it('saveItem PUTs an upsert with the purchase name and specification', async () => {
        const h = installFetchMock();
        const client = new BringClient();
        client.setCredentials('user@example.com', 'pw');
        await client.saveItem('Eggs', '6');
        expect(h.putBodies).toHaveLength(1);
        const params = new URLSearchParams(h.putBodies[0]);
        expect(params.get('purchase')).toBe('Eggs');
        expect(params.get('specification')).toBe('6');
        expect(params.get('remove')).toBe('');
    });

    it('removeItem PUTs the item in the remove field', async () => {
        const h = installFetchMock();
        const client = new BringClient();
        client.setCredentials('user@example.com', 'pw');
        await client.removeItem('Milk');
        const params = new URLSearchParams(h.putBodies[0]);
        expect(params.get('remove')).toBe('Milk');
        expect(params.get('purchase')).toBe('');
    });

    it('findItem matches case-insensitively', async () => {
        installFetchMock({ purchase: [{ name: 'Milk', specification: '2' }] });
        const client = new BringClient();
        client.setCredentials('user@example.com', 'pw');
        expect(await client.findItem('milk')).toEqual({ name: 'Milk', specification: '2' });
        expect(await client.findItem('cheese')).toBeNull();
    });

    it('throws a clear error when credentials are missing', async () => {
        installFetchMock();
        const client = new BringClient();
        await expect(client.getList()).rejects.toThrow(/not configured/i);
    });

    it('surfaces a rejected login', async () => {
        (globalThis as any).fetch = vi.fn(async () => new Response('nope', { status: 401 }));
        const client = new BringClient();
        client.setCredentials('user@example.com', 'wrong');
        await expect(client.getList()).rejects.toThrow(/rejected the login/i);
    });
});
