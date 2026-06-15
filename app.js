// Camdram Connected - Connection finder for Cambridge theatre people

// Use local CORS proxy (/api/...) when available (Cloudflare Pages Functions),
// fall back to direct API access for environments where CORS isn't an issue.
const API_BASE = '/api';

// ── Fetch pool with concurrency, rate limiting, and retry ──

const CONCURRENCY = 4;
const MIN_GAP_MS = 50;
const MAX_GAP_MS = 400;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 200;

const GRAPH_PALETTE = {
    startNode: { background: '#d97745', border: '#b4532a', highlight: { background: '#ea8a58', border: '#c96133' } },
    endNode: { background: '#d97745', border: '#b4532a', highlight: { background: '#ea8a58', border: '#c96133' } },
    midNode: { background: '#8b7cf6', border: '#6f61da', highlight: { background: '#9a8cff', border: '#7d70e6' } },
    quietNode: { background: '#4b4d67', border: '#393b51', highlight: { background: '#5c5f7c', border: '#4a4d67' } },
    activeEdge: '#5b5ce2',
    baseEdge: '#71758e',
    mutedEdge: '#d3cec2',
    label: '#2f2c2f',
    labelMuted: '#5c5960',
    dimFill: '#ddd7cb',
    dimBorder: '#b7b0a2',
};

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
            // Enforce minimum gap between request starts
            const now = Date.now();
            const elapsed = now - this._lastStartTime;
            if (elapsed < this._minGapMs) {
                await new Promise(r => setTimeout(r, this._minGapMs - elapsed));
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
                await new Promise(r => setTimeout(r, delay));
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

const pool = new FetchPool();

// ── State ──

let network = null;

// Persistent caches (survive across searches)
const personRolesCache = new Map(); // slug -> raw roles[] (unfiltered)
const showRolesCache = new Map();   // slug -> raw roles[] (unfiltered)
const adjacencyCache = new Map();   // roleKey:personSlug -> coworker map
const peopleSearchCache = new Map(); // query -> ranked people[]
const peopleNames = new Map();      // slug -> display name
let cacheHits = 0;
let currentSearchToken = 0;
let currentHighlightedPath = null;
let graphState = null;

// ── DOM refs ──

const person1Input = document.getElementById('person1');
const person2Input = document.getElementById('person2');
const person1Slug = document.getElementById('person1-slug');
const person2Slug = document.getElementById('person2-slug');
const person1List = document.getElementById('person1-list');
const person2List = document.getElementById('person2-list');
const person1Selected = document.getElementById('person1-selected');
const person2Selected = document.getElementById('person2-selected');
const swapBtn = document.getElementById('swap-btn');
const findBtn = document.getElementById('find-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const degreesBadge = document.getElementById('degrees-badge');
const resultSummaryEl = document.getElementById('result-summary');
const graphPanel = document.getElementById('graph-panel');
const graphContainer = document.getElementById('graph-container');
const detailsContent = document.getElementById('details-content');
const resetViewBtn = document.getElementById('reset-view-btn');
const exportBtn = document.getElementById('export-btn');
const shareBtn = document.getElementById('share-btn');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressLog = document.getElementById('progress-log');
const progressDepthEl = document.getElementById('progress-depth');
const progressShowsEl = document.getElementById('progress-shows');
const progressCacheEl = document.getElementById('progress-cache');
const progressPathsEl = document.getElementById('progress-paths');
const progressSummaryEl = document.getElementById('progress-summary');
const progressToggle = document.getElementById('progress-toggle');

// ── API layer ──

async function searchPeople(query) {
    if (query.length < 2) return [];
    const normalized = query.trim().toLowerCase();
    if (peopleSearchCache.has(normalized)) {
        cacheHits++;
        return peopleSearchCache.get(normalized);
    }

    const data = await pool.fetch(`${API_BASE}/people.json?q=${encodeURIComponent(query)}`);
    const ranked = rerankPeopleResults(data || [], normalized);
    peopleSearchCache.set(normalized, ranked);
    return ranked;
}

async function getPersonRoles(slug) {
    const data = await pool.fetch(`${API_BASE}/people/${encodeURIComponent(slug)}/roles.json`);
    return data || [];
}

async function getShowRoles(slug) {
    const data = await pool.fetch(`${API_BASE}/shows/${encodeURIComponent(slug)}/roles.json`);
    return data || [];
}

// ── Autocomplete ──

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

function renderAutocompleteState(list, message, className = 'empty') {
    list.innerHTML = '';
    const item = document.createElement('div');
    item.className = `autocomplete-item ${className}`;
    item.textContent = message;
    list.appendChild(item);
    list.classList.add('visible');
}

function setSelectedPersonUI(input, slugInput, selectedEl, person) {
    const hasSelection = Boolean(person && person.slug);

    if (hasSelection) {
        input.classList.add('selected');
        selectedEl.textContent = `@${person.slug}`;
        selectedEl.classList.remove('hidden');
        input.setAttribute('aria-label', `${person.name}, selected`);
    } else {
        input.classList.remove('selected');
        selectedEl.textContent = '';
        selectedEl.classList.add('hidden');
        input.removeAttribute('aria-label');
    }

    if (!hasSelection) slugInput.value = '';
}

function prefetchPersonRoles(slug) {
    if (!slug || personRolesCache.has(slug)) return;
    getPersonRoles(slug)
        .then((roles) => {
            personRolesCache.set(slug, roles || []);
            const firstRole = roles && roles[0];
            if (firstRole && firstRole.person && firstRole.person.name) {
                peopleNames.set(slug, firstRole.person.name);
            }
        })
        .catch(() => {
            // Prefetch should never interrupt manual search flow.
        });
}

function setupAutocomplete(input, list, slugInput) {
    let debounceTimer = null;
    let activeIndex = -1;
    let requestId = 0;
    const selectedEl = input === person1Input ? person1Selected : person2Selected;

    function closeList() {
        list.classList.remove('visible');
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    input.addEventListener('input', () => {
        // Clear selection when user modifies text
        setSelectedPersonUI(input, slugInput, selectedEl, null);
        updateFindButton();

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            const query = input.value.trim();
            if (query.length < 2) {
                if (query.length === 0) {
                    closeList();
                } else {
                    renderAutocompleteState(list, 'Keep typing for suggestions.');
                    input.setAttribute('aria-expanded', 'true');
                }
                return;
            }

            const thisRequestId = ++requestId;
            renderAutocompleteState(list, 'Searching...', 'loading');
            input.setAttribute('aria-expanded', 'true');

            try {
                const results = await searchPeople(query);
                if (thisRequestId !== requestId || input.value.trim() !== query) return;

                renderAutocomplete(list, results, (person) => {
                    input.value = person.name;
                    slugInput.value = person.slug;
                    setSelectedPersonUI(input, slugInput, selectedEl, person);
                    closeList();
                    updateFindButton();
                    prefetchPersonRoles(person.slug);
                });
                activeIndex = -1;
                input.removeAttribute('aria-activedescendant');
            } catch {
                if (thisRequestId !== requestId) return;
                renderAutocompleteState(list, 'Search unavailable right now.', 'error');
                input.setAttribute('aria-expanded', 'true');
            }
        }, 300);
    });

    input.addEventListener('keydown', (e) => {
        const items = list.querySelectorAll('.autocomplete-item');
        if (!items.length) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, items.length - 1);
            updateActiveItem(input, items, activeIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            updateActiveItem(input, items, activeIndex);
        } else if (e.key === 'Enter' && activeIndex >= 0) {
            e.preventDefault();
            items[activeIndex].click();
        } else if (e.key === 'Enter' && person1Slug.value && person2Slug.value) {
            e.preventDefault();
            findBtn.click();
        } else if (e.key === 'Escape') {
            closeList();
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !list.contains(e.target)) {
            closeList();
        }
    });
}

