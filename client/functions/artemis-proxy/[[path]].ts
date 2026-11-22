/*  Cloudflare Pages Function: CORS proxy for the Artemis instructor exercise export only.
    Request shape: GET /artemis-proxy/<host>/api/programming/programming-exercises/<id>/export-instructor-exercise
    Env: ALLOWED_ORIGINS (comma list, besides the own origin), ALLOWED_ARTEMIS_HOSTS (optional comma list)  */

import { corsHeaders, isValidHost, joinPath, list, relay, type Context } from '../../functions-shared/proxy';

const FORWARDED_REQUEST_HEADERS = [ 'authorization' ];
const EXPOSED_RESPONSE_HEADERS = [ 'content-type', 'content-length', 'filename' ];
const EXPORT_PATH = /^\/api\/programming\/programming-exercises\/\d+\/export-instructor-exercise$/;

export async function onRequest({ request, env, params }: Context): Promise<Response> {
  const headers = corsHeaders(request, env, FORWARDED_REQUEST_HEADERS, EXPOSED_RESPONSE_HEADERS);
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers });

  const path = joinPath(params.path);
  const slash = path.indexOf('/');
  const host = slash > 0 ? path.slice(0, slash) : '';
  const apiPath = slash > 0 ? path.slice(slash) : '';
  const allowedHosts = list(env.ALLOWED_ARTEMIS_HOSTS);
  if (request.method !== 'GET' || !isValidHost(host) || !EXPORT_PATH.test(apiPath)
    || (allowedHosts.length > 0 && !allowedHosts.includes(host)))
    return new Response('Forbidden: only Artemis exercise exports are proxied', { status: 403, headers });

  const authorization = request.headers.get('authorization');
  const upstream = await fetch(`https://${host}${apiPath}`, {
    headers: authorization ? { authorization } : {},
    redirect: 'manual',
  });
  return relay(upstream, headers, EXPOSED_RESPONSE_HEADERS);
}
