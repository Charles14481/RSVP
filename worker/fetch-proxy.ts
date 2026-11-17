/**
 * The URL fetch proxy as a Cloudflare Worker. Deploy with wrangler (see
 * wrangler.toml), set ALLOWED_ORIGINS to the reader's origin(s), and build the
 * app with VITE_FETCH_PROXY_URL=https://<worker>/api/fetch.
 *
 * Workers cannot reach private networks, so no DNS check is needed here; the
 * handler still rejects private and local hosts by name and address literal.
 */
import { handleFetch } from '../server/fetchProxy';

interface Env {
  /** Comma-separated list, e.g. "https://reader.example,http://localhost:5173". */
  ALLOWED_ORIGINS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/api/fetch' && path !== '/') return new Response('Not found', { status: 404 });
    const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return handleFetch(request, { allowedOrigins });
  },
};
