import { CAMDRAM_SITE_BASE } from './constants.js';
import { renderGraph, toggleHighlightedPath } from './graph.js';
import { formatSelectedDegrees, isShortestOnlyMode } from './search.js';
import { appState } from './state.js';
import { escapeHtml } from './ui.js';

function getModeLabel() {
    return isShortestOnlyMode() ? 'best / shortest search' : 'all-path search';
}

function getDegreeSummary(result) {
    const degrees = result.paths.map((path) => path.path.length - 1);
    return {
        min: Math.min(...degrees),
        max: Math.max(...degrees),
        count: result.paths.length,
    };
}

function renderDegreesBadge(result) {
    const { degreesBadge } = appState.dom;
    const { min, max, count } = getDegreeSummary(result);
    degreesBadge.innerHTML = min === max
        ? `<span class="number">${count}</span> path${count !== 1 ? 's' : ''} at <span class="number">${min}</span> degree${min !== 1 ? 's' : ''}`
        : `<span class="number">${count}</span> path${count !== 1 ? 's' : ''} across <span class="number">${min}&ndash;${max}</span> degrees`;
}

function buildShowIndex(paths, peopleNames) {
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

    return [...showsBySlug.values()].sort((a, b) => {
        if (b.links.length !== a.links.length) return b.links.length - a.links.length;
        return a.showName.localeCompare(b.showName);
    });
}

function renderShowLinks(show) {
    let html = '';
    for (const link of show.links) {
        html += '<div class="show-list-link">';
        html += `<div class="connection-link"><strong>${escapeHtml(link.fromName)}</strong> &rarr; <strong>${escapeHtml(link.toName)}</strong></div>`;
        html += `<div class="roles"><strong>${escapeHtml(link.fromName)}</strong>: ${escapeHtml(link.fromRole)} | <strong>${escapeHtml(link.toName)}</strong>: ${escapeHtml(link.toRole)}</div>`;
        html += '</div>';
    }
    return html;
}

function renderShowList(result) {
    const shows = buildShowIndex(result.paths, result.peopleNames);
    let html = '<div class="show-list-section">';
    html += `<div class="degree-heading">Shows &mdash; ${shows.length} show${shows.length !== 1 ? 's' : ''}</div>`;
    html += '<div class="show-list-grid">';

    for (const show of shows) {
        html += '<details class="show-list-item">';
        html += `<summary class="show-list-summary">${escapeHtml(show.showName)} <span class="show-count">${show.links.length} link${show.links.length !== 1 ? 's' : ''}</span></summary>`;
        html += '<div class="show-list-body">';
        html += `<div class="show-link"><a href="${CAMDRAM_SITE_BASE}/shows/${show.showSlug}" target="_blank" rel="noopener noreferrer">Open show page</a></div>`;
        html += renderShowLinks(show);
        html += '</div>';
        html += '</details>';
    }

    html += '</div>';
    html += '</div>';
    return html;
}

function groupPathsByDegree(paths) {
    const byDegree = new Map();
    paths.forEach(({ path, edges }, pathIndex) => {
        const degree = path.length - 1;
        if (!byDegree.has(degree)) byDegree.set(degree, []);
        byDegree.get(degree).push({ path, edges, pathIndex });
    });
    return byDegree;
}

function findEdgeForStep(edges, fromSlug, toSlug) {
    return edges.find((edge) => (
        (edge.from === fromSlug && edge.to === toSlug) ||
        (edge.from === toSlug && edge.to === fromSlug)
    ));
}

function renderEdgeShows(edge, fromSlug, fromName, toName) {
    let html = '';
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
    return html;
}

function renderPathSteps(path, edges, peopleNames) {
    let html = '';
    for (let i = 0; i < path.length - 1; i++) {
        const fromSlug = path[i];
        const toSlug = path[i + 1];
        const fromName = peopleNames.get(fromSlug) || fromSlug;
        const toName = peopleNames.get(toSlug) || toSlug;
        const edge = findEdgeForStep(edges, fromSlug, toSlug);
        if (!edge) continue;

        const edgeId = `person:${edge.from}->person:${edge.to}`;
        html += `<div class="connection-step" data-edge-id="${edgeId}" data-person-slugs="${fromSlug} ${toSlug}">`;
        html += `<div class="connection-link"><strong>${escapeHtml(fromName)}</strong> &rarr; <strong>${escapeHtml(toName)}</strong></div>`;
        html += renderEdgeShows(edge, fromSlug, fromName, toName);
        html += '</div>';
    }
    return html;
}

