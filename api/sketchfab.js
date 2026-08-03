/* ============================================================================
   SKETCHFAB PROXY  —  optional, for public deploys

   Runs as a serverless function (Vercel / Netlify both route `/api/*` here).
   It forwards exactly two Sketchfab endpoints and adds the Authorization
   header on the server, so SKETCHFAB_TOKEN never reaches a browser.

   Turn it on by setting, in your hosting provider's environment:

     SKETCHFAB_TOKEN=<your token>       server-side, secret
     VITE_SKETCHFAB_PROXY=1             build-time, tells the client to use it

   The final .glb lives on a pre-signed URL that /download hands back; the
   browser fetches that itself, so multi-megabyte model data never passes
   through the function.
   ========================================================================== */

const API = 'https://api.sketchfab.com/v3';

/** Only these two paths are forwarded — this is not an open relay. */
const ALLOWED = [
  /^\/search$/,
  /^\/models\/[A-Za-z0-9]+\/download$/
];

export default async function handler(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/^\/api\/sketchfab/, '') || '/';

  if (!ALLOWED.some((re) => re.test(path))) {
    return json(response, 404, { error: 'Not a proxied endpoint' });
  }

  const token = process.env.SKETCHFAB_TOKEN;
  if (!token) {
    return json(response, 503, {
      error: 'This deployment has no Sketchfab token. Add SKETCHFAB_TOKEN, or paste your own token into the app.'
    });
  }

  try {
    const upstream = await fetch(API + path + url.search, {
      headers: { Authorization: `Token ${token}` }
    });
    const body = await upstream.text();
    response.statusCode = upstream.status;
    response.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    // Search results are the same for everyone; let the edge hold them briefly.
    if (path === '/search' && upstream.ok) {
      response.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
    }
    return response.end(body);
  } catch (error) {
    return json(response, 502, { error: `Could not reach Sketchfab: ${error.message}` });
  }
}

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}
