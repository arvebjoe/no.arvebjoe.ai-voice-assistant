import { createLogger } from './logger.mjs';

/**
 * Minimal client for the Bring! shopping-list service.
 *
 * Only the handful of calls the voice assistant needs are implemented: log in,
 * read a list, and add / update / remove an item.
 *
 * The user must opt in (the `bring_enabled` setting) and provide their Bring!
 * account e-mail + password in the app settings — nothing here works without
 * real credentials.
 */

const BRING_REST_URL = 'https://api.getbring.com/rest/v2/';
// Client API key required on every request.
const BRING_API_KEY = 'cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp';
const REQUEST_TIMEOUT_MS = 15_000;
// Refresh the access token a minute before it actually expires.
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export interface BringListItem {
    /** The item name, e.g. "Milk". */
    name: string;
    /** Free-text amount / note, e.g. "2" or "2 liters". Empty when none. */
    specification: string;
}

export interface BringListSnapshot {
    listName: string;
    listUuid: string;
    items: BringListItem[];
}

interface BringSession {
    accessToken: string;
    userUuid: string;
    defaultListUuid: string;
    expiresAt: number;
}

export class BringClient {
    private logger = createLogger('BringClient', true);
    private email = '';
    private password = '';
    private listName = '';
    private session: BringSession | null = null;

    /**
     * Update the account credentials / preferred list. Clears any cached login
     * session when something actually changed so the next call re-authenticates.
     */
    setCredentials(email: string, password: string, listName = ''): void {
        const e = (email || '').trim();
        const p = password || '';
        const l = (listName || '').trim();
        if (e === this.email && p === this.password && l === this.listName) {
            return;
        }
        this.email = e;
        this.password = p;
        this.listName = l;
        this.session = null; // force re-login with the new credentials
    }

    hasCredentials(): boolean {
        return this.email.length > 0 && this.password.length > 0;
    }

    private baseHeaders(): Record<string, string> {
        return {
            'X-BRING-API-KEY': BRING_API_KEY,
            'X-BRING-CLIENT': 'webApp',
            'X-BRING-CLIENT-SOURCE': 'webApp',
            'X-BRING-COUNTRY': 'DE',
        };
    }

    private authHeaders(session: BringSession): Record<string, string> {
        return {
            ...this.baseHeaders(),
            'X-BRING-USER-UUID': session.userUuid,
            Authorization: `Bearer ${session.accessToken}`,
        };
    }

