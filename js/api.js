import {
    API_BASE,
    BASE_RETRY_MS,
    CONCURRENCY,
    MAX_GAP_MS,
    MAX_RETRIES,
    MIN_GAP_MS,
} from './constants.js';
import { appState } from './state.js';

const STORAGE_PREFIX = 'camdram-connected:api-cache:';
const STORAGE_INDEX_KEY = `${STORAGE_PREFIX}index`;
const STORAGE_VERSION = 1;
const STORAGE_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_MAX_ENTRIES = 200;

function canUseLocalStorage() {
    try {
        return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
    } catch {
        return false;
    }
}

function getStorageKey(url) {
    return `${STORAGE_PREFIX}${url}`;
}

function readStorageIndex() {
    if (!canUseLocalStorage()) return [];

    try {
        const raw = window.localStorage.getItem(STORAGE_INDEX_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeStorageIndex(index) {
    if (!canUseLocalStorage()) return;
    window.localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(index));
}

function removePersistentEntry(key, index = readStorageIndex()) {
    if (!canUseLocalStorage()) return index;

    window.localStorage.removeItem(key);
    const nextIndex = index.filter((entryKey) => entryKey !== key);
    writeStorageIndex(nextIndex);
    return nextIndex;
}

function touchPersistentEntry(key, index = readStorageIndex()) {
    const nextIndex = index.filter((entryKey) => entryKey !== key);
    nextIndex.push(key);
    writeStorageIndex(nextIndex);
    return nextIndex;
}

function prunePersistentCache(index = readStorageIndex()) {
    if (!canUseLocalStorage()) return [];

    let nextIndex = [...index];
    const cutoff = Date.now() - STORAGE_TTL_MS;
    for (const key of index) {
        try {
            const raw = window.localStorage.getItem(key);
            if (!raw) {
                nextIndex = nextIndex.filter((entryKey) => entryKey !== key);
                continue;
            }

            const entry = JSON.parse(raw);
            if (entry.version !== STORAGE_VERSION || entry.savedAt < cutoff) {
                nextIndex = removePersistentEntry(key, nextIndex);
            }
        } catch {
            nextIndex = removePersistentEntry(key, nextIndex);
        }
    }

    while (nextIndex.length > STORAGE_MAX_ENTRIES) {
        nextIndex = removePersistentEntry(nextIndex[0], nextIndex);
    }

    return nextIndex;
}

function readPersistentResponse(url) {
    if (!canUseLocalStorage()) return { hit: false };

    const key = getStorageKey(url);
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return { hit: false };

        const entry = JSON.parse(raw);
        if (entry.version !== STORAGE_VERSION || Date.now() - entry.savedAt > STORAGE_TTL_MS) {
            removePersistentEntry(key);
            return { hit: false };
        }

        touchPersistentEntry(key);
        return { hit: true, data: entry.data };
    } catch {
        removePersistentEntry(key);
        return { hit: false };
    }
}

function writePersistentResponse(url, data) {
    if (!canUseLocalStorage()) return;

    const key = getStorageKey(url);
    const payload = JSON.stringify({
        version: STORAGE_VERSION,
        savedAt: Date.now(),
        data,
    });

    let index = prunePersistentCache();
    try {
        window.localStorage.setItem(key, payload);
        touchPersistentEntry(key, index);
        return;
    } catch {
        // Local storage quota small. Evict oldest entries until write fits.
    }

    while (index.length > 0) {
        index = removePersistentEntry(index[0], index);
        try {
            window.localStorage.setItem(key, payload);
            touchPersistentEntry(key, index);
            return;
        } catch {
            // Keep evicting until write succeeds or cache is empty.
        }
    }
}

class FetchPool {
    constructor() {
        this._inFlight = 0;
        this._queue = [];
        this._lastStartTime = 0;
        this._minGapMs = MIN_GAP_MS;
    }

    fetch(url) {
        return new Promise((resolve, reject) => {
            const task = { url, resolve, reject };
            if (this._inFlight < CONCURRENCY) {
                this._run(task);
            } else {
                this._queue.push(task);
            }
        });
    }

    async _run(task) {
        this._inFlight++;
        try {
            const now = Date.now();
            const elapsed = now - this._lastStartTime;
            if (elapsed < this._minGapMs) {
                await new Promise((resolve) => setTimeout(resolve, this._minGapMs - elapsed));
            }
            this._lastStartTime = Date.now();

            const result = await this._fetchWithRetry(task.url);
            task.resolve(result);
        } catch (err) {
            task.reject(err);
        } finally {
            this._inFlight--;
            this._dequeue();
        }
    }

    async _fetchWithRetry(url) {
        const cached = readPersistentResponse(url);
        if (cached.hit) {
            appState.cacheHits++;
            return cached.data;
        }

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const resp = await fetch(url);
            if (resp.status === 429 && attempt < MAX_RETRIES) {
                this._minGapMs = Math.min(MAX_GAP_MS, this._minGapMs + 50);
                const delay = BASE_RETRY_MS * Math.pow(2, attempt);
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }
            if (!resp.ok) {
                if (resp.status === 404) {
                    writePersistentResponse(url, null);
                    return null;
                }
                throw new Error(`API error ${resp.status} for ${url}`);
            }
            this._minGapMs = Math.max(MIN_GAP_MS, this._minGapMs - 5);
            const data = await resp.json();
            writePersistentResponse(url, data);
            return data;
        }
    }

    _dequeue() {
        if (this._queue.length > 0 && this._inFlight < CONCURRENCY) {
            const next = this._queue.shift();
            this._run(next);
        }
    }
}