function renderAutocomplete(list, results, onSelect) {
    list.innerHTML = '';
    if (results.length === 0) {
        renderAutocompleteState(list, 'No matches found.');
        return;
    }
    for (const [index, person] of results.slice(0, 8).entries()) {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.id = `${list.id}-option-${index}`;
        item.setAttribute('role', 'option');
        item.innerHTML = `${escapeHtml(person.name)} <span class="slug">${escapeHtml(person.slug)}</span>`;
        item.addEventListener('click', () => onSelect(person));
        list.appendChild(item);
    }
    list.classList.add('visible');
    const ownerInput = list.id === 'person1-list' ? person1Input : person2Input;
    ownerInput.setAttribute('aria-expanded', 'true');
}

function updateActiveItem(input, items, index) {
    items.forEach((item, i) => {
        item.classList.toggle('active', i === index);
        item.setAttribute('aria-selected', i === index ? 'true' : 'false');
    });

    const activeItem = items[index];
    if (activeItem) {
        input.setAttribute('aria-activedescendant', activeItem.id);
    } else {
        input.removeAttribute('aria-activedescendant');
    }
}

function updateFindButton() {
    findBtn.disabled = !(person1Slug.value && person2Slug.value) || person1Slug.value === person2Slug.value;
}

// ── Status display ──

function showStatus(message, type = 'loading') {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.classList.remove('hidden');
}

function hideStatus() {
    statusEl.classList.add('hidden');
}

function showError(message) {
    showStatus(message, 'error');
}

// ── Progress display ──

function resetProgress() {
    progressContainer.classList.remove('hidden');
    progressLog.innerHTML = '';
    progressBar.style.width = '0%';
    progressDepthEl.textContent = '';
    progressShowsEl.textContent = '0 shows';
    progressCacheEl.textContent = '0 cached';
    progressPathsEl.textContent = '0 paths';
    progressSummaryEl.textContent = 'Preparing search...';
    cacheHits = 0;
}

function hideProgress() {
    progressContainer.classList.add('hidden');
}

function updateProgress(depthLabel, current, total, showCount, pathCount) {
    progressDepthEl.textContent = `${depthLabel} — ${current}/${total} people`;
    progressShowsEl.textContent = `${showCount} show${showCount !== 1 ? 's' : ''}`;
    progressCacheEl.textContent = `${cacheHits} cached`;
    progressPathsEl.textContent = `${pathCount} path${pathCount !== 1 ? 's' : ''}`;
    progressSummaryEl.textContent = buildProgressSummary(depthLabel, current, total, showCount, pathCount);
    const pct = total > 0 ? (current / total) * 100 : 0;
    progressBar.style.width = `${pct}%`;
}

function buildProgressSummary(depthLabel, current, total, showCount, pathCount) {
    if (pathCount > 0) {
        return `${depthLabel}: found ${pathCount} candidate path${pathCount !== 1 ? 's' : ''}, finishing current layer.`;
    }
    if (showCount > 0) {
        return `${depthLabel}: explored ${current}/${total} people and checked ${showCount} show${showCount !== 1 ? 's' : ''}.`;
    }
    return `${depthLabel}: exploring connections...`;
}

function logFetch(message, type = '') {
    const line = document.createElement('div');
    line.className = 'log-line' + (type ? ` ${type}` : '');
    line.textContent = message;
    progressLog.appendChild(line);
    progressLog.scrollTop = progressLog.scrollHeight;
}

// ── Shared helpers for BFS ──

function getActiveRoleTypes() {
    return Array.from(document.querySelectorAll('.filters fieldset input[type="checkbox"]:checked'))
        .map(cb => cb.value);
}