    /** Log in (or reuse a still-valid session) and return it. */
    private async ensureSession(): Promise<BringSession> {
        if (this.session && Date.now() < this.session.expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
            return this.session;
        }
        if (!this.hasCredentials()) {
            throw new Error('Bring! is not configured — set the account e-mail and password in the app settings.');
        }

        const body = new URLSearchParams({ email: this.email, password: this.password });
        const res = await fetch(`${BRING_REST_URL}bringauth`, {
            method: 'POST',
            headers: {
                ...this.baseHeaders(),
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.status === 401 || res.status === 403) {
            throw new Error('Bring! rejected the login — check the e-mail and password in the app settings.');
        }
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Bring! login failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
        }

        const json: any = await res.json();
        const accessToken = json?.access_token;
        const userUuid = json?.uuid;
        const defaultListUuid = json?.bringListUUID;
        if (!accessToken || !userUuid) {
            throw new Error('Bring! login returned an unexpected response (no access token).');
        }
        const expiresInMs = (Number(json?.expires_in) || 3600) * 1000;

        this.session = {
            accessToken,
            userUuid,
            defaultListUuid: defaultListUuid || '',
            expiresAt: Date.now() + expiresInMs,
        };
        this.logger.info('Authenticated with Bring!');
        return this.session;
    }

    /**
     * Resolve which list to operate on: the one whose name matches the
     * `bring_list_name` setting (case-insensitive), else the account's default
     * list. Returns the uuid and its display name.
     */
    private async resolveList(session: BringSession): Promise<{ listUuid: string; listName: string }> {
        const res = await fetch(`${BRING_REST_URL}bringusers/${session.userUuid}/lists`, {
            headers: this.authHeaders(session),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Could not load your Bring! lists (HTTP ${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
        }
        const json: any = await res.json();
        const lists: any[] = Array.isArray(json?.lists) ? json.lists : [];

        if (this.listName) {
            const match = lists.find(l => String(l?.name ?? '').toLowerCase() === this.listName.toLowerCase());
            if (match?.listUuid) {
                return { listUuid: match.listUuid, listName: match.name };
            }
            this.logger.warn(`Bring! list "${this.listName}" not found; falling back to the default list.`);
        }

        // Prefer the login's default list, otherwise the first one available.
        const fallback = lists.find(l => l?.listUuid === session.defaultListUuid) ?? lists[0];
        if (session.defaultListUuid && (!this.listName || !fallback)) {
            return {
                listUuid: session.defaultListUuid,
                listName: fallback?.name ?? 'Shopping list',
            };
        }
        if (fallback?.listUuid) {
            return { listUuid: fallback.listUuid, listName: fallback.name ?? 'Shopping list' };
        }
        throw new Error('No Bring! shopping lists were found on this account.');
    }

    /** Read the current "to buy" items on the resolved list. */
    async getList(): Promise<BringListSnapshot> {
        const session = await this.ensureSession();
        const { listUuid, listName } = await this.resolveList(session);

        const res = await fetch(`${BRING_REST_URL}bringlists/${listUuid}`, {
            headers: this.authHeaders(session),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Could not read the Bring! list (HTTP ${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
        }
        const json: any = await res.json();
        const purchase: any[] = Array.isArray(json?.purchase) ? json.purchase : [];
        const items: BringListItem[] = purchase.map(p => ({
            name: String(p?.name ?? '').trim(),
            specification: String(p?.specification ?? '').trim(),
        })).filter(i => i.name.length > 0);

        return { listName, listUuid, items };
    }

    /** Case-insensitive lookup of an item already on the list. */
    async findItem(name: string): Promise<BringListItem | null> {
        const target = (name || '').trim().toLowerCase();
        if (!target) return null;
        const { items } = await this.getList();
        return items.find(i => i.name.toLowerCase() === target) ?? null;
    }

    /**
     * Add an item to the list (or overwrite its specification if it is already
     * there — Bring! keys items by name, so "save" is an upsert).
     */
    async saveItem(name: string, specification = ''): Promise<void> {
        const itemName = (name || '').trim();
        if (!itemName) {
            throw new Error('An item name is required.');
        }
        const session = await this.ensureSession();
        const { listUuid } = await this.resolveList(session);
        await this.putListChange(session, listUuid, {
            purchase: itemName,
            specification: (specification || '').trim(),
            remove: '',
        });
    }

    /** Remove an item from the "to buy" section of the list. */
    async removeItem(name: string): Promise<void> {
        const itemName = (name || '').trim();
        if (!itemName) {
            throw new Error('An item name is required.');
        }
        const session = await this.ensureSession();
        const { listUuid } = await this.resolveList(session);
        await this.putListChange(session, listUuid, {
            purchase: '',
            specification: '',
            remove: itemName,
        });
    }

    private async putListChange(
        session: BringSession,
        listUuid: string,
        change: { purchase: string; specification: string; remove: string },
    ): Promise<void> {
        const body = new URLSearchParams({
            purchase: change.purchase,
            recently: '',
            specification: change.specification,
            remove: change.remove,
            sender: 'null',
        });
        const res = await fetch(`${BRING_REST_URL}bringlists/${listUuid}`, {
            method: 'PUT',
            headers: {
                ...this.authHeaders(session),
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Bring! rejected the change (HTTP ${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
        }
    }
}