function renderDegreeGroup(degree, degreePaths, peopleNames) {
    let html = `<div class="degree-group" data-degree="${degree}">`;
    html += `<div class="degree-heading">${degree} degree${degree !== 1 ? 's' : ''} of separation &mdash; ${degreePaths.length} path${degreePaths.length !== 1 ? 's' : ''}</div>`;
    html += '<div class="path-grid">';

    for (const { path, edges, pathIndex } of degreePaths) {
        const middlePeople = path.slice(1, -1).map((slug) => escapeHtml(peopleNames.get(slug) || slug));
        const pathLabel = middlePeople.length > 0 ? `&rarr; ${middlePeople.join(' &rarr; ')} &rarr;` : 'Direct connection';
        html += `<details class="connection-path" data-path-index="${pathIndex}" data-start-slug="${path[0]}" data-end-slug="${path[path.length - 1]}">`;
        html += `<summary class="path-summary">${pathLabel}</summary>`;
        html += '<div class="path-body">';
        html += renderPathSteps(path, edges, peopleNames);
        html += '</div>';
        html += '</details>';
    }

    html += '</div>';
    html += '</div>';
    return html;
}

function bindDetailInteractions() {
    appState.dom.detailsContent.querySelectorAll('.connection-path').forEach((pathEl) => {
        const pathIndex = Number(pathEl.dataset.pathIndex);
        const summaryEl = pathEl.querySelector('.path-summary');
        summaryEl.addEventListener('click', () => toggleHighlightedPath(pathIndex));
        summaryEl.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            toggleHighlightedPath(pathIndex);
        });
    });
}

export function renderDetails(result) {
    const { detailsContent } = appState.dom;
    const byDegree = groupPathsByDegree(result.paths);
    const sortedDegrees = [...byDegree.keys()].sort((a, b) => a - b);
    let html = '';

    for (const degree of sortedDegrees) {
        html += renderDegreeGroup(degree, byDegree.get(degree), result.peopleNames);
    }

    html += renderShowList(result);
    detailsContent.innerHTML = html;
    bindDetailInteractions();
}

export function renderResultSummary(result, interim = false) {
    const { resultSummaryEl } = appState.dom;
    const { min, max, count } = getDegreeSummary(result);
    const modeLabel = getModeLabel();

    if (interim) {
        resultSummaryEl.textContent = `Found ${count} candidate path${count !== 1 ? 's' : ''} so far in ${modeLabel}.`;
        return;
    }

    if (min === max) {
        resultSummaryEl.textContent = `${modeLabel} finished. ${count} path${count !== 1 ? 's' : ''} at ${min} degree${min !== 1 ? 's' : ''}.`;
        return;
    }

    resultSummaryEl.textContent = `${modeLabel} finished. ${count} path${count !== 1 ? 's' : ''} across ${min}-${max} degrees.`;
}

export function renderSearchResults(result) {
    const { graphPanel, graphHelp, resultsEl } = appState.dom;
    renderDegreesBadge(result);
    renderResultSummary(result);
    graphPanel.classList.remove('hidden');
    graphHelp.classList.remove('hidden');
    resultsEl.classList.remove('hidden');
    renderGraph(result);
    renderDetails(result);
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

export function renderNoConnectionState(selectedDepths) {
    const { resultsEl, degreesBadge, graphPanel, graphHelp, resultSummaryEl, detailsContent } = appState.dom;
    resultsEl.classList.remove('hidden');
    degreesBadge.innerHTML = 'No connection found';
    graphPanel.classList.add('hidden');
    graphHelp.classList.add('hidden');
    resultSummaryEl.textContent = `No paths found for ${formatSelectedDegrees(selectedDepths)} degree${selectedDepths.length !== 1 ? 's' : ''}.`;
    detailsContent.innerHTML = getNoConnectionHtml(selectedDepths);
}

export function getNoConnectionHtml(selectedDepths) {
    return `<div class="no-connection"><strong>No connection found at selected degree${selectedDepths.length !== 1 ? 's' : ''}: ${formatSelectedDegrees(selectedDepths)}.</strong><br>Try adding more degrees, switch to All paths, or widen role types.</div>`;
}
