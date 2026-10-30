/** Compare against the public CRM origin, which can differ from the internal
 * HTTP URL supplied to Next.js by Render's TLS-terminating reverse proxy. */
export function isZaloAccountOriginAllowed(request: Request) {
  const origin = request.headers.get('origin');
  const configured = process.env.ZALO_ACCOUNT_CRM_ORIGIN || process.env.WEBSITE_ORIGIN || request.url;
  try { return Boolean(origin && origin === new URL(configured).origin); }
  catch { return false; }
}
