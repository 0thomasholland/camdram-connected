import {
    API_BASE,
    BASE_RETRY_MS,
    CONCURRENCY,
    MAX_GAP_MS,
    MAX_RETRIES,
    MIN_GAP_MS,
} from './constants.js';
import { appState } from './state.js';

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
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const resp = await fetch(url);
            if (resp.status === 429 && attempt < MAX_RETRIES) {
                this._minGapMs = Math.min(MAX_GAP_MS, this._minGapMs + 50);
                const delay = BASE_RETRY_MS * Math.pow(2, attempt);
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }
            if (!resp.ok) {
                if (resp.status === 404) return null;
                throw new Error(`API error ${resp.status} for ${url}`);
            }
            this._minGapMs = Math.max(MIN_GAP_MS, this._minGapMs - 5);
            return resp.json();
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
