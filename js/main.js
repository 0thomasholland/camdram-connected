import { API_BASE } from './constants.js';
import { pool, prefetchPersonRoles } from './api.js';
import { exportGraphImage } from './export.js';
import { resetGraphView } from './graph.js';
import { renderInterimResults, renderNoConnectionState, renderSearchResults } from './results.js';
import { findAllConnections, getSelectedDepths, isShortestOnlyMode, parseDepthParam } from './search.js';
import { appState, setDomRefs } from './state.js';
import {
    bindDegreeDepthInputs,
    bindProgressToggle,
    hideProgress,
    hideStatus,
    logFetch,
    resetProgress,
    setSelectedPersonUI,
    setupAutocomplete,
    showError,
    showStatus,
    completeSearchTiming,
    updateFindButton,
    updateProgress,
} from './ui.js';

const dom = {
    person1Input: document.getElementById('person1'),
    person2Input: document.getElementById('person2'),
    person1Slug: document.getElementById('person1-slug'),
    person2Slug: document.getElementById('person2-slug'),
    person1List: document.getElementById('person1-list'),
    person2List: document.getElementById('person2-list'),
    person1Selected: document.getElementById('person1-selected'),
    person2Selected: document.getElementById('person2-selected'),
    findBtn: document.getElementById('find-btn'),
    statusEl: document.getElementById('status'),
    resultsEl: document.getElementById('results'),
    degreesBadge: document.getElementById('degrees-badge'),
    resultSummaryEl: document.getElementById('result-summary'),
    graphPanel: document.getElementById('graph-panel'),
    graphHelp: document.getElementById('graph-help'),
    graphHelpClose: document.getElementById('graph-help-close'),
    graphContainer: document.getElementById('graph-container'),
    detailsContent: document.getElementById('details-content'),
    resetViewBtn: document.getElementById('reset-view-btn'),
    exportBtn: document.getElementById('export-btn'),
    shareBtn: document.getElementById('share-btn'),
    progressContainer: document.getElementById('progress-container'),
    progressBar: document.getElementById('progress-bar'),
    progressLog: document.getElementById('progress-log'),
    progressDepthEl: document.getElementById('progress-depth'),
    progressShowsEl: document.getElementById('progress-shows'),
    progressConnectionsEl: document.getElementById('progress-connections'),
    progressCacheEl: document.getElementById('progress-cache'),
    progressPathsEl: document.getElementById('progress-paths'),
    progressSummaryEl: document.getElementById('progress-summary'),
    progressToggle: document.getElementById('progress-toggle'),
    timingCallout: document.getElementById('timing-callout'),
    timingTotalEl: document.getElementById('timing-total'),
    timingStatusEl: document.getElementById('timing-status'),
    timingBreakdownEl: document.getElementById('timing-breakdown'),
};

setDomRefs(dom);

function isStaleSearch(searchToken) {
    return searchToken !== appState.currentSearchToken;
}

function resetSearchUi() {
    dom.resultsEl.classList.add('hidden');
    hideStatus();
    dom.findBtn.disabled = true;
    dom.findBtn.textContent = 'Searching...';
    resetProgress();
    dom.resultSummaryEl.textContent = '';
    appState.currentHighlightedPath = null;
    appState.lastClickedGraphNodeId = null;
    appState.graphState = null;
    appState.graphDefaultView = null;
}

async function loadFromURL() {
    const params = new URLSearchParams(window.location.search);
    const p1 = params.get('p1');
    const p2 = params.get('p2');
    const depth = params.get('d');
    const sp = params.get('sp');

    if (!p1 || !p2) return;

    if (depth) {
        const selectedDepths = parseDepthParam(depth);
        if (selectedDepths.length > 0) {
            document.querySelectorAll('input[name="degree-depth"]').forEach((input) => {
                input.checked = selectedDepths.includes(parseInt(input.value, 10));
            });
        }
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
            dom.person1Input.value = data1.name;
            dom.person1Slug.value = data1.slug;
            setSelectedPersonUI(dom.person1Input, dom.person1Slug, dom.person1Selected, data1);
            prefetchPersonRoles(data1.slug);
        }

        if (data2) {
            dom.person2Input.value = data2.name;
            dom.person2Slug.value = data2.slug;
            setSelectedPersonUI(dom.person2Input, dom.person2Slug, dom.person2Selected, data2);
            prefetchPersonRoles(data2.slug);
        }

        hideStatus();
        updateFindButton();

        if (data1 && data2) {
            dom.findBtn.click();
        }
    } catch {
        hideStatus();
    }
}

async function handleSearch() {
    const searchToken = ++appState.currentSearchToken;
    const slug1 = dom.person1Slug.value;
    const slug2 = dom.person2Slug.value;
    if (!slug1 || !slug2) return;

    if (slug1 === slug2) {
        showError('Please select two different people.');
        return;
    }

    resetSearchUi();

    try {
        const selectedDepths = getSelectedDepths();
        const result = await findAllConnections(slug1, slug2, selectedDepths, {
            onPathFound(interimResult) {
                if (isStaleSearch(searchToken)) return;
                renderInterimResults(interimResult);
            },
            onProgress: updateProgress,
            onLog: logFetch,
        });

        if (isStaleSearch(searchToken)) return;

        hideProgress();
        hideStatus();
        completeSearchTiming(Boolean(result));

        if (!result) {
            renderNoConnectionState(selectedDepths);
            return;
        }

        const url = buildShareUrl();
        history.replaceState(null, '', url);

        renderSearchResults(result);
    } catch (err) {
        if (isStaleSearch(searchToken)) return;
        hideProgress();
        completeSearchTiming(false, err.message || 'Search failed');
        showError(err.message || 'Something went wrong');
    } finally {
        if (isStaleSearch(searchToken)) return;
        dom.findBtn.disabled = false;
        dom.findBtn.textContent = 'Find Connection';
        updateFindButton();
    }
}

function handleExport() {
    exportGraphImage(dom.graphContainer).catch(() => {
        showError('Could not export PNG right now.');
    });
}

function buildShareUrl() {
    const url = new URL(window.location);
    url.searchParams.set('p1', dom.person1Slug.value);
    url.searchParams.set('p2', dom.person2Slug.value);
    url.searchParams.set('d', getSelectedDepths().join(','));
    if (isShortestOnlyMode()) {
        url.searchParams.set('sp', '1');
    } else {
        url.searchParams.delete('sp');
    }
    return url;
}

function handleShare() {
    const url = buildShareUrl();

    navigator.clipboard.writeText(url.toString()).then(() => {
        dom.shareBtn.textContent = 'Copied!';
        setTimeout(() => {
            dom.shareBtn.textContent = 'Share Link';
        }, 1500);
    }).catch(() => {
        window.prompt('Copy this link:', url.toString());
    });
}

function dismissGraphHelp() {
    dom.graphHelp.classList.add('hidden');
}

dom.findBtn.addEventListener('click', handleSearch);
dom.exportBtn.addEventListener('click', handleExport);
dom.shareBtn.addEventListener('click', handleShare);
dom.resetViewBtn.addEventListener('click', resetGraphView);
dom.graphHelpClose.addEventListener('click', dismissGraphHelp);

bindProgressToggle();
bindDegreeDepthInputs();
setupAutocomplete(dom.person1Input, dom.person1List, dom.person1Slug, dom.person1Selected);
setupAutocomplete(dom.person2Input, dom.person2List, dom.person2Slug, dom.person2Selected);
updateFindButton();
loadFromURL();
