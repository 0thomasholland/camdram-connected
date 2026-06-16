import { CAMDRAM_SITE_BASE, GRAPH_PALETTE } from './constants.js';
import { formatSelectedDegrees, isShortestOnlyMode } from './search.js';
import { appState } from './state.js';
import { escapeHtml } from './ui.js';

function formatEdgeTitle(edge) {
    if (edge.shows.length <= 2) {
        return edge.shows.map((show) => show.showName).join(' and ');
    }
    return `${edge.shows[0].showName} and other shows`;
}

function addPathMembership(pathMap, key, pathIndex) {
    if (!pathMap.has(key)) pathMap.set(key, new Set());
    pathMap.get(key).add(pathIndex);
}

function getRange(values) {
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    return { min, max };
}

function scaleBetween(value, minOutput, maxOutput, { min, max }) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
        return (minOutput + maxOutput) / 2;
    }
    const ratio = (value - min) / (max - min);
    return minOutput + (maxOutput - minOutput) * ratio;
}

export function renderGraph(result, { preserveView = false } = {}) {
    const { graphContainer } = appState.dom;
    const { paths, peopleNames } = result;
    const minEdgeWidth = 2;
    const maxEdgeWidth = 10;
    const startSlug = paths[0].path[0];
    const endSlug = paths[0].path[paths[0].path.length - 1];
    const uniqueNodeCount = new Set(paths.flatMap(({ path }) => path)).size;
    const endpointOffset = Math.min(400, 220 + Math.max(0, uniqueNodeCount - 2) * 12);
    const nodeData = [];
    const edgeData = [];
    const nodeIds = new Set();
    const edgeKeys = new Set();
    const nodePathMap = new Map();
    const edgePathMap = new Map();
    const nodeBaseStyles = new Map();
    const edgeBaseStyles = new Map();
    const edgeShowCounts = new Map();

    appState.currentHighlightedPath = null;
    appState.lastClickedGraphNodeId = null;
    appState.graphDefaultView = null;

    for (const [pathIndex, { path, edges }] of paths.entries()) {
        for (const slug of path) {
            const nodeId = `person:${slug}`;
            addPathMembership(nodePathMap, nodeId, pathIndex);
            if (nodeIds.has(nodeId)) continue;
            nodeIds.add(nodeId);

            const name = peopleNames.get(slug) || slug;
            const isEndpoint = slug === startSlug || slug === endSlug;
            const isStart = slug === startSlug;
            const isEnd = slug === endSlug;
            const nodeColor = isStart
                ? GRAPH_PALETTE.startNode
                : (isEnd ? GRAPH_PALETTE.endNode : (path.length <= 3 ? GRAPH_PALETTE.midNode : GRAPH_PALETTE.quietNode));

            nodeData.push({
                id: nodeId,
                label: name,
                shape: 'dot',
                size: isEndpoint ? 25 : 18,
                x: slug === startSlug ? -endpointOffset : (slug === endSlug ? endpointOffset : undefined),
                y: isEndpoint ? 0 : undefined,
                fixed: isEndpoint ? { x: true, y: true } : false,
                color: nodeColor,
                font: {
                    color: isEndpoint ? GRAPH_PALETTE.label : GRAPH_PALETTE.labelMuted,
                    size: isEndpoint ? 17 : 14,
                    strokeWidth: 5,
                    strokeColor: '#fffdf8',
                    face: '-apple-system, BlinkMacSystemFont, sans-serif',
                },
            });
            nodeBaseStyles.set(nodeId, { color: nodeColor });
        }

        for (const edge of edges) {
            const key = `person:${edge.from}->person:${edge.to}`;
            addPathMembership(edgePathMap, key, pathIndex);
            edgeShowCounts.set(key, edge.shows.length);
            if (!edgeKeys.has(key)) {
                edgeKeys.add(key);
                edgeData.push({
                    id: key,
                    from: `person:${edge.from}`,
                    to: `person:${edge.to}`,
                    color: { color: path.length === 2 ? GRAPH_PALETTE.activeEdge : GRAPH_PALETTE.baseEdge, highlight: GRAPH_PALETTE.activeEdge },
                    width: minEdgeWidth,
                    smooth: false,
                    title: formatEdgeTitle(edge),
                });
                edgeBaseStyles.set(key, {
                    color: { color: path.length === 2 ? GRAPH_PALETTE.activeEdge : GRAPH_PALETTE.baseEdge, highlight: GRAPH_PALETTE.activeEdge },
                    width: minEdgeWidth,
                });
            }
        }
    }

    const edgeShowCountRange = getRange(edgeShowCounts.values());
    for (const edge of edgeData) {
        const width = scaleBetween(edgeShowCounts.get(edge.id), minEdgeWidth, maxEdgeWidth, edgeShowCountRange);
        edge.width = width;
        edgeBaseStyles.set(edge.id, {
            ...edgeBaseStyles.get(edge.id),
            width,
        });
    }

    const data = {
        nodes: new vis.DataSet(nodeData),
        edges: new vis.DataSet(edgeData),
    };

    appState.graphState = {
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
                gravitationalConstant: -95,
                centralGravity: 0.002,
                springLength: 180,
                springConstant: 0.04,
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

    const previousView = appState.network && preserveView
        ? {
            position: appState.network.getViewPosition(),
            scale: appState.network.getScale(),
        }
        : null;

    if (appState.network) {
        appState.network.setOptions(options);
        appState.network.setData(data);
    } else {
        appState.network = new vis.Network(graphContainer, data, options);
        appState.network.on('click', handleGraphClick);
    }

    const renderedNetwork = appState.network;
    renderedNetwork.once('stabilizationIterationsDone', () => {
        if (appState.network !== renderedNetwork) return;

        if (previousView) {
            renderedNetwork.moveTo({
                position: previousView.position,
                scale: previousView.scale,
                animation: false,
            });
            return;
        }

        renderedNetwork.fit({ animation: false });
        appState.graphDefaultView = {
            position: renderedNetwork.getViewPosition(),
            scale: renderedNetwork.getScale(),
        };
    });
}

function setHighlightedPath(pathIndex) {
    if (!appState.graphState) return;

    appState.currentHighlightedPath = pathIndex;
    const activePath = pathIndex;
    const nodeUpdates = appState.graphState.nodes.get().map((node) => {
        const inPath = activePath === null || appState.graphState.nodePathMap.get(node.id)?.has(activePath);
        const baseStyle = appState.graphState.nodeBaseStyles.get(node.id);
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
                    background: GRAPH_PALETTE.dimFill,
                    border: GRAPH_PALETTE.dimBorder,
                    highlight: baseStyle.color.highlight,
                },
        };
    });

    const edgeUpdates = appState.graphState.edges.get().map((edge) => {
        const inPath = activePath === null || appState.graphState.edgePathMap.get(edge.id)?.has(activePath);
        const baseStyle = appState.graphState.edgeBaseStyles.get(edge.id);
        return {
            id: edge.id,
            width: inPath ? baseStyle.width : Math.max(1, baseStyle.width * 0.35),
            color: inPath
                ? { color: baseStyle.color.color, highlight: GRAPH_PALETTE.activeEdge }
                : { color: GRAPH_PALETTE.mutedEdge, highlight: baseStyle.color.highlight },
        };
    });

    appState.graphState.nodes.update(nodeUpdates);
    appState.graphState.edges.update(edgeUpdates);

    document.querySelectorAll('.connection-path').forEach((element) => {
        element.classList.toggle('active', activePath !== null && Number(element.dataset.pathIndex) === activePath);
    });
}

