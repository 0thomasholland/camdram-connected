// Camdram Connected - Connection finder for Cambridge theatre people

// Use local CORS proxy (/api/...) when available (Cloudflare Pages Functions),
// fall back to direct API access for environments where CORS isn't an issue.
const API_BASE = '/api';

// ── Fetch pool with concurrency, rate limiting, and retry ──

const CONCURRENCY = 4;
const MIN_GAP_MS = 50;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 200;

class FetchPool {
    constructor() {
        this._inFlight = 0;
        this._queue = [];
        this._lastStartTime = 0;
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
            if (elapsed < MIN_GAP_MS) {
                await new Promise(r => setTimeout(r, MIN_GAP_MS - elapsed));
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
                const delay = BASE_RETRY_MS * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            if (!resp.ok) {
                if (resp.status === 404) return null;
                throw new Error(`API error ${resp.status} for ${url}`);
            }
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
const peopleNames = new Map();      // slug -> display name
let cacheHits = 0;

// ── DOM refs ──

const person1Input = document.getElementById('person1');
const person2Input = document.getElementById('person2');
const person1Slug = document.getElementById('person1-slug');
const person2Slug = document.getElementById('person2-slug');
const person1List = document.getElementById('person1-list');
const person2List = document.getElementById('person2-list');
const findBtn = document.getElementById('find-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const degreesBadge = document.getElementById('degrees-badge');
const graphContainer = document.getElementById('graph-container');
const detailsContent = document.getElementById('details-content');
const exportBtn = document.getElementById('export-btn');
const shareBtn = document.getElementById('share-btn');
const maxDepthSelect = document.getElementById('max-depth');
const shortestOnlyCheckbox = document.getElementById('shortest-only');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressLog = document.getElementById('progress-log');
const progressDepthEl = document.getElementById('progress-depth');
const progressShowsEl = document.getElementById('progress-shows');
const progressCacheEl = document.getElementById('progress-cache');
const progressPathsEl = document.getElementById('progress-paths');

// ── API layer ──

async function searchPeople(query) {
    if (query.length < 2) return [];
    const data = await pool.fetch(`${API_BASE}/people.json?q=${encodeURIComponent(query)}`);
    return data || [];
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

function setupAutocomplete(input, list, slugInput) {
    let debounceTimer = null;
    let activeIndex = -1;

    input.addEventListener('input', () => {
        // Clear selection when user modifies text
        slugInput.value = '';
        input.classList.remove('selected');
        updateFindButton();

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            const query = input.value.trim();
            if (query.length < 2) {
                list.classList.remove('visible');
                return;
            }
            try {
                const results = await searchPeople(query);
                renderAutocomplete(list, results, (person) => {
                    input.value = person.name;
                    slugInput.value = person.slug;
                    input.classList.add('selected');
                    list.classList.remove('visible');
                    updateFindButton();
                });
                activeIndex = -1;
            } catch {
                list.classList.remove('visible');
            }
        }, 300);
    });

    input.addEventListener('keydown', (e) => {
        const items = list.querySelectorAll('.autocomplete-item');
        if (!items.length) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, items.length - 1);
            updateActiveItem(items, activeIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            updateActiveItem(items, activeIndex);
        } else if (e.key === 'Enter' && activeIndex >= 0) {
            e.preventDefault();
            items[activeIndex].click();
        } else if (e.key === 'Escape') {
            list.classList.remove('visible');
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !list.contains(e.target)) {
            list.classList.remove('visible');
        }
    });
}

function renderAutocomplete(list, results, onSelect) {
    list.innerHTML = '';
    if (results.length === 0) {
        list.classList.remove('visible');
        return;
    }
    for (const person of results) {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.innerHTML = `${escapeHtml(person.name)} <span class="slug">${escapeHtml(person.slug)}</span>`;
        item.addEventListener('click', () => onSelect(person));
        list.appendChild(item);
    }
    list.classList.add('visible');
}

function updateActiveItem(items, index) {
    items.forEach((item, i) => item.classList.toggle('active', i === index));
}

function updateFindButton() {
    findBtn.disabled = !(person1Slug.value && person2Slug.value);
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
    const pct = total > 0 ? (current / total) * 100 : 0;
    progressBar.style.width = `${pct}%`;
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
    return Array.from(document.querySelectorAll('.filters fieldset input:checked'))
        .map(cb => cb.value);
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
    const showEntries = Array.from(showMap.entries());
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

    return connectionsByCoworker;
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

// ── Connection finder — all paths (unidirectional BFS) ──

async function findAllUnidirectional(slug1, slug2, maxDepth) {
    const roleTypes = getActiveRoleTypes();

    const allPaths = [];
    const visited = new Set([slug1]);
    let queue = [{ personSlug: slug1, path: [slug1], edges: [] }];

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

                    if (coSlug === slug2) {
                        allPaths.push({
                            path: [...entry.path, coSlug],
                            edges: newEdges,
                        });
                        const pathNames = [...entry.path, coSlug].map(s => peopleNames.get(s) || s).join(' → ');
                        logFetch(`Found path: ${pathNames}`, 'found');
                    } else if (!visited.has(coSlug)) {
                        visited.add(coSlug);
                        nextQueue.push({
                            personSlug: coSlug,
                            path: [...entry.path, coSlug],
                            edges: newEdges,
                        });
                    }
                }

                peopleExplored++;
                updateProgress(depthLabel, peopleExplored, totalAtDepth, showsFetched, allPaths.length);
            }
        }

