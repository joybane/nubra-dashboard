// ─────────────────────────────────────────────────────────────────────────────
// Which browser origins may script this server.
//
// Nothing here authenticates the *caller*: `requireAuth` asks whether the server holds a broker
// session, not who is asking. So any page that can issue a cross-origin request with the browser's
// blessing can place paper orders and read the account through the Nubra proxy. CORS is therefore
// the access control, not a convenience header — which is why this lives in its own module with
// tests rather than as a literal inside the composition root.
// ─────────────────────────────────────────────────────────────────────────────

/** Ports the app itself is served from during development. */
const DEV_PORTS = [8000, 5173];

export interface CorsPolicyOptions {
  /** The port this server listens on — the built SPA is served from it. */
  port: number;
  /** Extra origins from CORS_ORIGINS, comma separated. Blank entries are ignored. */
  extra?: string;
}

/**
 * Build the allow-list: this server's own origin, the Vite dev origins, plus anything the
 * operator named explicitly. Both `localhost` and `127.0.0.1` spellings are included because a
 * browser treats them as different origins and users type either one.
 */
export function buildAllowedOrigins({ port, extra }: CorsPolicyOptions): Set<string> {
  const origins = new Set<string>();
  for (const p of [port, ...DEV_PORTS]) {
    origins.add(`http://localhost:${p}`);
    origins.add(`http://127.0.0.1:${p}`);
  }
  for (const o of (extra || '').split(',')) {
    const trimmed = o.trim();
    if (trimmed) origins.add(trimmed);
  }
  return origins;
}

/**
 * Decide one request's origin.
 *
 * A missing Origin is allowed on purpose, and is not the hole it looks like: browsers always send
 * one on a cross-origin request, so the blank case is a same-origin navigation, a non-browser
 * client like curl, or a server-to-server call — none of which CORS governs, and all of which
 * were already reaching this server before. What changed is that a *named* origin now has to be
 * on the list instead of being reflected back whatever it claimed to be.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: Set<string>): boolean {
  if (!origin) return true;
  return allowed.has(origin);
}
