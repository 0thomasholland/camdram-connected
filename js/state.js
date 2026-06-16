export const appState = {
    dom: {},
    network: null,
    personRolesCache: new Map(),
    showRolesCache: new Map(),
    adjacencyCache: new Map(),
    peopleSearchCache: new Map(),
    peopleNames: new Map(),
    cacheHits: 0,
    currentSearchToken: 0,
    currentHighlightedPath: null,
    lastClickedGraphNodeId: null,
    graphState: null,
    graphDefaultView: null,
    detailFocusTimer: null,
    searchTiming: null,
    timingTicker: null,
};

export function setDomRefs(dom) {
    appState.dom = dom;
}
