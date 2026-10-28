const values = {
  VITE_API_BASE: process.env.VITE_API_BASE,
  VITE_WS_BASE: process.env.VITE_WS_BASE,
  VITE_RELEASE_ID: process.env.VITE_RELEASE_ID,
};

function validate(name, value, protocol) {
  if (!value) throw new Error(`${name} is required for a release build`);
  const url = new URL(value);
  if (url.protocol !== protocol) throw new Error(`${name} must use ${protocol}`);
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error(`${name} must not point to localhost`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must be a clean service origin without credentials, query, or fragment`);
  return url.origin;
}

validate("VITE_API_BASE", values.VITE_API_BASE, "https:");
validate("VITE_WS_BASE", values.VITE_WS_BASE, "wss:");
if (!values.VITE_RELEASE_ID || !/^[a-zA-Z0-9._+-]{5,128}$/.test(values.VITE_RELEASE_ID)) {
  throw new Error("VITE_RELEASE_ID must be an immutable release identifier");
}
console.log("Desktop release endpoint validation passed.");