function toggleHighlightedPath(pathIndex) {
    setHighlightedPath(appState.currentHighlightedPath === pathIndex ? null : pathIndex);
}

function getPrimaryPathIndex(pathIndices) {
    if (!pathIndices || pathIndices.size === 0) return null;
    if (appState.currentHighlightedPath !== null && pathIndices.has(appState.currentHighlightedPath)) {
        return appState.currentHighlightedPath;
    }
    return Math.min(...pathIndices);
}

function focusDetailElement(element) {
    if (!element) return;

    if (appState.detailFocusTimer) {
        clearTimeout(appState.detailFocusTimer);
        appState.detailFocusTimer = null;
    }

    element.classList.add('detail-focus');
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    appState.detailFocusTimer = window.setTimeout(() => {
        element.classList.remove('detail-focus');
        appState.detailFocusTimer = null;
    }, 1800);
}

function openPathDetails(pathIndex) {
    const pathEl = appState.dom.detailsContent.querySelector(`.connection-path[data-path-index="${pathIndex}"]`);
    if (!pathEl) return null;
    pathEl.open = true;
    return pathEl;
}

function focusPathInDetails(pathIndex, edgeId = null) {
    const pathEl = openPathDetails(pathIndex);
    if (!pathEl) return;

    let target = pathEl;
    if (edgeId) {
        const stepEl = [...pathEl.querySelectorAll('.connection-step')].find((element) => element.dataset.edgeId === edgeId);
        if (stepEl) target = stepEl;
    }

    focusDetailElement(target);
}

