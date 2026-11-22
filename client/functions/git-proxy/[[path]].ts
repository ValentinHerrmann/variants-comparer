/*  Cloudflare Pages Function: minimal CORS proxy for read-only Git smart-HTTP (clone/fetch).
    Request shape (isomorphic-git corsProxy): /git-proxy/<host>/<repo-path>/(info/refs|git-upload-pack)
    Env: ALLOWED_ORIGINS (comma list, besides the own origin), ALLOWED_GIT_HOSTS (optional comma list)  */

import { corsHeaders, isValidHost, joinPath, list, relay, type Context } from '../../functions-shared/proxy';

const FORWARDED_REQUEST_HEADERS = [ 'accept', 'authorization', 'content-type', 'git-protocol' ];
const EXPOSED_RESPONSE_HEADERS = [ 'content-type', 'content-length', 'cache-control', 'etag', 'x-redirected-url' ];

/*  Only allow the two read-only smart-HTTP endpoints, so this is no general-purpose open proxy  */
function isGitRequest(request: Request, path: string, search: URLSearchParams) {
  if (request.method === 'GET')
    return path.endsWith('/info/refs') && search.get('service') === 'git-upload-pack';
  if (request.method === 'POST')
    return path.endsWith('/git-upload-pack')
      && request.headers.get('content-type') === 'application/x-git-upload-pack-request';
  return false;
}

export async function onRequest({ request, env, params }: Context): Promise<Response> {
  const headers = corsHeaders(request, env, FORWARDED_REQUEST_HEADERS, EXPOSED_RESPONSE_HEADERS);
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers });

  const path = joinPath(params.path);
  const { search, searchParams } = new URL(request.url);
  const host = path.split('/')[0] ?? '';
  const allowedHosts = list(env.ALLOWED_GIT_HOSTS);
  if (!isValidHost(host) || !isGitRequest(request, path, searchParams)
    || (allowedHosts.length > 0 && !allowedHosts.includes(host)))
    return new Response('Forbidden: only Git clone/fetch requests are proxied', { status: 403, headers });

  const upstreamHeaders = new Headers({ 'user-agent': 'git/variants-comparer-proxy' });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value)
      upstreamHeaders.set(name, value);
  }

  const upstream = await fetch(`https://${path}${search}`, {
    method: request.method,
    headers: upstreamHeaders,
    body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
    redirect: 'follow',
  });
  if (upstream.redirected)
    headers.set('x-redirected-url', upstream.url);
  return relay(upstream, headers, EXPOSED_RESPONSE_HEADERS);
}
