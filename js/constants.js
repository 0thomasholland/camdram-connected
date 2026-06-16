export const API_BASE = '/api';
export const CAMDRAM_SITE_BASE = 'https://www.camdram.net';

export const CONCURRENCY = 4;
export const MIN_GAP_MS = 50;
export const MAX_GAP_MS = 400;
export const MAX_RETRIES = 3;
export const BASE_RETRY_MS = 200;

export const GRAPH_PALETTE = {
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
