import { createOptionsResponse, proxyJsonRequest } from '../_shared/proxy.js';

const CAMDRAM = 'https://www.camdram.net';

export async function onRequestOptions() {
    return createOptionsResponse();
}

export async function onRequestGet(context) {
    const path = context.params.path.join('/');
    return proxyJsonRequest(context.request.url, path, CAMDRAM, {
        responseHeaders: { 'Cache-Control': 'public, max-age=300' },
    });
}