function getRoleTypeKey(roleTypes) {
    return [...roleTypes].sort().join('|');
}

function isShortestOnlyMode() {
    return document.querySelector('input[name="search-mode"]:checked')?.value !== 'all';
}

function getSelectedMaxDepth() {
    return parseInt(document.querySelector('input[name="max-depth"]:checked')?.value || '2', 10);
}

/**
 * Fetches and caches a person's roles, returns filtered by roleTypes.
 * Uses persistent module-level cache; stores raw unfiltered data.
 */
async function getCachedPersonRoles(personSlug, roleTypes) {
    let raw;
    if (personRolesCache.has(personSlug)) {
        raw = personRolesCache.get(personSlug);
        cacheHits++;
    } else {
        raw = await getPersonRoles(personSlug);
        personRolesCache.set(personSlug, raw);
    }
    const filtered = raw.filter(r => roleTypes.includes(r.type));
    if (filtered.length > 0) {
        peopleNames.set(personSlug, filtered[0].person.name);
    }
    return filtered;
}

/**
 * Fetches and caches a show's roles, returns filtered by roleTypes.
 * Uses persistent module-level cache; stores raw unfiltered data.
 */
async function getCachedShowRoles(showSlug, roleTypes) {
    let raw;
    if (showRolesCache.has(showSlug)) {
        raw = showRolesCache.get(showSlug);
        cacheHits++;
    } else {
        raw = await getShowRoles(showSlug);
        showRolesCache.set(showSlug, raw);
    }
    return raw.filter(r => roleTypes.includes(r.type));
}

/**
 * Expand a person: fetch their roles, group by show, fetch all shows in parallel,
 * build a map of coworkers with shared show info.
 *
 * Returns Map<coSlug, {shows: [{showSlug, showName, fromRoles: Set, toRoles: Set}]}>
 */
async function expandPerson(personSlug, roleTypes, progressCallback) {
    const adjacencyKey = `${getRoleTypeKey(roleTypes)}:${personSlug}`;
    if (adjacencyCache.has(adjacencyKey)) {
        cacheHits++;
        return adjacencyCache.get(adjacencyKey);
    }

    const wasCached = personRolesCache.has(personSlug);
    const roles = await getCachedPersonRoles(personSlug, roleTypes);
    const personName = peopleNames.get(personSlug) || personSlug;

    if (!wasCached) {
        logFetch(`Fetched roles for ${personName} (${roles.length} roles)`);
    }

    // Group by show
    const showMap = new Map();
    for (const r of roles) {
        const key = r.show.slug;
        if (!showMap.has(key)) showMap.set(key, { show: r.show, roles: [] });
        showMap.get(key).roles.push(r);
    }

    // Fetch all shows in parallel (pool throttles naturally)
    const showEntries = Array.from(showMap.entries()).sort((a, b) => estimateShowCost(a[0]) - estimateShowCost(b[0]));
    const showRolesResults = await Promise.all(
        showEntries.map(async ([showSlug, showData]) => {
            const showCached = showRolesCache.has(showSlug);
            const showRoles = await getCachedShowRoles(showSlug, roleTypes);
            if (!showCached) {
                logFetch(`Fetched ${showData.show.name} (${showRoles.length} people)`);
                if (progressCallback) progressCallback();
            }
            return { showSlug, showData, showRoles };
        })
    );

    // Build coworker connections
    const connectionsByCoworker = new Map(); // coSlug -> Map<showSlug, showInfo>
    for (const { showSlug, showData, showRoles } of showRolesResults) {
        for (const r of showRoles) {
            if (r.person.slug === personSlug) continue;

            const coSlug = r.person.slug;
            peopleNames.set(coSlug, r.person.name);

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
            const conn = showConns.get(showSlug);
            for (const role of showData.roles) conn.fromRoles.add(role.role);
            conn.toRoles.add(r.role);
        }
    }

    adjacencyCache.set(adjacencyKey, connectionsByCoworker);
    return connectionsByCoworker;
}

function estimateShowCost(showSlug) {
    const cachedRoles = showRolesCache.get(showSlug);
    return cachedRoles ? cachedRoles.length : Number.MAX_SAFE_INTEGER;
}

function estimateFrontierCost(frontier, roleTypes) {
    let totalCost = 0;
    for (const personSlug of frontier) {
        if (!personRolesCache.has(personSlug)) {
            totalCost += 1000;
            continue;
        }

        const roles = personRolesCache.get(personSlug).filter(r => roleTypes.includes(r.type));
        const uniqueShows = new Set(roles.map(r => r.show.slug));
        for (const showSlug of uniqueShows) {
            totalCost += estimateShowCost(showSlug);
        }
    }
    return totalCost;
}

/**
 * Convert a coworker connection map entry to an edge object.
 */
function buildEdge(fromSlug, toSlug, showConnsMap) {
    const shows = Array.from(showConnsMap.values()).map(s => ({
        showSlug: s.showSlug,
        showName: s.showName,
        fromRole: Array.from(s.fromRoles).join(', '),
        toRole: Array.from(s.toRoles).join(', '),
    }));
    return { from: fromSlug, to: toSlug, shows };
}

function pathRepeatsShow(edges) {
    const seenShows = new Set();
    for (const edge of edges) {
        for (const show of edge.shows) {
            if (seenShows.has(show.showSlug)) return true;
        }
        for (const show of edge.shows) {
            seenShows.add(show.showSlug);
        }
    }
    return false;
}

// ── Connection finder — all paths (unidirectional BFS) ──

