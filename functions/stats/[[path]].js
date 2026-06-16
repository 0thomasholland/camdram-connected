import { createOptionsResponse, proxyJsonRequest } from '../_shared/proxy.js';

const COUNTER_BASE = 'https://camdramconnected.goatcounter.com/counter';

export async function onRequestOptions() {
    return createOptionsResponse();
}

export async function onRequestGet(context) {
    const path = context.params.path.join('/');
    return proxyJsonRequest(context.request.url, path, COUNTER_BASE, {
        requestHeaders: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
        },
        responseHeaders: {
            'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
    });
}
