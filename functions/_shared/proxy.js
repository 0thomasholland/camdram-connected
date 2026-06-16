export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function buildJsonHeaders(extraHeaders = {}) {
    return {
        'Content-Type': 'application/json',
        ...extraHeaders,
        ...CORS_HEADERS,
    };
}

export function createOptionsResponse() {
    return new Response(null, { headers: CORS_HEADERS });
}

export function createNotFoundResponse() {
    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
}

export async function proxyJsonRequest(requestUrl, path, upstreamBase, options = {}) {
    const { requestHeaders = {}, responseHeaders = {} } = options;
    if (!path.endsWith('.json')) {
        return createNotFoundResponse();
    }

    const url = new URL(requestUrl);
    const target = `${upstreamBase}/${path}${url.search}`;

    try {
        const response = await fetch(target, {
            headers: {
                Accept: 'application/json',
                ...requestHeaders,
            },
        });

        return new Response(await response.text(), {
            status: response.status,
            headers: buildJsonHeaders(responseHeaders),
        });
    } catch {
        return new Response(JSON.stringify({ error: 'Upstream request failed' }), {
            status: 502,
            headers: buildJsonHeaders(),
        });
    }
}