function handleGraphClick(params) {
    if (!appState.graphState) return;

    const nodeId = params.nodes[0];
    if (nodeId) {
        const pathIndex = getPrimaryPathIndex(appState.graphState.nodePathMap.get(nodeId));
        if (pathIndex === null) return;

        const shouldJumpToDetails = appState.lastClickedGraphNodeId === nodeId
            && appState.currentHighlightedPath === pathIndex;

        setHighlightedPath(pathIndex);
        if (shouldJumpToDetails) {
            focusPathInDetails(pathIndex);
        }
        appState.lastClickedGraphNodeId = nodeId;
        return;
    }

    const edgeId = params.edges[0];
    if (edgeId) {
        const pathIndex = getPrimaryPathIndex(appState.graphState.edgePathMap.get(edgeId));
        if (pathIndex === null) return;
        setHighlightedPath(pathIndex);
        focusPathInDetails(pathIndex, edgeId);
        appState.lastClickedGraphNodeId = null;
        return;
    }

    setHighlightedPath(null);
    appState.lastClickedGraphNodeId = null;
}

export function resetGraphView() {
    if (!appState.network) return;

    setHighlightedPath(null);
    appState.network.stopSimulation();

    if (appState.graphDefaultView) {
        appState.network.moveTo({
            position: appState.graphDefaultView.position,
            scale: appState.graphDefaultView.scale,
            animation: {
                duration: 500,
                easingFunction: 'easeInOutQuad',
            },
        });
        return;
    }

    appState.network.fit({
        animation: {
            duration: 500,
            easingFunction: 'easeInOutQuad',
        },
    });
}

