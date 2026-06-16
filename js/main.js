import { API_BASE } from './constants.js';
import { pool, prefetchPersonRoles } from './api.js';
import { getNoConnectionHtml, renderDetails, renderGraph, renderInterimResults, renderResultSummary, resetGraphView } from './graph.js';
import { findAllConnections, formatSelectedDegrees, getSelectedDepths, isShortestOnlyMode, parseDepthParam } from './search.js';
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

    try {
        const selectedDepths = getSelectedDepths();
        const result = await findAllConnections(slug1, slug2, selectedDepths, {
            onPathFound(interimResult) {
                if (searchToken !== appState.currentSearchToken) return;
                renderInterimResults(interimResult);
            },
            onProgress: updateProgress,
            onLog: logFetch,
        });

        hideProgress();
        hideStatus();
        completeSearchTiming(Boolean(result));

        if (!result) {
            dom.resultsEl.classList.remove('hidden');
            dom.degreesBadge.innerHTML = 'No connection found';
            dom.graphPanel.classList.add('hidden');
            dom.graphHelp.classList.add('hidden');
            dom.resultSummaryEl.textContent = `No paths found for ${formatSelectedDegrees(selectedDepths)} degree${selectedDepths.length !== 1 ? 's' : ''}.`;
            dom.detailsContent.innerHTML = getNoConnectionHtml(selectedDepths);
            return;
        }

        const degrees = result.paths.map((path) => path.path.length - 1);
        const minDeg = Math.min(...degrees);
        const maxDeg = Math.max(...degrees);
        const pathCount = result.paths.length;
        dom.degreesBadge.innerHTML = minDeg === maxDeg
            ? `<span class="number">${pathCount}</span> path${pathCount !== 1 ? 's' : ''} at <span class="number">${minDeg}</span> degree${minDeg !== 1 ? 's' : ''}`
            : `<span class="number">${pathCount}</span> path${pathCount !== 1 ? 's' : ''} across <span class="number">${minDeg}&ndash;${maxDeg}</span> degrees`;

        const url = buildShareUrl();
        history.replaceState(null, '', url);

        renderResultSummary(result);
        dom.graphPanel.classList.remove('hidden');
        dom.graphHelp.classList.remove('hidden');
        dom.resultsEl.classList.remove('hidden');
        renderGraph(result);
        renderDetails(result);
    } catch (err) {
        hideProgress();
        completeSearchTiming(false, err.message || 'Search failed');
        showError(err.message || 'Something went wrong');
    } finally {
        dom.findBtn.disabled = false;
        dom.findBtn.textContent = 'Find Connection';
        updateFindButton();
    }
}

function handleExport() {
    exportGraphImage().catch(() => {
        showError('Could not export PNG right now.');
    });
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
    });
}

async function loadBrandMark() {
    const response = await fetch('/assets/icons/camdram-connected.svg');
    if (!response.ok) throw new Error('Failed to load brand mark');
    const svg = await response.text();
    return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function roundRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius);
    context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
}

function getExportTheme() {
    const styles = getComputedStyle(document.documentElement);
    return {
        bg: styles.getPropertyValue('--bg').trim() || '#f8eede',
        surface: styles.getPropertyValue('--surface').trim() || '#ffffff',
        border: styles.getPropertyValue('--border').trim() || 'rgba(58, 57, 58, 0.2)',
        text: styles.getPropertyValue('--text').trim() || '#3a393a',
        textMuted: styles.getPropertyValue('--text-muted').trim() || 'rgba(58, 57, 58, 0.7)',
        accent: styles.getPropertyValue('--accent').trim() || '#ec6736',
        accentGlow: styles.getPropertyValue('--accent-glow').trim() || 'rgba(236, 103, 54, 0.1)',
    };
}

function fitText(context, text, maxWidth, initialSize, minSize) {
    let size = initialSize;
    while (size > minSize) {
        context.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        if (context.measureText(text).width <= maxWidth) return size;
        size -= 2;
    }
    return minSize;
}

async function exportGraphImage() {
    if (!appState.network) return;
    const graphCanvas = dom.graphContainer.querySelector('canvas');
    if (!graphCanvas) return;

    const brandMark = await loadBrandMark();
    const theme = getExportTheme();
    const scale = graphCanvas.clientWidth ? graphCanvas.width / graphCanvas.clientWidth : 1;
    const padding = Math.round(28 * scale);
    const headerHeight = Math.round(108 * scale);
    const footerHeight = Math.round(82 * scale);
    const cardRadius = Math.round(18 * scale);
    const width = graphCanvas.width + padding * 2;
    const height = headerHeight + graphCanvas.height + footerHeight + padding * 2;
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;

    const context = exportCanvas.getContext('2d');
    context.fillStyle = theme.bg;
    context.fillRect(0, 0, width, height);

    const cardX = padding;
    const cardY = headerHeight;
    const cardWidth = graphCanvas.width;
    const cardHeight = graphCanvas.height;

    roundRect(context, cardX, cardY, cardWidth, cardHeight, cardRadius);
    context.fillStyle = theme.surface;
    context.fill();
    context.lineWidth = Math.max(2, scale);
    context.strokeStyle = theme.border;
    context.stroke();
    context.save();
    roundRect(context, cardX, cardY, cardWidth, cardHeight, cardRadius);
    context.clip();
    context.drawImage(graphCanvas, cardX, cardY, cardWidth, cardHeight);
    context.restore();

    const logoSize = Math.round(44 * scale);
    const logoX = padding;
    const logoY = Math.round(24 * scale);
    context.drawImage(brandMark, logoX, logoY, logoSize, logoSize);

    context.fillStyle = theme.text;
    context.font = `700 ${Math.round(28 * scale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    context.textBaseline = 'alphabetic';
    context.fillText('Camdram Connected', logoX + logoSize + Math.round(16 * scale), logoY + Math.round(18 * scale));

    context.fillStyle = theme.textMuted;
    context.font = `500 ${Math.round(14 * scale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    context.fillText('Find connection between any two people in Cambridge theatre', logoX + logoSize + Math.round(16 * scale), logoY + Math.round(42 * scale));

    const url = new URL(window.location.href);
    const exportUrl = url.toString();
    const footerY = headerHeight + graphCanvas.height + Math.round(24 * scale);
    const urlBoxX = padding;
    const urlBoxY = footerY - Math.round(6 * scale);
    const urlBoxWidth = width - padding * 2;
    const urlBoxHeight = Math.round(42 * scale);

    roundRect(context, urlBoxX, urlBoxY, urlBoxWidth, urlBoxHeight, Math.round(21 * scale));
    context.fillStyle = theme.accentGlow;
    context.fill();
    context.strokeStyle = theme.border;
    context.stroke();

    context.fillStyle = theme.accent;
    context.font = `700 ${Math.round(14 * scale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    context.fillText('URL', urlBoxX + Math.round(16 * scale), urlBoxY + Math.round(27 * scale));

    const urlTextX = urlBoxX + Math.round(60 * scale);
    const urlFontSize = fitText(context, exportUrl, urlBoxWidth - Math.round(76 * scale), Math.round(14 * scale), Math.round(10 * scale));
    context.font = `600 ${urlFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    context.fillStyle = theme.textMuted;
    context.fillText(exportUrl, urlTextX, urlBoxY + Math.round(27 * scale));

    const link = document.createElement('a');
    link.download = 'camdram-connected.png';
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
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
