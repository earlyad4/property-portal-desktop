function endpoint(name, configured, developmentFallback, protocol) {
  const value = configured || (import.meta.env.DEV ? developmentFallback : "");
  if (!value) throw new Error(`${name} is missing; production builds do not fall back to localhost`);
  const url = new URL(value);
  if (import.meta.env.PROD) {
    if (url.protocol !== protocol) throw new Error(`${name} must use ${protocol} in production`);
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error(`${name} cannot use localhost in production`);
  }
  return url.origin;
}

export const API_BASE = endpoint("VITE_API_BASE", import.meta.env.VITE_API_BASE, "http://localhost:4317", "https:");
export const WS_BASE = endpoint("VITE_WS_BASE", import.meta.env.VITE_WS_BASE, "ws://localhost:4317", "wss:");
export const CLIENT_RELEASE_ID = import.meta.env.VITE_RELEASE_ID || "development-local";