        // Early termination: if we found paths at this depth, stop
        if (allPaths.length > 0) break;

        queue = nextQueue;
        if (queue.length === 0) break;
    }

    if (allPaths.length === 0) return null;
    return { paths: allPaths, peopleNames };
}

// ── Connection finder — shortest path (bidirectional BFS) ──

async function findShortestBidirectional(slug1, slug2, maxDepth) {
    const roleTypes = getActiveRoleTypes();

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
    let totalDepth = 0;

    for (let depth = 0; depth < maxDepth; depth++) {
        totalDepth = depth + 1;

        // Choose smaller frontier to expand
        const expandForward = forwardFrontier.length <= backwardFrontier.length;
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
                                foundPaths.push(combined);
                                const pathNames = combined.path.map(s => peopleNames.get(s) || s).join(' → ');
                                logFetch(`Found path: ${pathNames}`, 'found');
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

async function findAllConnections(slug1, slug2, maxDepth) {
    const roleTypes = getActiveRoleTypes();
    if (roleTypes.length === 0) {
        throw new Error('Select at least one role type');
    }

    if (shortestOnlyCheckbox.checked) {
        return findShortestBidirectional(slug1, slug2, maxDepth);
    } else {
        return findAllUnidirectional(slug1, slug2, maxDepth);
    }
}

// ── Graph visualization ──

function renderGraph(result) {
    const { paths, peopleNames: pNames } = result;

    const startSlug = paths[0].path[0];
    const endSlug = paths[0].path[paths[0].path.length - 1];

    const nodeData = [];
    const edgeData = [];
    const nodeIds = new Set();
    const edgeKeys = new Set();

    for (const { path, edges } of paths) {
        // Add person nodes
        for (const slug of path) {
            const nodeId = `person:${slug}`;
            if (nodeIds.has(nodeId)) continue;
            nodeIds.add(nodeId);

            const name = pNames.get(slug) || slug;
            const isEndpoint = slug === startSlug || slug === endSlug;
            nodeData.push({
                id: nodeId,
                label: name,
                shape: 'dot',
                size: isEndpoint ? 25 : 18,
                color: {
                    background: isEndpoint ? '#6c63ff' : '#3b3d54',
                    border: isEndpoint ? '#8b83ff' : '#555770',
                    highlight: { background: '#8b83ff', border: '#a9a3ff' },
                },
                font: {
                    color: '#e4e4e7',
                    size: isEndpoint ? 16 : 13,
                    face: '-apple-system, BlinkMacSystemFont, sans-serif',
                },
            });
        }

        // Add show nodes and edges (deduplicated across paths)
        for (const edge of edges) {
            for (const show of edge.shows) {
                const showId = `show:${show.showSlug}`;
                if (!nodeIds.has(showId)) {
                    nodeIds.add(showId);
                    nodeData.push({
                        id: showId,
                        label: show.showName,
                        shape: 'box',
                        size: 12,
                        color: {
                            background: '#1e3a2f',
                            border: '#22c55e',
                            highlight: { background: '#2a4d3c', border: '#4ade80' },
                        },
                        font: { color: '#86efac', size: 11, face: '-apple-system, BlinkMacSystemFont, sans-serif' },
                        margin: 8,
                    });
                }

                const key1 = `person:${edge.from}->show:${show.showSlug}`;
                if (!edgeKeys.has(key1)) {
                    edgeKeys.add(key1);
                    edgeData.push({
                        from: `person:${edge.from}`,
                        to: showId,
                        color: { color: '#3b3d54', highlight: '#6c63ff' },
                        width: 1.5,
                        title: `${pNames.get(edge.from)}: ${show.fromRole}`,
                    });
                }

                const key2 = `show:${show.showSlug}->person:${edge.to}`;
                if (!edgeKeys.has(key2)) {
                    edgeKeys.add(key2);
                    edgeData.push({
                        from: showId,
                        to: `person:${edge.to}`,
                        color: { color: '#3b3d54', highlight: '#6c63ff' },
                        width: 1.5,
                        title: `${pNames.get(edge.to)}: ${show.toRole}`,
                    });
                }
            }
        }
    }

    const data = {
        nodes: new vis.DataSet(nodeData),
        edges: new vis.DataSet(edgeData),
    };

    const options = {
        physics: {
            solver: 'forceAtlas2Based',
            forceAtlas2Based: {
                gravitationalConstant: -40,
                centralGravity: 0.005,
                springLength: 120,
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
    };

    if (network) network.destroy();
    network = new vis.Network(graphContainer, data, options);
}

// ── Details panel ──

function renderDetails(result) {
    const { paths, peopleNames: pNames } = result;

    // Group paths by degree
    const byDegree = new Map();
    for (const { path, edges } of paths) {
        const degree = path.length - 1;
        if (!byDegree.has(degree)) byDegree.set(degree, []);
        byDegree.get(degree).push({ path, edges });
    }

    let html = '';
    const sortedDegrees = [...byDegree.keys()].sort((a, b) => a - b);

    for (const degree of sortedDegrees) {
        const degreePaths = byDegree.get(degree);
        html += `<div class="degree-group">`;
        html += `<div class="degree-heading">${degree} degree${degree !== 1 ? 's' : ''} of separation &mdash; ${degreePaths.length} path${degreePaths.length !== 1 ? 's' : ''}</div>`;

        for (const { path, edges } of degreePaths) {
            html += `<div class="connection-path">`;
            html += `<div class="path-summary">${path.map(s => escapeHtml(pNames.get(s) || s)).join(' &rarr; ')}</div>`;

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
                    for (const show of edge.shows) {
                        const fromRole = edge.from === fromSlug ? show.fromRole : show.toRole;
                        const toRole = edge.from === fromSlug ? show.toRole : show.fromRole;
                        html += `<div class="show-name"><a href="${API_BASE}/shows/${show.showSlug}" target="_blank">${escapeHtml(show.showName)}</a></div>`;
                        html += `<div class="roles">${escapeHtml(fromName)}: ${escapeHtml(fromRole)} | ${escapeHtml(toName)}: ${escapeHtml(toRole)}</div>`;
                    }
                    html += `</div>`;
                }
            }

            html += `</div>`;
        }

        html += `</div>`;
    }

    detailsContent.innerHTML = html;
}

// ── Main search handler ──

findBtn.addEventListener('click', async () => {
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

    try {
        const maxDepth = parseInt(maxDepthSelect.value, 10);
        const result = await findAllConnections(slug1, slug2, maxDepth);

        hideProgress();

        if (!result) {
            resultsEl.classList.remove('hidden');
            degreesBadge.innerHTML = 'No connection found';
            graphContainer.style.display = 'none';
            detailsContent.innerHTML = `<div class="no-connection">No connection found within ${maxDepth} degree${maxDepth > 1 ? 's' : ''} of separation. Try increasing the max depth.</div>`;
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
        graphContainer.style.display = '';
        resultsEl.classList.remove('hidden');

        renderGraph(result);
        renderDetails(result);

        // Update URL for sharing
        const url = new URL(window.location);
        url.searchParams.set('p1', slug1);
        url.searchParams.set('p2', slug2);
        url.searchParams.set('d', maxDepth);
        if (shortestOnlyCheckbox.checked) {
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
    url.searchParams.set('d', maxDepthSelect.value);
    if (shortestOnlyCheckbox.checked) {
        url.searchParams.set('sp', '1');
    } else {
        url.searchParams.delete('sp');
    }
    navigator.clipboard.writeText(url.toString()).then(() => {
        shareBtn.textContent = 'Copied!';
        setTimeout(() => { shareBtn.textContent = 'Share Link'; }, 1500);
    });
});

// ── URL params (shareable links) ──

async function loadFromURL() {
    const params = new URLSearchParams(window.location.search);
    const p1 = params.get('p1');
    const p2 = params.get('p2');
    const depth = params.get('d');
    const sp = params.get('sp');

    if (!p1 || !p2) return;

    if (depth) maxDepthSelect.value = depth;
    if (sp === '1') shortestOnlyCheckbox.checked = true;

    showStatus('Loading people from URL...');

    try {
        const [data1, data2] = await Promise.all([
            pool.fetch(`${API_BASE}/people/${encodeURIComponent(p1)}.json`),
            pool.fetch(`${API_BASE}/people/${encodeURIComponent(p2)}.json`),
        ]);

        if (data1) {
            person1Input.value = data1.name;
            person1Slug.value = data1.slug;
            person1Input.classList.add('selected');
        }
        if (data2) {
            person2Input.value = data2.name;
            person2Slug.value = data2.slug;
            person2Input.classList.add('selected');
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

// ── Utility ──

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Init ──

setupAutocomplete(person1Input, person1List, person1Slug);
setupAutocomplete(person2Input, person2List, person2Slug);
loadFromURL();