async function findAllUnidirectional(slug1, slug2, maxDepth, options = {}) {
    const roleTypes = getActiveRoleTypes();
    const { onPathFound } = options;

    const allPaths = [];
    const seenPathKeys = new Set();
    let queue = [{ personSlug: slug1, path: [slug1], edges: [], seenSlugs: new Set([slug1]) }];

    let showsFetched = 0;

    for (let depth = 0; depth < maxDepth; depth++) {
        const nextQueue = [];
        let peopleExplored = 0;
        const totalAtDepth = queue.length;
        const depthLabel = `Depth ${depth + 1}/${maxDepth}`;
        updateProgress(depthLabel, 0, totalAtDepth, showsFetched, allPaths.length);

        // Process people in parallel batches of 3
        const BATCH_SIZE = 3;
        for (let i = 0; i < queue.length; i += BATCH_SIZE) {
            const batch = queue.slice(i, i + BATCH_SIZE);

            const batchResults = await Promise.all(
                batch.map(async (entry) => {
                    const connectionsByCoworker = await expandPerson(
                        entry.personSlug,
                        roleTypes,
                        () => {
                            showsFetched++;
                            updateProgress(depthLabel, peopleExplored, totalAtDepth, showsFetched, allPaths.length);
                        }
                    );
                    return { entry, connectionsByCoworker };
                })
            );

            // Sequential merge for visited-set safety
            for (const { entry, connectionsByCoworker } of batchResults) {
                for (const [coSlug, showConnsMap] of connectionsByCoworker) {
                    const newEdge = buildEdge(entry.personSlug, coSlug, showConnsMap);
                    const newEdges = [...entry.edges, newEdge];

                    if (pathRepeatsShow(newEdges)) continue;

                    if (coSlug === slug2) {
                        const found = {
                            path: [...entry.path, coSlug],
                            edges: newEdges,
                        };
                        const pathKey = found.path.join('>');
                        if (!seenPathKeys.has(pathKey)) {
                            seenPathKeys.add(pathKey);
                            allPaths.push(found);
                            const pathNames = found.path.map(s => peopleNames.get(s) || s).join(' → ');
                            logFetch(`Found path: ${pathNames}`, 'found');
                            if (onPathFound) onPathFound({ paths: [...allPaths], peopleNames });
                        }
                    } else if (!entry.seenSlugs.has(coSlug)) {
                        nextQueue.push({
                            personSlug: coSlug,
                            path: [...entry.path, coSlug],
                            edges: newEdges,
                            seenSlugs: new Set([...entry.seenSlugs, coSlug]),
                        });
                    }
                }

                peopleExplored++;
                updateProgress(depthLabel, peopleExplored, totalAtDepth, showsFetched, allPaths.length);
            }
        }

        queue = nextQueue;
        if (queue.length === 0) break;
    }

    if (allPaths.length === 0) return null;
    return { paths: allPaths, peopleNames };
}

// ── Connection finder — shortest path (bidirectional BFS) ──

async function findShortestBidirectional(slug1, slug2, maxDepth, options = {}) {
    const roleTypes = getActiveRoleTypes();
    const { onPathFound } = options;

    // Forward: slug1 → slug2, Backward: slug2 → slug1
    let forwardFrontier = [slug1];
    let backwardFrontier = [slug2];

    const forwardVisited = new Set([slug1]);
    const backwardVisited = new Set([slug2]);

    // Path maps: slug -> [{path: [slugs...], edges: [edge...]}]
    const forwardPaths = new Map();
    forwardPaths.set(slug1, [{ path: [slug1], edges: [] }]);
    const backwardPaths = new Map();
    backwardPaths.set(slug2, [{ path: [slug2], edges: [] }]);

    let showsFetched = 0;
    const foundPaths = [];
    const seenPathKeys = new Set();
    let totalDepth = 0;

    for (let depth = 0; depth < maxDepth; depth++) {
        totalDepth = depth + 1;

        // Expand frontier with lower estimated API and branching cost.
        const forwardCost = estimateFrontierCost(forwardFrontier, roleTypes);
        const backwardCost = estimateFrontierCost(backwardFrontier, roleTypes);
        const expandForward = forwardCost === backwardCost
            ? forwardFrontier.length <= backwardFrontier.length
            : forwardCost < backwardCost;
        const frontier = expandForward ? forwardFrontier : backwardFrontier;
        const visited = expandForward ? forwardVisited : backwardVisited;
        const paths = expandForward ? forwardPaths : backwardPaths;
        const oppositePaths = expandForward ? backwardPaths : forwardPaths;
        const direction = expandForward ? 'Forward' : 'Backward';

        const depthLabel = `${direction} depth ${depth + 1}/${maxDepth}`;
        const totalAtDepth = frontier.length;
        let peopleExplored = 0;
        updateProgress(depthLabel, 0, totalAtDepth, showsFetched, foundPaths.length);

        const nextFrontier = [];

        // Process in parallel batches
        const BATCH_SIZE = 3;
        for (let i = 0; i < frontier.length; i += BATCH_SIZE) {
            const batch = frontier.slice(i, i + BATCH_SIZE);

            const batchResults = await Promise.all(
                batch.map(async (personSlug) => {
                    const connectionsByCoworker = await expandPerson(
                        personSlug,
                        roleTypes,
                        () => {
                            showsFetched++;
                            updateProgress(depthLabel, peopleExplored, totalAtDepth, showsFetched, foundPaths.length);
                        }
                    );
                    return { personSlug, connectionsByCoworker };
                })
            );

            // Sequential merge
            for (const { personSlug, connectionsByCoworker } of batchResults) {
                const currentPathsForPerson = paths.get(personSlug) || [];

                for (const [coSlug, showConnsMap] of connectionsByCoworker) {
                    const edge = buildEdge(personSlug, coSlug, showConnsMap);

                    // Build new partial paths to coSlug
                    const newPartials = currentPathsForPerson.map(p => ({
                        path: [...p.path, coSlug],
                        edges: [...p.edges, edge],
                    }));

                    // Check if coSlug is in the opposite frontier's visited set
                    if (oppositePaths.has(coSlug)) {
                        // Connection found! Combine paths
                        for (const fwd of newPartials) {
                            for (const bwd of oppositePaths.get(coSlug)) {
                                const combined = expandForward
                                    ? combinePaths(fwd, bwd)
                                    : combinePaths(bwd, fwd);
                                const pathKey = combined.path.join('>');
                                if (seenPathKeys.has(pathKey)) continue;
                                seenPathKeys.add(pathKey);
                                foundPaths.push(combined);
                                const pathNames = combined.path.map(s => peopleNames.get(s) || s).join(' → ');
                                logFetch(`Found path: ${pathNames}`, 'found');
                                if (onPathFound) onPathFound({ paths: [...foundPaths], peopleNames });
                            }
                        }
                    }

                    // Add to frontier if not visited (don't add target to visited in either direction)
                    if (!visited.has(coSlug)) {
                        visited.add(coSlug);
                        nextFrontier.push(coSlug);
                        paths.set(coSlug, newPartials);
                    } else if (paths.has(coSlug)) {
                        // Already visited but we store additional paths
                        // (only relevant for multiple shortest paths)
                        // Skip — first visit captures the shortest
                    }
                }

                peopleExplored++;
                updateProgress(depthLabel, peopleExplored, totalAtDepth, showsFetched, foundPaths.length);
            }
        }

        // If we found paths, stop
        if (foundPaths.length > 0) break;

        if (expandForward) {
            forwardFrontier = nextFrontier;
        } else {
            backwardFrontier = nextFrontier;
        }

        if (forwardFrontier.length === 0 && backwardFrontier.length === 0) break;
    }

    if (foundPaths.length === 0) return null;
    return { paths: foundPaths, peopleNames };
}