export const pool = new FetchPool();

function rerankPeopleResults(results, query) {
    const queryTokens = query.split(/\s+/).filter(Boolean);
    return [...results].sort((a, b) => scorePersonResult(b, queryTokens, query) - scorePersonResult(a, queryTokens, query));
}

function scorePersonResult(person, queryTokens, fullQuery) {
    const name = person.name.toLowerCase();
    const slug = person.slug.toLowerCase();
    let score = 0;

    if (name === fullQuery) score += 200;
    if (slug === fullQuery) score += 180;
    if (name.startsWith(fullQuery)) score += 120;
    if (slug.startsWith(fullQuery)) score += 100;
    if (name.includes(fullQuery)) score += 50;
    if (slug.includes(fullQuery)) score += 35;

    for (const token of queryTokens) {
        if (name.startsWith(token)) score += 15;
        if (slug.startsWith(token)) score += 10;
        if (name.includes(token)) score += 4;
    }

    return score;
}

export async function searchPeople(query) {
    if (query.length < 2) return [];
    const normalized = query.trim().toLowerCase();
    if (appState.peopleSearchCache.has(normalized)) {
        appState.cacheHits++;
        return appState.peopleSearchCache.get(normalized);
    }

    const data = await pool.fetch(`${API_BASE}/people.json?q=${encodeURIComponent(query)}`);
    const ranked = rerankPeopleResults(data || [], normalized);
    appState.peopleSearchCache.set(normalized, ranked);
    return ranked;
}

export async function getPersonRoles(slug) {
    const data = await pool.fetch(`${API_BASE}/people/${encodeURIComponent(slug)}/roles.json`);
    return data || [];
}

export async function getShowRoles(slug) {
    const data = await pool.fetch(`${API_BASE}/shows/${encodeURIComponent(slug)}/roles.json`);
    return data || [];
}

export function prefetchPersonRoles(slug) {
    if (!slug || appState.personRolesCache.has(slug)) return;
    getPersonRoles(slug)
        .then((roles) => {
            appState.personRolesCache.set(slug, roles || []);
            const firstRole = roles && roles[0];
            if (firstRole && firstRole.person && firstRole.person.name) {
                appState.peopleNames.set(slug, firstRole.person.name);
            }
        })
        .catch(() => {
            // Prefetch should never interrupt manual search flow.
        });
}