function renderShowList(result) {
    const { paths, peopleNames } = result;
    const showsBySlug = new Map();

    for (const { path, edges } of paths) {
        for (let i = 0; i < edges.length; i++) {
            const edge = edges[i];
            const fromName = peopleNames.get(path[i]) || path[i];
            const toName = peopleNames.get(path[i + 1]) || path[i + 1];

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
        html += `<div class="show-link"><a href="${CAMDRAM_SITE_BASE}/shows/${show.showSlug}" target="_blank" rel="noopener noreferrer">Open show page</a></div>`;

        for (const link of show.links) {
            html += '<div class="show-list-link">';
            html += `<div class="connection-link"><strong>${escapeHtml(link.fromName)}</strong> &rarr; <strong>${escapeHtml(link.toName)}</strong></div>`;
            html += `<div class="roles"><strong>${escapeHtml(link.fromName)}</strong>: ${escapeHtml(link.fromRole)} | <strong>${escapeHtml(link.toName)}</strong>: ${escapeHtml(link.toRole)}</div>`;
            html += '</div>';
        }

        html += '</div>';
        html += '</details>';
    }

    html += '</div>';
    html += '</div>';
    return html;
}

export function renderDetails(result) {
    const { detailsContent } = appState.dom;
    const { paths, peopleNames } = result;
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
        html += '<div class="path-grid">';

        for (const { path, edges, pathIndex } of degreePaths) {
            const middlePeople = path.slice(1, -1).map((slug) => escapeHtml(peopleNames.get(slug) || slug));
            const pathLabel = middlePeople.length > 0 ? `&rarr; ${middlePeople.join(' &rarr; ')} &rarr;` : 'Direct connection';
            html += `<details class="connection-path" data-path-index="${pathIndex}" data-start-slug="${path[0]}" data-end-slug="${path[path.length - 1]}">`;
            html += `<summary class="path-summary">${pathLabel}</summary>`;
            html += '<div class="path-body">';

            for (let i = 0; i < path.length - 1; i++) {
                const fromSlug = path[i];
                const toSlug = path[i + 1];
                const fromName = peopleNames.get(fromSlug) || fromSlug;
                const toName = peopleNames.get(toSlug) || toSlug;
                const edge = edges.find((entry) => (
                    (entry.from === fromSlug && entry.to === toSlug) ||
                    (entry.from === toSlug && entry.to === fromSlug)
                ));

                if (edge) {
                    const edgeId = `person:${edge.from}->person:${edge.to}`;
                    html += `<div class="connection-step" data-edge-id="${edgeId}" data-person-slugs="${fromSlug} ${toSlug}">`;
                    html += `<div class="connection-link"><strong>${escapeHtml(fromName)}</strong> &rarr; <strong>${escapeHtml(toName)}</strong></div>`;
                    for (const show of edge.shows) {
                        const fromRole = edge.from === fromSlug ? show.fromRole : show.toRole;
                        const toRole = edge.from === fromSlug ? show.toRole : show.fromRole;
                        html += '<details class="show-detail">';
                        html += `<summary class="show-name">${escapeHtml(show.showName)}</summary>`;
                        html += '<div class="show-meta">';
                        html += `<div class="show-link"><a href="${CAMDRAM_SITE_BASE}/shows/${show.showSlug}" target="_blank" rel="noopener noreferrer">Open show page</a></div>`;
                        html += `<div class="roles"><strong>${escapeHtml(fromName)}</strong>: ${escapeHtml(fromRole)} | <strong>${escapeHtml(toName)}</strong>: ${escapeHtml(toRole)}</div>`;
                        html += '</div>';
                        html += '</details>';
                    }
                    html += '</div>';
                }
            }

            html += '</div>';
            html += '</details>';
        }

        html += '</div>';
        html += '</div>';
    }

    html += renderShowList(result);
    detailsContent.innerHTML = html;

    detailsContent.querySelectorAll('.connection-path').forEach((pathEl) => {
        const pathIndex = Number(pathEl.dataset.pathIndex);
        const summaryEl = pathEl.querySelector('.path-summary');
        summaryEl.addEventListener('click', () => toggleHighlightedPath(pathIndex));
        summaryEl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                toggleHighlightedPath(pathIndex);
            }
        });
    });
}

export function renderResultSummary(result, interim = false) {
    const { resultSummaryEl } = appState.dom;
    const pathCount = result.paths.length;
    const degrees = result.paths.map((path) => path.path.length - 1);
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

export function renderInterimResults(result) {
    const { resultsEl, degreesBadge, graphPanel, graphHelp } = appState.dom;
    resultsEl.classList.remove('hidden');
    degreesBadge.textContent = 'Path found';
    graphPanel.classList.remove('hidden');
    graphHelp.classList.remove('hidden');
    renderResultSummary(result, true);
    renderGraph(result, { preserveView: Boolean(appState.network) });
    renderDetails(result);
}

export function getNoConnectionHtml(selectedDepths) {
    return `<div class="no-connection"><strong>No connection found at selected degree${selectedDepths.length !== 1 ? 's' : ''}: ${formatSelectedDegrees(selectedDepths)}.</strong><br>Try adding more degrees, switch to All paths, or widen role types.</div>`;
}
