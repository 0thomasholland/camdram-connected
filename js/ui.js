import { searchPeople, prefetchPersonRoles } from './api.js';
import { appState } from './state.js';

export function escapeHtml(str) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = str;

    const div = document.createElement('div');
    div.textContent = textarea.value;
    return div.innerHTML;
}

export function setSelectedPersonUI(input, slugInput, selectedEl, person) {
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

function renderAutocompleteState(list, message, className = 'empty') {
    list.innerHTML = '';
    const item = document.createElement('div');
    item.className = `autocomplete-item ${className}`;
    item.textContent = message;
    list.appendChild(item);
    list.classList.add('visible');
}

function formatCompactCount(count) {
    if (!Number.isFinite(count)) return '0';
    if (Math.abs(count) < 10000) return String(count);
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

function setProgressMetric(element, count, singularLabel, pluralLabel = `${singularLabel}s`) {
    const label = count === 1 ? singularLabel : pluralLabel;
    element.innerHTML = `<span class="progress-counter-value">${formatCompactCount(count)}</span><span class="progress-counter-label">${escapeHtml(label)}</span>`;
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
}

function updateActiveItem(input, items, index) {
    items.forEach((item, itemIndex) => {
        item.classList.toggle('active', itemIndex === index);
        item.setAttribute('aria-selected', itemIndex === index ? 'true' : 'false');
    });

    const activeItem = items[index];
    if (activeItem) {
        input.setAttribute('aria-activedescendant', activeItem.id);
    } else {
        input.removeAttribute('aria-activedescendant');
    }
}

export function updateFindButton() {
    const { findBtn, person1Slug, person2Slug } = appState.dom;
    findBtn.disabled = !(person1Slug.value && person2Slug.value) || person1Slug.value === person2Slug.value;
}

export function setupAutocomplete(input, list, slugInput, selectedEl) {
    let debounceTimer = null;
    let activeIndex = -1;
    let requestId = 0;

    function closeList() {
        list.classList.remove('visible');
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    input.addEventListener('input', () => {
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
                input.setAttribute('aria-expanded', 'true');
            } catch {
                if (thisRequestId !== requestId) return;
                renderAutocompleteState(list, 'Search unavailable right now.', 'error');
                input.setAttribute('aria-expanded', 'true');
            }
        }, 300);
    });

    input.addEventListener('keydown', (event) => {
        const items = list.querySelectorAll('.autocomplete-item');
        if (!items.length) return;

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            activeIndex = Math.min(activeIndex + 1, items.length - 1);
            updateActiveItem(input, items, activeIndex);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            updateActiveItem(input, items, activeIndex);
        } else if (event.key === 'Enter' && activeIndex >= 0) {
            event.preventDefault();
            items[activeIndex].click();
        } else if (event.key === 'Enter' && appState.dom.person1Slug.value && appState.dom.person2Slug.value) {
            event.preventDefault();
            appState.dom.findBtn.click();
        } else if (event.key === 'Escape') {
            closeList();
        }
    });

    document.addEventListener('click', (event) => {
        if (!input.contains(event.target) && !list.contains(event.target)) {
            closeList();
        }
    });
}

export function showStatus(message, type = 'loading') {
    const { statusEl } = appState.dom;
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.classList.remove('hidden');
}

export function hideStatus() {
    appState.dom.statusEl.classList.add('hidden');
}

export function showError(message) {
    showStatus(message, 'error');
}

function formatElapsedMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0.0s';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)}s`;
}

