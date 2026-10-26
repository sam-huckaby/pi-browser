/** Fixed diagnostics only: never forward third-party exception messages or causes. */
const messages = {
  PLUGIN_CANCELED: "Browser plugin operation canceled.",
  PLUGIN_DECLINED: "Server startup was not approved.",
  PLUGIN_OPTIONS: "Invalid plugin options. Check the companion's help; never pass credentials.",
  PLUGIN_GRAPHICS: "Use fullscreen Pi with Kitty graphics enabled.",
  PLUGIN_CHECKOUT: "The application checkout is missing or unsupported. Check the companion's checkout configuration and required scripts.",
  PLUGIN_ENVIRONMENT: "Stop the plugin-owned server before switching environment or checkout.",
  PLUGIN_EXECUTABLE: "The server launcher was not found or could not run. Check the companion's package manager on Pi's PATH.",
  PLUGIN_STARTUP_EXIT: "The local dev server exited before it was ready. Check local dependencies and authentication.",
  PLUGIN_STARTUP_TIMEOUT: "Local server startup timed out. Check authentication and the reported startup phase.",
  PLUGIN_STARTUP: "The local application failed to start. Check dependencies and authentication; raw logs are withheld.",
  PLUGIN_NOT_READY: "No Vite dev server was ready at the supplied loopback origin.",
  PLUGIN_TLS_DATE: "Chromium rejected the server certificate's dates. Check the system clock; renew expired local certificates and restart the server so it serves the renewed certificate.",
  PLUGIN_TLS_TRUST: "Chromium does not trust the server certificate. Check local development certificate installation; TLS validation has not been disabled.",
  PLUGIN_BROWSER: "Chromium could not launch. Run npm run browser:install in pi-browser and check system dependencies.",
  PLUGIN_INSPECTION: "Inspection failed. Check fullscreen graphics, local setup, and authentication; no page output was shared.",
} as const;
export type BrowserPluginErrorCode = keyof typeof messages;
export class BrowserPluginError extends Error {
  constructor(readonly code: BrowserPluginErrorCode) { super(`[${code}] ${messages[code]}`); this.name = "BrowserPluginError"; }
}
export function browserPluginFailure(error: unknown, fallback: BrowserPluginErrorCode = "PLUGIN_INSPECTION"): BrowserPluginError {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && Object.hasOwn(messages, error.code)) {
    // Identity is deliberately not required: independent SDK copies share codes.
    return new BrowserPluginError(error.code as BrowserPluginErrorCode);
  }
  const text = error instanceof Error ? error.message : "";
  if (/net::ERR_CERT_DATE_INVALID/u.test(text)) return new BrowserPluginError("PLUGIN_TLS_DATE");
  if (/net::ERR_CERT_(?:AUTHORITY_INVALID|COMMON_NAME_INVALID|INVALID)/u.test(text)) return new BrowserPluginError("PLUGIN_TLS_TRUST");
  if (/Unable to launch Chromium|Executable doesn't exist/u.test(text)) return new BrowserPluginError("PLUGIN_BROWSER");
  if (/needs fullscreen mode|needs Kitty graphics|requires interactive Pi in fullscreen/u.test(text)) return new BrowserPluginError("PLUGIN_GRAPHICS");
  return new BrowserPluginError(fallback);
}
