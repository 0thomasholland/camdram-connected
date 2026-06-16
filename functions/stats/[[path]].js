// Cloudflare Pages Function: proxy page view counters
// Proxies requests from /stats/* to GoatCounter counter endpoints.

const COUNTER_BASE = 'https://camdramconnected.goatcounter.com/counter';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
    return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
    const { params } = context;
    const path = params.path.join('/');

    if (!path.endsWith('.json')) {
        return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }

    const url = new URL(context.request.url);
    const target = `${COUNTER_BASE}/${path}${url.search}`;

    try {
        const resp = await fetch(target, {
            headers: {
                'Accept': 'application/json',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
            },
        });

        const body = await resp.text();
        return new Response(body, {
            status: resp.status,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                ...CORS_HEADERS,
            },
        });
    } catch {
        return new Response(JSON.stringify({ error: 'Upstream request failed' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
    }
}