/**
 * Combine a forward partial path and a backward partial path that meet at a node.
 * The backward path is reversed so the combined path goes slug1 → ... → slug2.
 * Backward edges have their from/to and fromRole/toRole swapped.
 */
function combinePaths(forward, backward) {
    // backward.path is [slug2, ..., meetingPoint]
    // We need to reverse it and drop the meeting point (it's already in forward.path)
    const reversedBackPath = backward.path.slice(0, -1).reverse();
    const combinedPath = [...forward.path, ...reversedBackPath];

    // Reverse backward edges and swap from/to
    const reversedBackEdges = backward.edges.slice().reverse().map(e => ({
        from: e.to,
        to: e.from,
        shows: e.shows.map(s => ({
            showSlug: s.showSlug,
            showName: s.showName,
            fromRole: s.toRole,
            toRole: s.fromRole,
        })),
    }));

    return {
        path: combinedPath,
        edges: [...forward.edges, ...reversedBackEdges],
    };
}

// ── Connection finder dispatcher ──

async function findAllConnections(slug1, slug2, maxDepth, options = {}) {
    const roleTypes = getActiveRoleTypes();
    if (roleTypes.length === 0) {
        throw new Error('Select at least one role type');
    }

    if (isShortestOnlyMode()) {
        return findShortestBidirectional(slug1, slug2, maxDepth, options);
    } else {
        return findAllUnidirectional(slug1, slug2, maxDepth, options);
    }
}

// ── Graph visualization ──

function renderGraph(result) {
    const { paths, peopleNames: pNames } = result;
    const palette = GRAPH_PALETTE;

    const startSlug = paths[0].path[0];
    const endSlug = paths[0].path[paths[0].path.length - 1];

    const nodeData = [];
    const edgeData = [];
    const nodeIds = new Set();
    const edgeKeys = new Set();
    const nodePathMap = new Map();
    const edgePathMap = new Map();
    const nodeBaseStyles = new Map();
    const edgeBaseStyles = new Map();

    currentHighlightedPath = null;

    for (const [pathIndex, { path, edges }] of paths.entries()) {
        // Add person nodes
        for (const slug of path) {
            const nodeId = `person:${slug}`;
            addPathMembership(nodePathMap, nodeId, pathIndex);
            if (nodeIds.has(nodeId)) continue;
            nodeIds.add(nodeId);

            const name = pNames.get(slug) || slug;
            const isEndpoint = slug === startSlug || slug === endSlug;
            const isStart = slug === startSlug;
            const isEnd = slug === endSlug;
            const nodeColor = isStart ? palette.startNode : (isEnd ? palette.endNode : (path.length <= 3 ? palette.midNode : palette.quietNode));
            nodeData.push({
                id: nodeId,
                label: name,
                shape: 'dot',
                size: isEndpoint ? 25 : 18,
                x: slug === startSlug ? -220 : (slug === endSlug ? 220 : undefined),
                y: isEndpoint ? 0 : undefined,
                fixed: isEndpoint ? { x: true, y: true } : false,
                color: nodeColor,
                font: {
                    color: isEndpoint ? palette.label : palette.labelMuted,
                    size: isEndpoint ? 17 : 14,
                    strokeWidth: 5,
                    strokeColor: '#fffdf8',
                    face: '-apple-system, BlinkMacSystemFont, sans-serif',
                },
            });
            nodeBaseStyles.set(nodeId, {
                color: nodeColor,
            });
        }

        // Add direct person-to-person edges. Show details stay in cards.
        for (const edge of edges) {
            const key = `person:${edge.from}->person:${edge.to}`;
            addPathMembership(edgePathMap, key, pathIndex);
            if (!edgeKeys.has(key)) {
                edgeKeys.add(key);
                edgeData.push({
                    id: key,
                    from: `person:${edge.from}`,
                    to: `person:${edge.to}`,
                    color: { color: path.length === 2 ? palette.activeEdge : palette.baseEdge, highlight: palette.activeEdge },
                    width: 2,
                    smooth: false,
                    title: `${pNames.get(edge.from)} and ${pNames.get(edge.to)} worked together`,
                });
                edgeBaseStyles.set(key, { color: { color: path.length === 2 ? palette.activeEdge : palette.baseEdge, highlight: palette.activeEdge }, width: 2 });
            }
        }
    }

    const data = {
        nodes: new vis.DataSet(nodeData),
        edges: new vis.DataSet(edgeData),
    };

    graphState = {
        nodes: data.nodes,
        edges: data.edges,
        nodePathMap,
        edgePathMap,
        nodeBaseStyles,
        edgeBaseStyles,
    };

    const options = {
        physics: {
            solver: 'forceAtlas2Based',
            forceAtlas2Based: {
                gravitationalConstant: -70,
                centralGravity: 0.005,
                springLength: 160,
                springConstant: 0.06,
            },
            stabilization: { iterations: 150 },
        },
        interaction: {
            hover: true,
            tooltipDelay: 100,
        },
        layout: {
            improvedLayout: true,
        },
        edges: {
            smooth: false,
        },
    };

    if (network) network.destroy();
    network = new vis.Network(graphContainer, data, options);
}

