import { expandPerson, estimateFrontierCost } from './api.js';
import { appState } from './state.js';

function updateSearchProgress(options, depthLabel, current, total, showCount, pathCount, connectionCount, peopleCount) {
    if (options.onProgress) {
        options.onProgress(depthLabel, current, total, showCount, pathCount, connectionCount, peopleCount);
    }
}

function logPathFound(found, options) {
    const pathNames = found.path.map((slug) => appState.peopleNames.get(slug) || slug).join(' → ');
    if (options.onLog) options.onLog(`Found path: ${pathNames}`, 'found');
    if (options.onPathFound) {
        options.onPathFound({ paths: found.paths, peopleNames: appState.peopleNames });
    }
}

export function getActiveRoleTypes() {
    return Array.from(document.querySelectorAll('.filters fieldset input[type="checkbox"]:checked'))
        .map((checkbox) => checkbox.value);
}

export function isShortestOnlyMode() {
    return document.querySelector('input[name="search-mode"]:checked')?.value !== 'all';
}

export function getSelectedDepths() {
    const depths = Array.from(document.querySelectorAll('input[name="degree-depth"]:checked'))
        .map((input) => parseInt(input.value, 10))
        .filter(Number.isInteger)
        .sort((a, b) => a - b);

    return depths.length > 0 ? depths : [1, 2];
}

export function isSelectedDegree(degree, selectedDepths) {
    return selectedDepths.includes(degree);
}

function getOrdinalSuffix(value) {
    if (value % 100 >= 11 && value % 100 <= 13) return 'th';
    if (value % 10 === 1) return 'st';
    if (value % 10 === 2) return 'nd';
    if (value % 10 === 3) return 'rd';
    return 'th';
}