function formatRateValue(count, elapsedMs) {
    if (!Number.isFinite(count) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
        return '0';
    }

    const rate = count / (elapsedMs / 1000);
    if (rate >= 10000) return `${(rate / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    if (rate >= 100) return String(Math.round(rate));
    if (rate >= 10) return rate.toFixed(1);
    return rate.toFixed(2);
}

function stopTimingTicker() {
    if (!appState.timingTicker) return;
    window.clearInterval(appState.timingTicker);
    appState.timingTicker = null;
}

function ensureTimingTicker() {
    if (appState.timingTicker) return;
    appState.timingTicker = window.setInterval(() => {
        if (!appState.searchTiming) {
            stopTimingTicker();
            return;
        }
        renderTimingCallout();
    }, 100);
}

function finalizeActiveTiming(now = performance.now()) {
    const timing = appState.searchTiming;
    if (!timing || !timing.activeLabel) return;
    const phase = timing.phases.find((entry) => entry.label === timing.activeLabel);
    if (!phase) return;
    phase.elapsedMs = now - phase.startedAt;
}

function touchTimingPhase(depthLabel) {
    const now = performance.now();
    if (!appState.searchTiming) {
        appState.searchTiming = {
            startedAt: now,
            activeLabel: null,
            phases: [],
            completed: false,
            status: 'Running search...',
            resultSummary: '',
            totals: { people: 0, shows: 0, connections: 0 },
        };
    }

    const timing = appState.searchTiming;
    timing.resultSummary = '';
    if (timing.activeLabel && timing.activeLabel !== depthLabel) {
        finalizeActiveTiming(now);
    }

    let phase = timing.phases.find((entry) => entry.label === depthLabel);
    if (!phase) {
        phase = { label: depthLabel, startedAt: now, elapsedMs: 0 };
        timing.phases.push(phase);
    }

    timing.activeLabel = depthLabel;
    timing.completed = false;
    timing.status = `Currently exploring ${depthLabel.toLowerCase()}.`;
    ensureTimingTicker();
    renderTimingCallout();
}

function renderTimingCallout() {
    const { timingCallout, timingTotalEl, timingStatusEl, timingBreakdownEl } = appState.dom;
    const timing = appState.searchTiming;
    if (!timing) {
        timingCallout.classList.add('hidden');
        return;
    }

    const now = performance.now();
    const totalElapsedMs = timing.completed ? timing.totalElapsedMs : now - timing.startedAt;
    timingCallout.classList.remove('hidden');
    timingTotalEl.textContent = `Total: ${formatElapsedMs(totalElapsedMs)}`;
    timingStatusEl.textContent = timing.resultSummary || timing.status;

    timingBreakdownEl.innerHTML = '';
    const throughputMetrics = [
        { label: 'People/s', value: formatRateValue(timing.totals.people, totalElapsedMs) },
        { label: 'Shows/s', value: formatRateValue(timing.totals.shows, totalElapsedMs) },
        { label: 'Connections/s', value: formatRateValue(timing.totals.connections, totalElapsedMs) },
    ];

    for (const metric of throughputMetrics) {
        const item = document.createElement('div');
        item.className = 'timing-chip timing-chip-metric';
        item.innerHTML = `<span class="timing-chip-label">${escapeHtml(metric.label)}</span><span class="timing-chip-value">${escapeHtml(metric.value)}</span>`;
        timingBreakdownEl.appendChild(item);
    }

    for (const phase of timing.phases) {
        const item = document.createElement('div');
        item.className = 'timing-chip';
        if (!timing.completed && phase.label === timing.activeLabel) {
            item.classList.add('active');
        }

        const phaseElapsedMs = !timing.completed && phase.label === timing.activeLabel
            ? now - phase.startedAt
            : phase.elapsedMs;
        item.innerHTML = `<span class="timing-chip-label">${escapeHtml(phase.label)}</span><span class="timing-chip-value">${escapeHtml(formatElapsedMs(phaseElapsedMs))}</span>`;
        timingBreakdownEl.appendChild(item);
    }
}

export function resetProgress() {
    const {
        progressContainer,
        progressLog,
        progressBar,
        progressDepthEl,
        progressShowsEl,
        progressConnectionsEl,
        progressCacheEl,
        progressPathsEl,
        progressSummaryEl,
    } = appState.dom;

    progressContainer.classList.remove('hidden');
    progressLog.innerHTML = '';
    progressBar.style.width = '0%';
    progressDepthEl.textContent = '';
    setProgressMetric(progressShowsEl, 0, 'show');
    setProgressMetric(progressConnectionsEl, 0, 'connection');
    setProgressMetric(progressCacheEl, 0, 'cached', 'cached');
    setProgressMetric(progressPathsEl, 0, 'path');
    progressSummaryEl.textContent = 'Preparing search...';
    appState.cacheHits = 0;
    appState.searchTiming = {
        startedAt: performance.now(),
        activeLabel: null,
            phases: [],
            completed: false,
            status: 'Preparing search...',
            resultSummary: '',
            totals: { people: 0, shows: 0, connections: 0 },
        };
    stopTimingTicker();
    ensureTimingTicker();
    renderTimingCallout();
}

export function hideProgress() {
    appState.dom.progressContainer.classList.add('hidden');
}

function buildProgressSummary(depthLabel, current, total, showCount, pathCount, connectionCount) {
    if (pathCount > 0) {
        return `${depthLabel}: found ${pathCount} candidate path${pathCount !== 1 ? 's' : ''}, finishing current layer.`;
    }
    if (showCount > 0) {
        return `${depthLabel}: explored ${current}/${total} people, checked ${showCount} show${showCount !== 1 ? 's' : ''}, and evaluated ${connectionCount} connection${connectionCount !== 1 ? 's' : ''}.`;
    }
    return `${depthLabel}: exploring connections...`;
}

export function updateProgress(depthLabel, current, total, showCount, pathCount, connectionCount = 0, peopleCount = 0) {
    const {
        progressDepthEl,
        progressShowsEl,
        progressConnectionsEl,
        progressCacheEl,
        progressPathsEl,
        progressSummaryEl,
        progressBar,
    } = appState.dom;

    const timing = appState.searchTiming;
    if (timing) {
        timing.totals.people = peopleCount;
        timing.totals.shows = showCount;
        timing.totals.connections = connectionCount;
    }

    progressDepthEl.textContent = `${depthLabel} — ${current}/${total} people`;
    setProgressMetric(progressShowsEl, showCount, 'show');
    setProgressMetric(progressConnectionsEl, connectionCount, 'connection');
    setProgressMetric(progressCacheEl, appState.cacheHits, 'cached', 'cached');
    setProgressMetric(progressPathsEl, pathCount, 'path');
    progressSummaryEl.textContent = buildProgressSummary(depthLabel, current, total, showCount, pathCount, connectionCount);
    const pct = total > 0 ? (current / total) * 100 : 0;
    progressBar.style.width = `${pct}%`;
    touchTimingPhase(depthLabel);
}

export function completeSearchTiming(foundResult, message = '') {
    if (!appState.searchTiming) return;
    const now = performance.now();
    finalizeActiveTiming(now);
    appState.searchTiming.completed = true;
    appState.searchTiming.totalElapsedMs = now - appState.searchTiming.startedAt;
    appState.searchTiming.activeLabel = null;
    appState.searchTiming.status = foundResult ? 'Search complete.' : 'Search ended.';
    appState.searchTiming.resultSummary = message || (foundResult ? 'Timing for completed search.' : 'No connection found in selected search space.');
    stopTimingTicker();
    renderTimingCallout();
}

export function logFetch(message, type = '') {
    const { progressLog } = appState.dom;
    const line = document.createElement('div');
    line.className = 'log-line' + (type ? ` ${type}` : '');
    line.textContent = message;
    progressLog.appendChild(line);
    progressLog.scrollTop = progressLog.scrollHeight;
}

export function bindProgressToggle() {
    const { progressToggle, progressLog } = appState.dom;
    progressToggle.addEventListener('click', () => {
        const expanded = progressToggle.getAttribute('aria-expanded') === 'true';
        progressToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        progressToggle.textContent = expanded ? 'Show technical progress' : 'Hide technical progress';
        progressLog.classList.toggle('hidden', expanded);
    });
}

export function bindDegreeDepthInputs() {
    document.querySelectorAll('input[name="degree-depth"]').forEach((input) => {
        input.addEventListener('change', () => {
            if (document.querySelectorAll('input[name="degree-depth"]:checked').length > 0) return;
            input.checked = true;
        });
    });
}