function addPathMembership(pathMap, key, pathIndex) {
    if (!pathMap.has(key)) pathMap.set(key, new Set());
    pathMap.get(key).add(pathIndex);
}

function highlightPath(pathIndex) {
    if (!graphState) return;

    currentHighlightedPath = currentHighlightedPath === pathIndex ? null : pathIndex;
    const activePath = currentHighlightedPath;

    const nodeUpdates = graphState.nodes.get().map((node) => {
        const inPath = activePath === null || graphState.nodePathMap.get(node.id)?.has(activePath);
        const baseStyle = graphState.nodeBaseStyles.get(node.id);
        return {
            id: node.id,
            opacity: inPath ? 1 : 0.25,
            color: inPath
                ? {
                    background: baseStyle.color.background,
                    border: baseStyle.color.border,
                    highlight: baseStyle.color.highlight,
                }
                : {
                    background: palette.dimFill,
                    border: palette.dimBorder,
                    highlight: baseStyle.color.highlight,
                },
        };
    });

    const edgeUpdates = graphState.edges.get().map((edge) => {
        const inPath = activePath === null || graphState.edgePathMap.get(edge.id)?.has(activePath);
        const baseStyle = graphState.edgeBaseStyles.get(edge.id);
        return {
            id: edge.id,
            width: inPath ? 3 : 1.2,
            color: inPath ? { color: baseStyle.color.color, highlight: palette.activeEdge } : { color: palette.mutedEdge, highlight: baseStyle.color.highlight },
        };
    });

    graphState.nodes.update(nodeUpdates);
    graphState.edges.update(edgeUpdates);

    document.querySelectorAll('.connection-path').forEach((el) => {
        el.classList.toggle('active', activePath !== null && Number(el.dataset.pathIndex) === activePath);
    });
}

function resetGraphView() {
    if (!network) return;

    highlightPath(null);
    network.stopSimulation();
    network.fit({
        animation: {
            duration: 500,
            easingFunction: 'easeInOutQuad',
        },
    });
}

// ── Details panel ──

function renderDetails(result) {
    const { paths, peopleNames: pNames } = result;

    // Group paths by degree
    const byDegree = new Map();
    paths.forEach(({ path, edges }, pathIndex) => {
        const degree = path.length - 1;
        if (!byDegree.has(degree)) byDegree.set(degree, []);
        byDegree.get(degree).push({ path, edges, pathIndex });
    });

    let html = '';
    const sortedDegrees = [...byDegree.keys()].sort((a, b) => a - b);

    for (const degree of sortedDegrees) {
        const degreePaths = byDegree.get(degree);
        html += `<div class="degree-group" data-degree="${degree}">`;
        html += `<div class="degree-heading">${degree} degree${degree !== 1 ? 's' : ''} of separation &mdash; ${degreePaths.length} path${degreePaths.length !== 1 ? 's' : ''}</div>`;
        html += `<div class="path-grid">`;

        for (const { path, edges, pathIndex } of degreePaths) {
            const middlePeople = path.slice(1, -1).map(s => escapeHtml(pNames.get(s) || s));
            const pathLabel = middlePeople.length > 0
                ? `&rarr; ${middlePeople.join(' &rarr; ')} &rarr;`
                : 'Direct connection';
            html += `<details class="connection-path" data-path-index="${pathIndex}">`;
            html += `<summary class="path-summary">${pathLabel}</summary>`;
            html += `<div class="path-body">`;

            for (let i = 0; i < path.length - 1; i++) {
                const fromSlug = path[i];
                const toSlug = path[i + 1];
                const fromName = pNames.get(fromSlug) || fromSlug;
                const toName = pNames.get(toSlug) || toSlug;

                const edge = edges.find(e =>
                    (e.from === fromSlug && e.to === toSlug) ||
                    (e.from === toSlug && e.to === fromSlug)
                );

                if (edge) {
                    html += `<div class="connection-step">`;
                    html += `<div class="connection-link">${escapeHtml(fromName)} &rarr; ${escapeHtml(toName)}</div>`;
                    for (const show of edge.shows) {
                        const fromRole = edge.from === fromSlug ? show.fromRole : show.toRole;
                        const toRole = edge.from === fromSlug ? show.toRole : show.fromRole;
                        html += `<details class="show-detail">`;
                        html += `<summary class="show-name">${escapeHtml(show.showName)}</summary>`;
                        html += `<div class="show-meta">`;
                        html += `<div class="show-link"><a href="${API_BASE}/shows/${show.showSlug}" target="_blank">Open show page</a></div>`;
                        html += `<div class="roles">${escapeHtml(fromName)}: ${escapeHtml(fromRole)} | ${escapeHtml(toName)}: ${escapeHtml(toRole)}</div>`;
                        html += `</div>`;
                        html += `</details>`;
                    }
                    html += `</div>`;
                }
            }

            html += `</div>`;
            html += `</details>`;
        }

        html += `</div>`;
        html += `</div>`;
    }

    html += renderShowList(result);

    detailsContent.innerHTML = html;

    detailsContent.querySelectorAll('.connection-path').forEach((pathEl) => {
        const pathIndex = Number(pathEl.dataset.pathIndex);
        const summaryEl = pathEl.querySelector('.path-summary');
        summaryEl.addEventListener('click', () => highlightPath(pathIndex));
        summaryEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                highlightPath(pathIndex);
            }
        });
    });
}

