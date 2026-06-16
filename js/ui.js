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

export function resetProgress() {
    const {
        progressContainer,
        progressLog,
        progressBar,
        progressDepthEl,
        progressShowsEl,
        progressCacheEl,
        progressPathsEl,
        progressSummaryEl,
    } = appState.dom;

    progressContainer.classList.remove('hidden');
    progressLog.innerHTML = '';
    progressBar.style.width = '0%';
    progressDepthEl.textContent = '';
    progressShowsEl.textContent = '0 shows';
    progressCacheEl.textContent = '0 cached';
    progressPathsEl.textContent = '0 paths';
    progressSummaryEl.textContent = 'Preparing search...';
    appState.cacheHits = 0;
}

export function hideProgress() {
    appState.dom.progressContainer.classList.add('hidden');
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

export function updateProgress(depthLabel, current, total, showCount, pathCount) {
    const {
        progressDepthEl,
        progressShowsEl,
        progressCacheEl,
        progressPathsEl,
        progressSummaryEl,
        progressBar,
    } = appState.dom;

    progressDepthEl.textContent = `${depthLabel} — ${current}/${total} people`;
    progressShowsEl.textContent = `${showCount} show${showCount !== 1 ? 's' : ''}`;
    progressCacheEl.textContent = `${appState.cacheHits} cached`;
    progressPathsEl.textContent = `${pathCount} path${pathCount !== 1 ? 's' : ''}`;
    progressSummaryEl.textContent = buildProgressSummary(depthLabel, current, total, showCount, pathCount);
    const pct = total > 0 ? (current / total) * 100 : 0;
    progressBar.style.width = `${pct}%`;
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

export function syncSelectedBadge(input, slugInput, selectedEl) {
    if (slugInput.value) {
        setSelectedPersonUI(input, slugInput, selectedEl, {
            name: input.value,
            slug: slugInput.value,
        });
    } else {
        setSelectedPersonUI(input, slugInput, selectedEl, null);
    }
}

export function swapPeople() {
    const { person1Input, person1Slug, person1Selected, person2Input, person2Slug, person2Selected } = appState.dom;
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
