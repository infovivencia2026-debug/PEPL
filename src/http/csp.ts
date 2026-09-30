/**
 * Content-Security-Policy for the app and the operator console.
 *
 * Written for what the frontend actually loads, not copied from a template:
 *
 *   script-src 'self'   the built pages have no inline script, so no 'unsafe-inline' and no nonce
 *                       machinery is needed -- and script injection cannot run
 *   style-src           React sets style="" attributes, which only 'unsafe-inline' permits; the
 *                       risk of injected CSS is far smaller than injected script. Google Fonts CSS.
 *   font-src            the font files themselves come from fonts.gstatic.com
 *   img-src             data: for QR codes and inline SVG, blob: for previews; NO remote images,
 *                       which is also what stops a received email from phoning home with a pixel
 *   connect-src 'self'  fetch, XHR and the event stream, all same-origin -- an injected script
 *                       has nowhere to send what it reads
 *   frame-src           the OpenStreetMap preview in the geofence editor; sandboxed srcdoc frames
 *                       (mail, announcements) are not fetched and are unaffected
 *   frame-ancestors     nobody may frame this app (the modern spelling of X-Frame-Options: DENY)
 *   base-uri, form-action, object-src   close the three classic escape hatches
 *
 * Third parties are named individually and a test fails on an unlisted host: a policy that
 * grows a wildcard stops being one.
 */
const DIRECTIVES: Record<string, readonly string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ["'self'", 'https://fonts.gstatic.com'],
  'img-src': ["'self'", 'data:', 'blob:'],
  'connect-src': ["'self'"],
  'frame-src': ["'self'", 'https://www.openstreetmap.org'],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'object-src': ["'none'"],
}

export const directives = (): Record<string, readonly string[]> => DIRECTIVES

export const CONTENT_SECURITY_POLICY: string = Object.entries(DIRECTIVES)
  .map(([name, sources]) => `${name} ${sources.join(' ')}`)
  .join('; ')