export function formatSelectedDegrees(selectedDepths) {
    const labels = selectedDepths.map((depth) => `${depth}${getOrdinalSuffix(depth)}`);
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

export function parseDepthParam(depthParam) {
    if (!depthParam) return [];

    if (!depthParam.includes(',')) {
        const legacyMaxDepth = parseInt(depthParam, 10);
        if (Number.isInteger(legacyMaxDepth) && legacyMaxDepth >= 1 && legacyMaxDepth <= 4) {
            return Array.from({ length: legacyMaxDepth }, (_, index) => index + 1);
        }
    }

    return depthParam.split(',')
        .map((value) => parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 4)
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort((a, b) => a - b);
}

function buildEdge(fromSlug, toSlug, showConnsMap) {
    const shows = Array.from(showConnsMap.values()).map((show) => ({
        showSlug: show.showSlug,
        showName: show.showName,
        fromRole: Array.from(show.fromRoles).join(', '),
        toRole: Array.from(show.toRoles).join(', '),
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

async function findAllUnidirectional(slug1, slug2, selectedDepths, options = {}) {
    const roleTypes = getActiveRoleTypes();
    const maxDepth = Math.max(...selectedDepths);
    const allPaths = [];
    const seenPathKeys = new Set();
    const discoveredAt = new Map([[slug1, 0]]);
    let currentLevel = new Map([[slug1, [{ path: [slug1], edges: [], seenSlugs: new Set([slug1]) }]]]);
    let showsFetched = 0;
    let connectionsChecked = 0;
    let peopleExploredTotal = 0;

    for (let depth = 0; depth < maxDepth; depth++) {
        const nextLevel = new Map();
        const nextLevelPathKeys = new Set();
        const slugsToExpand = Array.from(currentLevel.keys());
        let peopleExplored = 0;
        const totalAtDepth = slugsToExpand.length;
        const depthLabel = `Depth ${depth + 1}/${maxDepth}`;
        updateSearchProgress(options, depthLabel, 0, totalAtDepth, showsFetched, allPaths.length, connectionsChecked, peopleExploredTotal);

        const batchSize = 3;
        for (let i = 0; i < slugsToExpand.length; i += batchSize) {
            const batch = slugsToExpand.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async (personSlug) => {
                    const connectionsByCoworker = await expandPerson(personSlug, roleTypes, {
                        onLog: options.onLog,
                        onShowFetched() {
                            showsFetched++;
                            updateSearchProgress(options, depthLabel, peopleExplored, totalAtDepth, showsFetched, allPaths.length, connectionsChecked, peopleExploredTotal);
                        },
                    });
                    return { personSlug, connectionsByCoworker };
                })
            );

            for (const { personSlug, connectionsByCoworker } of batchResults) {
                const partialPaths = currentLevel.get(personSlug) || [];

                for (const [coSlug, showConnsMap] of connectionsByCoworker) {
                    connectionsChecked++;
                    const newEdge = buildEdge(personSlug, coSlug, showConnsMap);

                    for (const partial of partialPaths) {
                        if (partial.seenSlugs.has(coSlug)) continue;

                        const newEdges = [...partial.edges, newEdge];
                        if (pathRepeatsShow(newEdges)) continue;

                        const found = {
                            path: [...partial.path, coSlug],
                            edges: newEdges,
                            seenSlugs: new Set([...partial.seenSlugs, coSlug]),
                        };

                        if (coSlug === slug2) {
                            const degree = found.path.length - 1;
                            const pathKey = found.path.join('>');
                            if (isSelectedDegree(degree, selectedDepths) && !seenPathKeys.has(pathKey)) {
                                seenPathKeys.add(pathKey);
                                allPaths.push({ path: found.path, edges: found.edges });
                                logPathFound({ path: found.path, paths: [...allPaths] }, options);
                            }
                            continue;
                        }

                        const nextDepth = depth + 1;
                        const pathKey = found.path.join('>');
                        if ((!discoveredAt.has(coSlug) || discoveredAt.get(coSlug) === nextDepth) && !nextLevelPathKeys.has(pathKey)) {
                            discoveredAt.set(coSlug, nextDepth);
                            nextLevelPathKeys.add(pathKey);
                            if (!nextLevel.has(coSlug)) nextLevel.set(coSlug, []);
                            nextLevel.get(coSlug).push(found);
                        }
                    }
                }

                peopleExplored++;
                peopleExploredTotal++;
                updateSearchProgress(options, depthLabel, peopleExplored, totalAtDepth, showsFetched, allPaths.length, connectionsChecked, peopleExploredTotal);
            }
        }

        currentLevel = nextLevel;
        if (currentLevel.size === 0) break;
    }

    if (allPaths.length === 0) return null;
    return { paths: allPaths, peopleNames: appState.peopleNames };
}

function combinePaths(forward, backward) {
    const reversedBackPath = backward.path.slice(0, -1).reverse();
    const combinedPath = [...forward.path, ...reversedBackPath];
    const reversedBackEdges = backward.edges.slice().reverse().map((edge) => ({
        from: edge.to,
        to: edge.from,
        shows: edge.shows.map((show) => ({
            showSlug: show.showSlug,
            showName: show.showName,
            fromRole: show.toRole,
            toRole: show.fromRole,
        })),
    }));

    return {
        path: combinedPath,
        edges: [...forward.edges, ...reversedBackEdges],
    };
}

async function findShortestBidirectional(slug1, slug2, selectedDepths, options = {}) {
    const roleTypes = getActiveRoleTypes();
    const maxDepth = Math.max(...selectedDepths);
    let forwardFrontier = [slug1];
    let backwardFrontier = [slug2];
    const forwardVisited = new Map([[slug1, -1]]);
    const backwardVisited = new Map([[slug2, -1]]);
    const forwardPaths = new Map([[slug1, [{ path: [slug1], edges: [] }]]]);
    const backwardPaths = new Map([[slug2, [{ path: [slug2], edges: [] }]]]);
    let showsFetched = 0;
    let connectionsChecked = 0;
    let peopleExploredTotal = 0;
    const foundPaths = [];
    const seenPathKeys = new Set();

    for (let depth = 0; depth < maxDepth; depth++) {
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
        updateSearchProgress(options, depthLabel, 0, totalAtDepth, showsFetched, foundPaths.length, connectionsChecked, peopleExploredTotal);

        const nextFrontier = [];
        const batchSize = 3;
        for (let i = 0; i < frontier.length; i += batchSize) {
            const batch = frontier.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async (personSlug) => {
                    const connectionsByCoworker = await expandPerson(personSlug, roleTypes, {
                        onLog: options.onLog,
                        onShowFetched() {
                            showsFetched++;
                            updateSearchProgress(options, depthLabel, peopleExplored, totalAtDepth, showsFetched, foundPaths.length, connectionsChecked, peopleExploredTotal);
                        },
                    });
                    return { personSlug, connectionsByCoworker };
                })
            );

            for (const { personSlug, connectionsByCoworker } of batchResults) {
                const currentPathsForPerson = paths.get(personSlug) || [];

                for (const [coSlug, showConnsMap] of connectionsByCoworker) {
                    connectionsChecked++;
                    const edge = buildEdge(personSlug, coSlug, showConnsMap);
                    const newPartials = currentPathsForPerson.map((path) => ({
                        path: [...path.path, coSlug],
                        edges: [...path.edges, edge],
                    }));

                    if (oppositePaths.has(coSlug)) {
                        for (const forwardPartial of newPartials) {
                            for (const backwardPartial of oppositePaths.get(coSlug)) {
                                const combined = expandForward
                                    ? combinePaths(forwardPartial, backwardPartial)
                                    : combinePaths(backwardPartial, forwardPartial);
                                const degree = combined.path.length - 1;
                                const pathKey = combined.path.join('>');
                                if (!isSelectedDegree(degree, selectedDepths) || seenPathKeys.has(pathKey)) continue;
                                seenPathKeys.add(pathKey);
                                foundPaths.push(combined);
                                logPathFound({ path: combined.path, paths: [...foundPaths] }, options);
                            }
                        }
                    }

                    const discoveryDepth = visited.get(coSlug);
                    if (discoveryDepth === undefined || discoveryDepth === depth) {
                        if (discoveryDepth === undefined) {
                            visited.set(coSlug, depth);
                            nextFrontier.push(coSlug);
                            paths.set(coSlug, []);
                        }
                        paths.get(coSlug).push(...newPartials);
                    }
                }

                peopleExplored++;
                peopleExploredTotal++;
                updateSearchProgress(options, depthLabel, peopleExplored, totalAtDepth, showsFetched, foundPaths.length, connectionsChecked, peopleExploredTotal);
            }
        }

        if (foundPaths.length > 0) break;
        if (expandForward) {
            forwardFrontier = nextFrontier;
        } else {
            backwardFrontier = nextFrontier;
        }

        if (forwardFrontier.length === 0 && backwardFrontier.length === 0) break;
    }

    if (foundPaths.length === 0) return null;
    return { paths: foundPaths, peopleNames: appState.peopleNames };
}

export async function findAllConnections(slug1, slug2, selectedDepths, options = {}) {
    const roleTypes = getActiveRoleTypes();
    if (roleTypes.length === 0) {
        throw new Error('Select at least one role type');
    }
    if (selectedDepths.length === 0) {
        throw new Error('Select at least one degree');
    }

    return isShortestOnlyMode()
        ? findShortestBidirectional(slug1, slug2, selectedDepths, options)
        : findAllUnidirectional(slug1, slug2, selectedDepths, options);
}
