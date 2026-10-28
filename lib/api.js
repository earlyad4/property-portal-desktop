// PropertyPortal desktop API client. All server calls go through here.
// Auth = bearer JWT issued by POST /api/auth/admin/login.

import { API_BASE, WS_BASE, CLIENT_RELEASE_ID } from "./endpoints";

let authToken = null;
let pendingRequests = 0;
const tokenListeners = new Set();

export function setAuthToken(token) {
  authToken = token || null;
  for (const fn of tokenListeners) fn(authToken);
}

export function getAuthToken() {
  return authToken;
}

export function getPendingRequestCount() {
  return pendingRequests;
}

export function onAuthTokenChange(fn) {
  tokenListeners.add(fn);
  return () => tokenListeners.delete(fn);
}

export function apiBase() {
  return API_BASE;
}

export function wsBase() {
  return WS_BASE;
}

async function request(method, path, { body, query, headers = {}, raw = false } = {}) {
  pendingRequests += 1;
  try {
  const url = new URL(API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.append(k, String(v));
    }
  }
  const finalHeaders = { Accept: "application/json", "X-Property-Portal-Client": "desktop", "X-Property-Portal-Version": CLIENT_RELEASE_ID, ...headers };
  if (body !== undefined && !(body instanceof FormData)) {
    finalHeaders["Content-Type"] = "application/json";
  }
  if (authToken) {
    finalHeaders["Authorization"] = `Bearer ${authToken}`;
  }

  let res;
  try {
    res = await fetch(url.toString(), {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  if (raw) return res;

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await res.json().catch(() => ({})) : await res.text();

  if (!res.ok) {
    const message = (isJson && payload && (payload.error || payload.message)) || `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return payload;
  } finally {
    pendingRequests = Math.max(0, pendingRequests - 1);
  }
}

export const api = {
  adminLogin: (email, password) =>
    request("POST", "/api/auth/admin/login", { body: { email, password } }),
  adminMe: () =>
    request("GET", "/api/auth/admin/me").then((r) => r.admin || r),
  adminChangePassword: (currentPassword, newPassword) =>
    request("POST", "/api/auth/admin/change-password", { body: { currentPassword, newPassword } }),

  operationsHealth: () =>
    request("GET", "/api/operations/health"),
  createBackup: () =>
    request("POST", "/api/operations/backups"),
  testOperationsAlert: () =>
    request("POST", "/api/operations/alerts/test"),
  listOperationsAlerts: (limit = 25) =>
    request("GET", "/api/operations/alerts", { query: { limit } }).then((r) => r.alerts || []),
  acknowledgeOperationsAlert: (id, note) =>
    request("POST", `/api/operations/alerts/${id}/acknowledge`, { body: { note } }).then((r) => r.alert),

  stats: () =>
    request("GET", "/api/dashboard/stats"),

  listBuildings: () =>
    request("GET", "/api/dashboard/buildings").then((r) => r.buildings || []),
  createBuilding: (payload) =>
    request("POST", "/api/dashboard/buildings", { body: payload }).then((r) => r.building),
  updateBuilding: (id, payload) =>
    request("PATCH", `/api/dashboard/buildings/${id}`, { body: payload }).then((r) => r.building),
  deleteBuilding: (id) =>
    request("DELETE", `/api/dashboard/buildings/${id}`),
  broadcastToBuilding: (id, payload) =>
    request("POST", `/api/dashboard/buildings/${id}/broadcast`, { body: payload }),

  listTechnicians: () =>
    request("GET", "/api/dashboard/technicians").then((r) => r.technicians || []),
  createTechnician: (payload) =>
    request("POST", "/api/dashboard/technicians", { body: payload }).then((r) => r.technician),
  updateTechnician: (id, payload) =>
    request("PATCH", `/api/dashboard/technicians/${id}`, { body: payload }).then((r) => r.technician),
  deleteTechnician: (id) =>
    request("DELETE", `/api/dashboard/technicians/${id}`),

  listTenants: (query) =>
    request("GET", "/api/dashboard/tenants", { query }).then((r) => r.tenants || []),
  getTenant: (id) =>
    request("GET", `/api/dashboard/tenants/${id}`),
  updateTenant: (id, payload) =>
    request("PATCH", `/api/dashboard/tenants/${id}`, { body: payload }).then((r) => r.tenant),
  deleteTenant: (id) =>
    request("DELETE", `/api/dashboard/tenants/${id}`),

  listTickets: (query) =>
    request("GET", "/api/dashboard/tickets", { query }).then((r) => r.tickets || []),
  getTicket: (id) =>
    request("GET", `/api/dashboard/tickets/${id}`).then((r) => r.request),
  updateTicket: (id, payload) =>
    request("PATCH", `/api/dashboard/tickets/${id}`, { body: payload }).then((r) => r.request),
  sendTicketMessage: (id, payload) =>
    request("POST", `/api/dashboard/tickets/${id}/messages`, { body: payload }).then((r) => r.request),

  listQualityReports: () =>
    request("GET", "/api/dashboard/quality-reports").then((r) => r.reports || r.qualityReports || r.data || []),
  listDocuments: (query) =>
    request("GET", "/api/dashboard/documents", { query }).then((r) => r.documents || []),

  maintenanceAnalytics: (query) =>
    request("GET", "/api/dashboard/analytics/maintenance", { query }),

  async exportFile(kind, format, query = {}) {
    const qs = new URLSearchParams({ format, ...query }).toString();
    const res = await request("GET", `/api/dashboard/exports/${kind}?${qs}`, { raw: true });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        message = j.error || j.message || message;
      } catch {}
      throw new Error(message);
    }
    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") || "";
    let filename = `property-portal-${kind.replace(/\//g, "-")}.${format === "xlsx" ? "xlsx" : "pdf"}`;
    const match = /filename="?([^";]+)"?/.exec(disposition);
    if (match) filename = match[1];
    return { blob, filename, mime: res.headers.get("content-type") || "application/octet-stream" };
  },
};

export function openAdminSocket(token, { onMessage, onOpen, onClose, onError } = {}) {
  const ws = new WebSocket(`${WS_BASE}/ws`);
  let alive = true;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "auth", kind: "admin", token }));
    onOpen?.();
  });
  ws.addEventListener("message", (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      onMessage?.(msg);
    } catch (err) {
      console.warn("bad ws message", err);
    }
  });
  ws.addEventListener("close", () => {
    alive = false;
    onClose?.();
  });
  ws.addEventListener("error", (err) => onError?.(err));

  return {
    socket: ws,
    subscribe(room) {
      if (!alive) return;
      const send = () => ws.send(JSON.stringify({ type: "subscribe", room }));
      ws.readyState === 1 ? send() : ws.addEventListener("open", send, { once: true });
    },
    unsubscribe(room) {
      if (!alive) return;
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "unsubscribe", room }));
    },
    close() {
      alive = false;
      try { ws.close(); } catch {}
    },
  };
}

export async function secureSetToken(token) {
  const desk = window.propertyPortalDesktop;
  return desk?.secureToken?.set?.(token) || false;
}

export async function secureGetToken() {
  const desk = window.propertyPortalDesktop;
  return desk?.secureToken?.get?.() || null;
}

export async function secureSetRememberedEmail(email) {
  const desk = window.propertyPortalDesktop;
  return desk?.rememberedEmail?.set?.(email || "") || false;
}

export async function secureGetRememberedEmail() {
  const desk = window.propertyPortalDesktop;
  return desk?.rememberedEmail?.get?.() || null;
}

export async function secureClear() {
  const desk = window.propertyPortalDesktop;
  return desk?.clearSecureSession?.() || false;
}

export async function saveBlobViaOs(blob, filename, mime) {
  const desk = window.propertyPortalDesktop;
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  if (desk?.saveExport) {
    const result = await desk.saveExport({ defaultName: filename,  base64, mime });
    return result;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { saved: true };
}