function renderShowList(result) {
    const { paths, peopleNames: pNames } = result;
    const showsBySlug = new Map();

    for (const { path, edges } of paths) {
        for (let i = 0; i < edges.length; i++) {
            const edge = edges[i];
            const fromName = pNames.get(path[i]) || path[i];
            const toName = pNames.get(path[i + 1]) || path[i + 1];

            for (const show of edge.shows) {
                if (!showsBySlug.has(show.showSlug)) {
                    showsBySlug.set(show.showSlug, {
                        showSlug: show.showSlug,
                        showName: show.showName,
                        links: [],
                    });
                }

                showsBySlug.get(show.showSlug).links.push({
                    fromName,
                    toName,
                    fromRole: show.fromRole,
                    toRole: show.toRole,
                });
            }
        }
    }

    const shows = [...showsBySlug.values()].sort((a, b) => {
        if (b.links.length !== a.links.length) return b.links.length - a.links.length;
        return a.showName.localeCompare(b.showName);
    });

    let html = '<div class="show-list-section">';
    html += `<div class="degree-heading">Shows &mdash; ${shows.length} show${shows.length !== 1 ? 's' : ''}</div>`;
    html += '<div class="show-list-grid">';

    for (const show of shows) {
        html += '<details class="show-list-item">';
        html += `<summary class="show-list-summary">${escapeHtml(show.showName)} <span class="show-count">${show.links.length} link${show.links.length !== 1 ? 's' : ''}</span></summary>`;
        html += '<div class="show-list-body">';
        html += `<div class="show-link"><a href="${API_BASE}/shows/${show.showSlug}" target="_blank">Open show page</a></div>`;

        for (const link of show.links) {
            html += '<div class="show-list-link">';
            html += `<div class="connection-link">${escapeHtml(link.fromName)} &rarr; ${escapeHtml(link.toName)}</div>`;
            html += `<div class="roles">${escapeHtml(link.fromName)}: ${escapeHtml(link.fromRole)} | ${escapeHtml(link.toName)}: ${escapeHtml(link.toRole)}</div>`;
            html += '</div>';
        }

        html += '</div>';
        html += '</details>';
    }

    html += '</div>';
    html += '</div>';

    return html;
}

function renderResultSummary(result, interim = false) {
    const pathCount = result.paths.length;
    const degrees = result.paths.map(p => p.path.length - 1);
    const minDeg = Math.min(...degrees);
    const maxDeg = Math.max(...degrees);
    const modeLabel = isShortestOnlyMode() ? 'best / shortest search' : 'all-path search';

    if (interim) {
        resultSummaryEl.textContent = `Found ${pathCount} candidate path${pathCount !== 1 ? 's' : ''} so far in ${modeLabel}.`;
        return;
    }

    if (minDeg === maxDeg) {
        resultSummaryEl.textContent = `${modeLabel} finished. ${pathCount} path${pathCount !== 1 ? 's' : ''} at ${minDeg} degree${minDeg !== 1 ? 's' : ''}.`;
    } else {
        resultSummaryEl.textContent = `${modeLabel} finished. ${pathCount} path${pathCount !== 1 ? 's' : ''} across ${minDeg}-${maxDeg} degrees.`;
    }
}

function renderInterimResults(result) {
    resultsEl.classList.remove('hidden');
    degreesBadge.textContent = 'Path found';
    graphPanel.classList.remove('hidden');
    renderResultSummary(result, true);
    renderGraph(result);
    renderDetails(result);
}

function getNoConnectionHtml(maxDepth) {
    return `<div class="no-connection"><strong>No connection found within ${maxDepth} degree${maxDepth > 1 ? 's' : ''}.</strong><br>Try Deeper/Exhaustive depth, switch to All paths, or widen role types.</div>`;
}

// ── Main search handler ──