export async function getCachedPersonRoles(personSlug, roleTypes) {
    let raw;
    if (appState.personRolesCache.has(personSlug)) {
        raw = appState.personRolesCache.get(personSlug);
        appState.cacheHits++;
    } else {
        raw = await getPersonRoles(personSlug);
        appState.personRolesCache.set(personSlug, raw);
    }
    const filtered = raw.filter((role) => roleTypes.includes(role.type));
    if (filtered.length > 0) {
        appState.peopleNames.set(personSlug, filtered[0].person.name);
    }
    return filtered;
}

async function getCachedShowRoles(showSlug, roleTypes) {
    let raw;
    if (appState.showRolesCache.has(showSlug)) {
        raw = appState.showRolesCache.get(showSlug);
        appState.cacheHits++;
    } else {
        raw = await getShowRoles(showSlug);
        appState.showRolesCache.set(showSlug, raw);
    }
    return raw.filter((role) => roleTypes.includes(role.type));
}

function estimateShowCost(showSlug) {
    const cachedRoles = appState.showRolesCache.get(showSlug);
    return cachedRoles ? cachedRoles.length : Number.MAX_SAFE_INTEGER;
}

export async function expandPerson(personSlug, roleTypes, options = {}) {
    const { onLog, onShowFetched } = options;
    const adjacencyKey = `${[...roleTypes].sort().join('|')}:${personSlug}`;
    if (appState.adjacencyCache.has(adjacencyKey)) {
        appState.cacheHits++;
        return appState.adjacencyCache.get(adjacencyKey);
    }

    const wasCached = appState.personRolesCache.has(personSlug);
    const roles = await getCachedPersonRoles(personSlug, roleTypes);
    const personName = appState.peopleNames.get(personSlug) || personSlug;

    if (!wasCached && onLog) {
        onLog(`Fetched roles for ${personName} (${roles.length} roles)`);
    }

    const showMap = new Map();
    for (const role of roles) {
        const key = role.show.slug;
        if (!showMap.has(key)) showMap.set(key, { show: role.show, roles: [] });
        showMap.get(key).roles.push(role);
    }

    const showEntries = Array.from(showMap.entries()).sort((a, b) => estimateShowCost(a[0]) - estimateShowCost(b[0]));
    const showRolesResults = await Promise.all(
        showEntries.map(async ([showSlug, showData]) => {
            const showCached = appState.showRolesCache.has(showSlug);
            const showRoles = await getCachedShowRoles(showSlug, roleTypes);
            if (!showCached) {
                if (onLog) onLog(`Fetched ${showData.show.name} (${showRoles.length} people)`);
                if (onShowFetched) onShowFetched();
            }
            return { showSlug, showData, showRoles };
        })
    );

    const connectionsByCoworker = new Map();
    for (const { showSlug, showData, showRoles } of showRolesResults) {
        for (const role of showRoles) {
            if (role.person.slug === personSlug) continue;

            const coSlug = role.person.slug;
            appState.peopleNames.set(coSlug, role.person.name);

            if (!connectionsByCoworker.has(coSlug)) {
                connectionsByCoworker.set(coSlug, new Map());
            }
            const showConns = connectionsByCoworker.get(coSlug);
            if (!showConns.has(showSlug)) {
                showConns.set(showSlug, {
                    showSlug,
                    showName: showData.show.name,
                    fromRoles: new Set(),
                    toRoles: new Set(),
                });
            }
            const connection = showConns.get(showSlug);
            for (const sourceRole of showData.roles) connection.fromRoles.add(sourceRole.role);
            connection.toRoles.add(role.role);
        }
    }

    appState.adjacencyCache.set(adjacencyKey, connectionsByCoworker);
    return connectionsByCoworker;
}

export function estimateFrontierCost(frontier, roleTypes) {
    let totalCost = 0;
    for (const personSlug of frontier) {
        if (!appState.personRolesCache.has(personSlug)) {
            totalCost += 1000;
            continue;
        }

        const roles = appState.personRolesCache.get(personSlug).filter((role) => roleTypes.includes(role.type));
        const uniqueShows = new Set(roles.map((role) => role.show.slug));
        for (const showSlug of uniqueShows) {
            totalCost += estimateShowCost(showSlug);
        }
    }
    return totalCost;
}