findBtn.addEventListener('click', async () => {
    const searchToken = ++currentSearchToken;
    const slug1 = person1Slug.value;
    const slug2 = person2Slug.value;
    if (!slug1 || !slug2) return;

    if (slug1 === slug2) {
        showError('Please select two different people.');
        return;
    }

    resultsEl.classList.add('hidden');
    hideStatus();
    findBtn.disabled = true;
    findBtn.textContent = 'Searching...';
    resetProgress();
    resultSummaryEl.textContent = '';
    currentHighlightedPath = null;
    graphState = null;

    try {
        const maxDepth = getSelectedMaxDepth();
        const result = await findAllConnections(slug1, slug2, maxDepth, {
            onPathFound(interimResult) {
                if (searchToken !== currentSearchToken) return;
                renderInterimResults(interimResult);
                showStatus('Path found. Finishing current search layer...');
            },
        });

        hideProgress();
        hideStatus();

        if (!result) {
            resultsEl.classList.remove('hidden');
            degreesBadge.innerHTML = 'No connection found';
            graphPanel.classList.add('hidden');
            resultSummaryEl.textContent = 'Try broader role filters or deeper search.';
            detailsContent.innerHTML = getNoConnectionHtml(maxDepth);
            return;
        }

        const degrees = result.paths.map(p => p.path.length - 1);
        const minDeg = Math.min(...degrees);
        const maxDeg = Math.max(...degrees);
        const pathCount = result.paths.length;
        let badgeHtml;
        if (minDeg === maxDeg) {
            badgeHtml = `<span class="number">${pathCount}</span> path${pathCount !== 1 ? 's' : ''} at <span class="number">${minDeg}</span> degree${minDeg !== 1 ? 's' : ''}`;
        } else {
            badgeHtml = `<span class="number">${pathCount}</span> path${pathCount !== 1 ? 's' : ''} across <span class="number">${minDeg}&ndash;${maxDeg}</span> degrees`;
        }
        degreesBadge.innerHTML = badgeHtml;
        renderResultSummary(result);
        graphPanel.classList.remove('hidden');
        resultsEl.classList.remove('hidden');

        renderGraph(result);
        renderDetails(result);

        // Update URL for sharing
        const url = new URL(window.location);
        url.searchParams.set('p1', slug1);
        url.searchParams.set('p2', slug2);
        url.searchParams.set('d', maxDepth);
        if (isShortestOnlyMode()) {
            url.searchParams.set('sp', '1');
        } else {
            url.searchParams.delete('sp');
        }
        history.replaceState(null, '', url);

    } catch (err) {
        hideProgress();
        showError(err.message || 'Something went wrong');
    } finally {
        findBtn.disabled = false;
        findBtn.textContent = 'Find Connection';
        updateFindButton();
    }
});

// ── Export ──

exportBtn.addEventListener('click', () => {
    if (!network) return;
    const canvas = graphContainer.querySelector('canvas');
    if (!canvas) return;

    const link = document.createElement('a');
    link.download = 'camdram-connected.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
});

// ── Share ──

shareBtn.addEventListener('click', () => {
    const url = new URL(window.location);
    url.searchParams.set('p1', person1Slug.value);
    url.searchParams.set('p2', person2Slug.value);
    url.searchParams.set('d', getSelectedMaxDepth());
    if (isShortestOnlyMode()) {
        url.searchParams.set('sp', '1');
    } else {
        url.searchParams.delete('sp');
    }
    navigator.clipboard.writeText(url.toString()).then(() => {
        shareBtn.textContent = 'Copied!';
        setTimeout(() => { shareBtn.textContent = 'Share Link'; }, 1500);
    }).catch(() => {
        window.prompt('Copy this link:', url.toString());
    });
});

resetViewBtn.addEventListener('click', resetGraphView);

// ── URL params (shareable links) ──

async function loadFromURL() {
    const params = new URLSearchParams(window.location.search);
    const p1 = params.get('p1');
    const p2 = params.get('p2');
    const depth = params.get('d');
    const sp = params.get('sp');

    if (!p1 || !p2) return;

    if (depth) {
        const depthInput = document.querySelector(`input[name="max-depth"][value="${depth}"]`);
        if (depthInput) depthInput.checked = true;
    }
    const searchModeInput = document.querySelector(`input[name="search-mode"][value="${sp === '1' ? 'shortest' : 'all'}"]`);
    if (searchModeInput) searchModeInput.checked = true;

    showStatus('Loading people from URL...');

    try {
        const [data1, data2] = await Promise.all([
            pool.fetch(`${API_BASE}/people/${encodeURIComponent(p1)}.json`),
            pool.fetch(`${API_BASE}/people/${encodeURIComponent(p2)}.json`),
        ]);

        if (data1) {
            person1Input.value = data1.name;
            person1Slug.value = data1.slug;
            setSelectedPersonUI(person1Input, person1Slug, person1Selected, data1);
            prefetchPersonRoles(data1.slug);
        }
        if (data2) {
            person2Input.value = data2.name;
            person2Slug.value = data2.slug;
            setSelectedPersonUI(person2Input, person2Slug, person2Selected, data2);
            prefetchPersonRoles(data2.slug);
        }

        hideStatus();
        updateFindButton();

        if (data1 && data2) {
            findBtn.click();
        }
    } catch {
        hideStatus();
    }
}

function swapPeople() {
    const left = {
        value: person1Input.value,
        slug: person1Slug.value,
    };

    person1Input.value = person2Input.value;
    person1Slug.value = person2Slug.value;
    person2Input.value = left.value;
    person2Slug.value = left.slug;

    syncSelectedBadge(person1Input, person1Slug, person1Selected);
    syncSelectedBadge(person2Input, person2Slug, person2Selected);
    updateFindButton();
}

function syncSelectedBadge(input, slugInput, selectedEl) {
    if (slugInput.value) {
        setSelectedPersonUI(input, slugInput, selectedEl, {
            name: input.value,
            slug: slugInput.value,
        });
    } else {
        setSelectedPersonUI(input, slugInput, selectedEl, null);
    }
}

// ── Utility ──

function escapeHtml(str) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = str;

    const div = document.createElement('div');
    div.textContent = textarea.value;
    return div.innerHTML;
}

// ── Init ──

progressToggle.addEventListener('click', () => {
    const expanded = progressToggle.getAttribute('aria-expanded') === 'true';
    progressToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    progressToggle.textContent = expanded ? 'Show technical progress' : 'Hide technical progress';
    progressLog.classList.toggle('hidden', expanded);
});

swapBtn.addEventListener('click', swapPeople);

setupAutocomplete(person1Input, person1List, person1Slug);
setupAutocomplete(person2Input, person2List, person2Slug);
loadFromURL();
