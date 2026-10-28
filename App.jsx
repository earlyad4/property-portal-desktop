import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  setAuthToken,
  openAdminSocket,
  secureSetToken,
  secureGetToken,
  secureSetRememberedEmail,
  secureGetRememberedEmail,
  secureClear,
  saveBlobViaOs,
  getPendingRequestCount,
} from "./lib/api.js";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, Legend,
  LineChart, Line, PieChart, Pie, Cell, ResponsiveContainer,
} from "recharts";

const BRAND = "#8C1C13";
const BRAND_DEEP = "#6F1610";
const BRAND_SOFT = "#F6E6E3";
const CHART_COLORS = [BRAND, "#C65E55", "#E89B91", "#B57A13", "#2F7D57", "#2C5EA8", "#5A4845"];
const IDLE_LOCK_MS = 15 * 60 * 1000;

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDateOnly(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
function fmtDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "—";
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  if (["resolved", "closed", "completed", "done"].includes(s)) return { cls: "green", label: status };
  if (["in_progress", "assigned", "acknowledged"].includes(s)) return { cls: "blue", label: status };
  if (["pending", "open", "new"].includes(s)) return { cls: "amber", label: status };
  if (["urgent", "critical", "escalated"].includes(s)) return { cls: "red", label: status };
  return { cls: "gray", label: status || "—" };
}
function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((message, kind = "info") => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 3200);
  }, []);
  const node = toast ? <div className={`toast ${toast.kind === "error" ? "error" : ""}`}>{toast.message}</div> : null;
  return { show, node };
}

// -----------------------------------------------------------------------------
// Login screen
// -----------------------------------------------------------------------------

function LoginScreen({ onLoggedIn, toast }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    secureGetRememberedEmail().then((v) => { if (v) setEmail(v); });
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.adminLogin(email.trim(), password);
      if (!res?.token) throw new Error("No token returned");
      setAuthToken(res.token);
      await secureSetToken(res.token);
      await secureSetRememberedEmail(remember ? email.trim() : "");
      onLoggedIn(res);
    } catch (err) {
      setError(err.message || "Login failed");
      toast?.show(err.message || "Login failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <div className="login-brand-mark">P</div>
          <div>
            <h1>PropertyPortal Admin</h1>
            <p>Property operations console</p>
          </div>
        </div>

        <label>Email</label>
        <input type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="operator@example.com" />

        <label>Password</label>
        <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontWeight: 400 }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ width: "auto" }} />
          <span>Remember my email</span>
        </label>

        {error && <div className="login-error">{error}</div>}

        <button className="login-submit" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>

        <p className="login-hint">
          New install? Set <code>OPERATOR_BOOTSTRAP_PASSWORD</code> in <code>server/.env</code> and run <code>npm run bootstrap-admin</code>
          from the <code>server</code> folder to create the first admin, then sign in here.
        </p>
      </form>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Shell
// -----------------------------------------------------------------------------

const NAV_OPERATIONAL = [
  { id: "overview", label: "Overview" },
  { id: "tickets", label: "Tickets" },
  { id: "buildings", label: "Buildings" },
  { id: "tenants", label: "Tenants" },
  { id: "technicians", label: "Technicians" },
  { id: "quality", label: "Quality reports" },
  { id: "documents", label: "Documents" },
  { id: "chat", label: "Chat" },
];
const NAV_ANALYTICAL = [
  { id: "analytics-maintenance", label: "Maintenance report" },
  { id: "analytics-volume", label: "Ticket volume" },
  { id: "analytics-technicians", label: "Technician load" },
];

function Shell({ session, onLogout, toast }) {
  const [view, setView] = useState("overview");
  const [socketRef, setSocketRef] = useState(null);
  const [wsEvents, setWsEvents] = useState(0); // tick counter

  // Idle auto-lock
  const lastActivity = useRef(Date.now());
  useEffect(() => {
    const bump = () => { lastActivity.current = Date.now(); };
    ["mousemove", "keydown", "click", "focus"].forEach((e) => window.addEventListener(e, bump));
    const t = setInterval(() => {
      if (Date.now() - lastActivity.current > IDLE_LOCK_MS) {
        onLogout("idle");
      }
    }, 30000);
    return () => {
      ["mousemove", "keydown", "click", "focus"].forEach((e) => window.removeEventListener(e, bump));
      clearInterval(t);
    };
  }, [onLogout]);

  useEffect(() => {
    const off = window.propertyPortalDesktop?.onSessionLock?.(() => onLogout("locked"));
    return () => off && off();
  }, [onLogout]);

  // Admin WebSocket
  useEffect(() => {
    const token = session?.token;
    if (!token) return;
    const sock = openAdminSocket(token, {
      onMessage: () => setWsEvents((n) => n + 1),
      onClose: () => setSocketRef(null),
      onError: (err) => console.warn("ws error", err),
    });
    setSocketRef(sock);
    return () => sock.close();
  }, [session?.token]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="mark">P</div>
          <div>
            <h1>PropertyPortal</h1>
            <p>{session?.admin?.name || "Admin console"}</p>
          </div>
        </div>
        <nav className="sidebar-nav">
          <div className="section-label">Operational</div>
          {NAV_OPERATIONAL.map((n) => (
            <button key={n.id} className={view === n.id ? "active" : ""} onClick={() => setView(n.id)}>{n.label}</button>
          ))}
          <div className="section-label">Analytical</div>
          {NAV_ANALYTICAL.map((n) => (
            <button key={n.id} className={view === n.id ? "active" : ""} onClick={() => setView(n.id)}>{n.label}</button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            className={`settings-button ${view === "operations" ? "active" : ""}`}
            onClick={() => setView("operations")}
            aria-label="Open system health and settings"
            title="System health and settings"
          >
            <span aria-hidden="true">⚙</span>
            <span>System health</span>
          </button>
          <div>Signed in as</div>
          <div style={{ color: "#fff", fontWeight: 600 }}>{session?.admin?.email}</div>
          <button onClick={() => onLogout("manual")}>Sign out</button>
        </div>
      </aside>

      <main className="main">
        {view === "overview" && <OverviewView wsTick={wsEvents} toast={toast} />}
        {view === "tickets" && <TicketsView wsTick={wsEvents} toast={toast} socket={socketRef} />}
        {view === "buildings" && <BuildingsView toast={toast} />}
        {view === "tenants" && <TenantsView toast={toast} />}
        {view === "technicians" && <TechniciansView toast={toast} />}
        {view === "quality" && <QualityView toast={toast} />}
        {view === "documents" && <DocumentsView toast={toast} />}
        {view === "chat" && <ChatView socket={socketRef} wsTick={wsEvents} toast={toast} session={session} />}
        {view === "analytics-maintenance" && <MaintenanceAnalyticsView toast={toast} />}
        {view === "analytics-volume" && <TicketVolumeView toast={toast} />}
        {view === "analytics-technicians" && <TechnicianLoadView toast={toast} />}
        {view === "operations" && <OperationsHealthView toast={toast} />}
      </main>
    </div>
  );
}

// -----------------------------------------------------------------------------
// System health and operations
// -----------------------------------------------------------------------------

function HealthBadge({ ok, label }) {
  return <span className={`badge ${ok ? "green" : "red"}`}>{label || (ok ? "Available" : "Unavailable")}</span>;
}

function OperationsHealthView({ toast }) {
  const [report, setReport] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [action, setAction] = useState(null);
  const [alerts, setAlerts] = useState([]);

  const load = useCallback(async ({ quiet = false } = {}) => {
    const started = performance.now();
    if (!quiet) setLoading(true);
    try {
      const [next, recentAlerts] = await Promise.all([api.operationsHealth(), api.listOperationsAlerts(25)]);
      next.desktop = {
        online: navigator.onLine,
        apiRoundTripMs: Math.round(performance.now() - started),
      };
      setReport(next);
      setAlerts(recentAlerts);
      setError(null);
    } catch (err) {
      setError(err.message || "Unable to load system health");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    window.propertyPortalDesktop?.getAppInfo?.().then(setAppInfo).catch(() => {});
    load();
    const timer = window.setInterval(() => load({ quiet: true }), 30000);
    const online = () => load({ quiet: true });
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
    };
  }, [load]);

  async function runAction(name, work, success) {
    setAction(name);
    try {
      await work();
      toast.show(success);
      await load({ quiet: true });
    } catch (err) {
      toast.show(err.message || `${name} failed`, "error");
    } finally {
      setAction(null);
    }
  }

  if (loading && !report) return <div className="card"><div className="skeleton" /><div className="skeleton" style={{ marginTop: 12 }} /></div>;

  const serviceRows = report ? Object.entries(report.services || {}) : [];
  const statusOk = report?.status === "healthy";
  const statusLabel = report?.status === "healthy" ? "Healthy" : report?.status === "degraded" ? "Degraded" : "Unhealthy";
  const mobileReachable = Boolean(report?.ready && report?.services?.database?.ok);

  return (
    <>
      <div className="topbar">
        <div>
          <h2>System health</h2>
          <div className="meta">Live operational status for this desktop, the PropertyPortal API, Supabase, backups, and mobile-facing services.</div>
        </div>
        <div className="actions">
          <span className={`health-live-dot ${statusOk ? "ok" : report?.ready ? "warn" : "bad"}`} aria-hidden="true" />
          <HealthBadge ok={statusOk} label={statusLabel} />
          <button className="btn secondary" onClick={() => load()} disabled={loading}>{loading ? "Checking…" : "Refresh now"}</button>
        </div>
      </div>

      {error && <div className="health-alert"><strong>Health data unavailable.</strong> {error}. Check this computer’s network and the configured API address.</div>}

      {report && (
        <>
          <div className="grid cols-4">
            <div className="card stat-card"><div className="label">Server readiness</div><div className="value"><HealthBadge ok={report.ready} /></div><div className="sub">Checked {fmtDate(report.checkedAt)}</div></div>
            <div className="card stat-card"><div className="label">This desktop</div><div className="value"><HealthBadge ok={report.desktop?.online} label={report.desktop?.online ? "Online" : "Offline"} /></div><div className="sub">API round trip {report.desktop?.apiRoundTripMs ?? "—"} ms</div></div>
            <div className="card stat-card"><div className="label">Mobile API</div><div className="value"><HealthBadge ok={mobileReachable} label={mobileReachable ? "Reachable" : "Impaired"} /></div><div className="sub">This measures shared API readiness, not individual phones.</div></div>
            <div className="card stat-card"><div className="label">Latest backup</div><div className="value" style={{ fontSize: 18 }}>{report.backup?.lastSuccessAt ? fmtDate(report.backup.lastSuccessAt) : "No verified backup"}</div><div className="sub">{report.backup?.lastSnapshotId || "Backup evidence unavailable"}</div></div>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h3>Dependency checks</h3>
              <table className="table health-table">
                <thead><tr><th>Service</th><th>Status</th><th>Latency</th><th>Relevant detail</th></tr></thead>
                <tbody>
                  {serviceRows.map(([name, service]) => (
                    <tr key={name}>
                      <td>{({ database: "Supabase database", storage: "Supabase Storage", localBackup: "Local recovery share", certificate: "TLS certificate" })[name] || name}</td>
                      <td><HealthBadge ok={service.ok} /></td>
                      <td>{service.latencyMs ?? "—"} ms</td>
                      <td>{service.error || (name === "certificate" ? `${service.daysRemaining ?? "—"} days remaining` : name === "localBackup" ? `${fmtBytes(service.freeBytes)} free` : "Responding normally")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h3>Release and runtime</h3>
              <div className="kv">
                <div className="k">Environment</div><div>{report.environment}</div>
                <div className="k">Server release</div><div><code>{report.releaseId}</code></div>
                <div className="k">Desktop release</div><div><code>{appInfo?.version || "unavailable"}</code></div>
                <div className="k">Server uptime</div><div>{fmtDuration(report.uptimeSeconds)}</div>
                <div className="k">WebSocket clients</div><div>{report.realtime?.connectedClients ?? "—"}</div>
                <div className="k">Last push attempt</div><div>{report.mobile?.push?.lastAttemptAt ? fmtDate(report.mobile.push.lastAttemptAt) : "No push attempt in this server session"}</div>
                <div className="k">Push submission</div><div>{report.mobile?.push?.lastError ? `Error: ${report.mobile.push.lastError}` : `${report.mobile?.push?.accepted || 0} accepted / ${report.mobile?.push?.rejected || 0} rejected (last batch)`}</div>
                <div className="k">Server memory</div><div>{fmtBytes(report.resources?.process?.rss)}</div>
                <div className="k">System memory free</div><div>{fmtBytes(report.resources?.system?.freeMemoryBytes)}</div>
              </div>
            </div>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h3>API performance — last {report.metrics?.windowMinutes || 15} minutes</h3>
              <div className="grid cols-3">
                <div className="health-metric"><strong>{report.metrics?.requests ?? 0}</strong><span>requests</span></div>
                <div className="health-metric"><strong>{report.metrics?.errorRatePercent ?? 0}%</strong><span>server errors</span></div>
                <div className="health-metric"><strong>{report.metrics?.latencyMs?.p95 ?? 0} ms</strong><span>p95 latency</span></div>
              </div>
              <p className="meta">Metrics reset when the server restarts. Use external monitoring for long-term history.</p>
            </div>

            <div className="card">
              <h3>Backup and notification controls</h3>
              <div className="kv">
                <div className="k">Backup schedule</div><div>{report.backup?.enabled ? "Enabled" : "Not configured"}</div>
                <div className="k">Encryption</div><div>{report.backup?.encrypted ? "AES-256-GCM configured" : "Not configured"}</div>
                <div className="k">Local destination</div><div className="health-path">{report.backup?.localRoot || "—"}</div>
                <div className="k">Cloud mirror</div><div>{report.backup?.cloudBucket || "—"}</div>
                <div className="k">Last failure</div><div>{report.backup?.lastError || "None recorded"}</div>
                <div className="k">Alert delivery</div><div>{report.alerts?.configured ? (report.alerts?.ok === false ? `Failed: ${report.alerts.error}` : "Configured") : "Not configured"}</div>
              </div>
              <div className="toolbar" style={{ marginTop: 16 }}>
                <button className="btn primary" disabled={Boolean(action) || !report.backup?.enabled} onClick={() => runAction("backup", api.createBackup, "Encrypted local and cloud backup completed")}>{action === "backup" ? "Backing up…" : "Create backup now"}</button>
                <button className="btn secondary" disabled={Boolean(action) || !report.alerts?.configured} onClick={() => runAction("alert", api.testOperationsAlert, "Real operational test email queued to all four recipients")}>{action === "alert" ? "Sending real email…" : "Send real operational test alert"}</button>
              </div>
              <p className="meta">This sends a real Resend email to every configured operational recipient and records delivery status in SystemAlert.</p>
            </div>
          </div>

          <div className="card">
            <h3>Recent operational alerts and email delivery</h3>
            {alerts.length === 0 ? <div className="empty">No SystemAlert records are available.</div> : (
              <table className="table health-table">
                <thead><tr><th>Created</th><th>Incident</th><th>Severity</th><th>State</th><th>Email</th><th>Provider ID</th><th>Recipients</th></tr></thead>
                <tbody>{alerts.map((item) => (
                  <tr key={item.alert_id}>
                    <td>{fmtDate(item.sent_at || item.created_at)}</td>
                    <td><strong>{item.affected_component}</strong><div className="meta">{item.event_type}<br />{item.alert_id}</div></td>
                    <td>{item.severity}</td>
                    <td>{item.status}</td>
                    <td>{item.delivery_status}</td>
                    <td><code>{item.resend_email_id || "queued"}</code></td>
                    <td>{(item.recipients || []).join(", ")}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <p className="meta">Most recent test: {(() => { const test = alerts.find((item) => item.event_type === "notification-test"); return test ? `${test.delivery_status} at ${fmtDate(test.sent_at || test.created_at)}` : "No test recorded"; })()}</p>
          </div>

          <div className="card">
            <h3>Diagnosis and recommended action</h3>
            <div className="diagnosis-list">
              {(report.diagnosis || []).map((item, index) => (
                <div className="diagnosis-item" key={`${item.component}-${index}`}>
                  <div><strong>{item.component}</strong><span>{item.cause}</span></div>
                  <p>{item.action}</p>
                </div>
              ))}
            </div>
            <p className="meta">A green result confirms only the checks shown at the displayed time. It does not replace restore drills, external uptime monitoring, or mobile device crash reporting.</p>
          </div>
        </>
      )}
    </>
  );
}

// -----------------------------------------------------------------------------
// Overview
// -----------------------------------------------------------------------------

function OverviewView({ wsTick, toast }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setStats(await api.stats());
    } catch (err) {
      setError(err.message);
      toast.show(err.message, "error");
    }
  }, [toast]);

  useEffect(() => { load(); }, [load, wsTick]);

  if (error && !stats) return <div className="card">Failed to load stats: {error}</div>;
  if (!stats) return <LoadingCards count={4} />;

  const cards = [
    { label: "Buildings", value: stats.buildings ?? 0, sub: `${stats.tenants ?? 0} tenants` },
    { label: "Open tickets", value: stats.openTickets ?? 0, sub: `${stats.resolvedThisMonth ?? 0} resolved this month` },
    { label: "Technicians", value: stats.technicians ?? 0, sub: `${stats.activeTechnicians ?? 0} active` },
    { label: "Quality score", value: stats.qualityScore != null ? `${stats.qualityScore}/5` : "—", sub: `${stats.reviewsCount ?? 0} reviews` },
  ];

  return (
    <>
      <div className="topbar">
        <div>
          <h2>Overview</h2>
          <div className="meta">Live snapshot of operations. Updates automatically.</div>
        </div>
      </div>

      <div className="grid cols-4">
        {cards.map((c) => (
          <div className="card stat-card" key={c.label}>
            <div className="label">{c.label}</div>
            <div className="value">{c.value}</div>
            <div className="sub">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Recent tickets</h3>
          {Array.isArray(stats.recentTickets) && stats.recentTickets.length > 0 ? (
            <table className="table">
              <thead><tr><th>Ticket</th><th>Building</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>
                {stats.recentTickets.map((t) => {
                  const s = statusBadge(t.status);
                  return (
                    <tr key={t.id}>
                      <td><div style={{ fontWeight: 600 }}>{t.reference || t.id}</div><div className="meta">{t.title}</div></td>
                      <td>{t.buildingName || "—"}</td>
                      <td><span className={`badge ${s.cls}`}>{s.label}</span></td>
                      <td>{fmtDate(t.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <div className="empty">No tickets yet.</div>}
        </div>
        <div className="card">
          <h3>Recent broadcasts</h3>
          {Array.isArray(stats.recentBroadcasts) && stats.recentBroadcasts.length > 0 ? (
            <table className="table">
              <thead><tr><th>Building</th><th>Title</th><th>Sent</th></tr></thead>
              <tbody>
                {stats.recentBroadcasts.map((b) => (
                  <tr key={b.id}><td>{b.buildingName || "—"}</td><td>{b.title}</td><td>{fmtDate(b.createdAt)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty">No broadcasts sent yet.</div>}
        </div>
      </div>
    </>
  );
}

function LoadingCards({ count = 4 }) {
  return (
    <div className="grid cols-4">
      {Array.from({ length: count }).map((_, i) => <div className="card" key={i}><div className="skeleton" style={{ width: 80 }} /><div className="skeleton" style={{ width: 140, height: 28, marginTop: 10 }} /></div>)}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Export dropdown (PDF / Excel)
// -----------------------------------------------------------------------------

function ExportDropdown({ kind, query = {}, label = "Export", toast, disabled }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function download(format) {
    try {
      setBusy(true);
      setOpen(false);
      const { blob, filename, mime } = await api.exportFile(kind, format, query);
      const res = await saveBlobViaOs(blob, filename, mime);
      if (res?.saved) toast.show(`Saved ${filename}`);
    } catch (err) {
      toast.show(err.message || "Export failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dropdown" ref={ref}>
      <button className="btn secondary" onClick={() => setOpen((o) => !o)} disabled={disabled || busy}>
        {busy ? "Exporting…" : label} ▾
      </button>
      {open && (
        <div className="dropdown-menu">
          <button onClick={() => download("pdf")}>Export as PDF</button>
          <button onClick={() => download("xlsx")}>Export as Excel (.xlsx)</button>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tickets
// -----------------------------------------------------------------------------

function TicketsView({ wsTick, toast, socket }) {
  const [tickets, setTickets] = useState([]);
  const [filter, setFilter] = useState({ status: "", buildingId: "", q: "" });
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [buildings, setBuildings] = useState([]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [list, bs] = await Promise.all([api.listTickets(filter), api.listBuildings()]);
      setTickets(list);
      setBuildings(bs);
    } catch (err) {
      toast.show(err.message, "error");
    } finally {
      setLoading(false);
    }
  }, [filter, toast]);

  useEffect(() => { load(); }, [load, wsTick]);

  const selected = tickets.find((t) => t.id === selectedId) || null;

  return (
    <>
      <div className="topbar">
        <div>
          <h2>Tickets</h2>
          <div className="meta">Maintenance and community-admin requests.</div>
        </div>
        <div className="actions">
          <ExportDropdown kind="tickets" query={filter} label="Export tickets" toast={toast} />
        </div>
      </div>

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <input placeholder="Search title, reference, tenant…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} style={{ minWidth: 260 }} />
          <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
            <option value="">Any status</option>
            <option value="open">Open</option>
            <option value="assigned">Assigned</option>
            <option value="in_progress">In progress</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <select value={filter.buildingId} onChange={(e) => setFilter({ ...filter, buildingId: e.target.value })}>
            <option value="">All buildings</option>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <div className="spacer" />
          <button className="btn ghost" onClick={load}>Refresh</button>
        </div>

        {loading ? <div className="empty">Loading…</div> : tickets.length === 0 ? <div className="empty">No tickets match these filters.</div> : (
          <table className="table">
            <thead><tr><th>Ref</th><th>Title</th><th>Building</th><th>Tenant</th><th>Category</th><th>Status</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              {tickets.map((t) => {
                const s = statusBadge(t.status);
                return (
                  <tr key={t.id} className={selectedId === t.id ? "selected" : ""}>
                    <td style={{ fontWeight: 600 }}>{t.reference || t.id.slice(0,8)}</td>
                    <td>{t.title}<div className="meta">{t.unit ? `Unit ${t.unit}` : ""}</div></td>
                    <td>{t.buildingName || "—"}</td>
                    <td>{t.tenantName || "—"}</td>
                    <td>{t.category || "—"}</td>
                    <td><span className={`badge ${s.cls}`}>{s.label}</span></td>
                    <td>{fmtDate(t.updatedAt)}</td>
                    <td><button className="btn secondary" onClick={() => setSelectedId(t.id)}>Open</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <TicketDrawer ticket={selected} onClose={() => setSelectedId(null)} onUpdated={load} socket={socket} toast={toast} wsTick={wsTick} />
      )}
    </>
  );
}

function TicketDrawer({ ticket, onClose, onUpdated, socket, toast, wsTick }) {
  const [detail, setDetail] = useState(null);
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(ticket.status);
  const [technicianId, setTechnicianId] = useState(ticket.technicianId || "");
  const [technicians, setTechnicians] = useState([]);
  const scrollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [d, techs] = await Promise.all([api.getTicket(ticket.id), api.listTechnicians()]);
      setDetail(d);
      setTechnicians(techs);
      setStatus(d.status);
      setTechnicianId(d.technicianId || "");
    } catch (err) { toast.show(err.message, "error"); }
  }, [ticket.id, toast]);

  useEffect(() => { load(); }, [load, wsTick]);

  useEffect(() => {
    if (!socket) return;
    socket.subscribe(`ticket:${ticket.id}`);
    return () => socket.unsubscribe(`ticket:${ticket.id}`);
  }, [socket, ticket.id]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [detail?.timeline?.length]);

  async function send() {
    if (!msg.trim()) return;
    setSending(true);
    try {
      await api.sendTicketMessage(ticket.id, { message: msg.trim() });
      setMsg("");
      await load();
    } catch (err) { toast.show(err.message, "error"); }
    finally { setSending(false); }
  }

  async function saveTicket() {
    try {
      await api.updateTicket(ticket.id, { status, technicianId: technicianId || null });
      toast.show("Ticket updated");
      onUpdated();
      load();
    } catch (err) { toast.show(err.message, "error"); }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog">
        <div className="drawer-header">
          <div>
            <h3>{detail?.title || ticket.title}</h3>
            <div className="meta">{detail?.reference || ticket.reference || ticket.id}</div>
          </div>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="drawer-body">
          {!detail ? <div className="empty">Loading…</div> : (
            <>
              <div className="kv">
                <div className="k">Building</div><div>{detail.buildingName || "—"}</div>
                <div className="k">Tenant</div><div>{detail.tenantName || "—"} {detail.unit ? `· Unit ${detail.unit}` : ""}</div>
                <div className="k">Category</div><div>{detail.category || "—"}</div>
                <div className="k">Priority</div><div>{detail.priority || "—"}</div>
                <div className="k">Created</div><div>{fmtDate(detail.createdAt)}</div>
                <div className="k">Description</div><div>{detail.description || "—"}</div>
              </div>
              <div className="divider" />
              <div className="toolbar">
                <label style={{ fontSize: 12, color: "var(--muted)" }}>Status</label>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  {["open","assigned","in_progress","resolved","closed"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <label style={{ fontSize: 12, color: "var(--muted)" }}>Technician</label>
                <select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
                  <option value="">— unassigned —</option>
                  {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button className="btn primary" onClick={saveTicket}>Save</button>
              </div>
              <div className="divider" />
              <h3 style={{ margin: 0 }}>Conversation</h3>
              <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: 10, background: "var(--surface-muted)", borderRadius: 10, border: "1px solid var(--stroke)", minHeight: 220, display: "flex", flexDirection: "column", gap: 8 }}>
                {(detail.timeline || []).length === 0 ? <div className="empty">No messages yet.</div> :
                  detail.timeline.map((m) => (
                    <div key={m.id} className={`chat-msg ${m.author_kind === "admin" ? "me" : "them"}`}>
                      <div>{m.message}</div>
                      <div className="meta">{m.author || m.author_kind} · {fmtDate(m.at)}</div>
                    </div>
                  ))}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <textarea rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Reply to tenant…" style={{ flex: 1 }} />
                <button className="btn primary" onClick={send} disabled={sending}>{sending ? "Sending…" : "Send"}</button>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

// -----------------------------------------------------------------------------
// Buildings
// -----------------------------------------------------------------------------

function BuildingsView({ toast }) {
  const [buildings, setBuildings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | "new" | {id,...}
  const [broadcastingId, setBroadcastingId] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setBuildings(await api.listBuildings());
    } catch (err) { toast.show(err.message, "error"); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  async function remove(b) {
    if (!confirm(`Delete "${b.name}"? Tenants and tickets belonging to this building must be removed first.`)) return;
    try {
      await api.deleteBuilding(b.id);
      toast.show("Building deleted");
      load();
    } catch (err) { toast.show(err.message, "error"); }
  }

  return (
    <>
      <div className="topbar">
        <div><h2>Buildings</h2><div className="meta">Buildings managed from this dashboard. No data is hardcoded.</div></div>
        <div className="actions">
          <button className="btn primary" onClick={() => setEditing("new")}>+ Add building</button>
        </div>
      </div>
      <div className="card">
        {loading ? <div className="empty">Loading…</div> : buildings.length === 0 ? (
          <div className="empty">No buildings yet. Add one to get started.</div>
        ) : (
          <table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Emirate</th><th>Units</th><th>Tenants</th><th>Open tickets</th><th></th></tr></thead>
            <tbody>
              {buildings.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontWeight: 600 }}>{b.code || "—"}</td>
                  <td>{b.name}<div className="meta">{b.address || ""}</div></td>
                  <td>{b.emirate || "—"}</td>
                  <td>{b.totalUnits ?? "—"}</td>
                  <td>{b.tenantsCount ?? 0}</td>
                  <td>{b.openTickets ?? 0}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn secondary" onClick={() => setEditing(b)}>Edit</button>
                      <button className="btn secondary" onClick={() => setBroadcastingId(b.id)}>Broadcast</button>
                      <button className="btn danger" onClick={() => remove(b)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing !== null && (
        <BuildingEditor building={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} toast={toast} />
      )}
      {broadcastingId && (
        <BroadcastModal buildingId={broadcastingId} onClose={() => setBroadcastingId(null)} toast={toast} />
      )}
    </>
  );
}

function BuildingEditor({ building, onClose, onSaved, toast }) {
  const [form, setForm] = useState({
    name: building?.name || "",
    code: building?.code || "",
    emirate: building?.emirate || "Dubai",
    address: building?.address || "",
    totalUnits: building?.totalUnits || "",
    notes: building?.notes || "",
  });
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = { ...form, totalUnits: form.totalUnits ? Number(form.totalUnits) : null };
      if (building?.id) await api.updateBuilding(building.id, payload);
      else await api.createBuilding(payload);
      toast.show(building ? "Building updated" : "Building created");
      onSaved();
    } catch (err) { toast.show(err.message, "error"); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h3>{building ? "Edit building" : "New building"}</h3>
        <p className="meta">Buildings appear in the tenant registration screen on the mobile app.</p>
        <div className="form-grid">
          <div><label>Name</label><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label>Code</label><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. BLR" /></div>
          <div><label>Emirate</label><input value={form.emirate} onChange={(e) => setForm({ ...form, emirate: e.target.value })} /></div>
          <div><label>Total units</label><input type="number" min={0} value={form.totalUnits} onChange={(e) => setForm({ ...form, totalUnits: e.target.value })} /></div>
          <div className="wide"><label>Address</label><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
          <div className="wide"><label>Notes</label><textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
        <div className="footer">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </div>
  );
}

function BroadcastModal({ buildingId, onClose, toast }) {
  const [form, setForm] = useState({ title: "", body: "" });
  const [busy, setBusy] = useState(false);
  async function send(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.broadcastToBuilding(buildingId, form);
      toast.show("Broadcast sent to tenants");
      onClose();
    } catch (err) { toast.show(err.message, "error"); }
    finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={send}>
        <h3>Broadcast to building</h3>
        <p className="meta">Delivers an in-app notification (and push, if tenants have opted in).</p>
        <label>Title</label><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <label style={{ marginTop: 12 }}>Message</label><textarea rows={4} required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        <div className="footer">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Sending…" : "Send"}</button>
        </div>
      </form>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tenants
// -----------------------------------------------------------------------------

function TenantsView({ toast }) {
  const [tenants, setTenants] = useState([]);
  const [buildings, setBuildings] = useState([]);
  const [filter, setFilter] = useState({ buildingId: "", q: "" });
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [t, b] = await Promise.all([api.listTenants(filter), api.listBuildings()]);
      setTenants(t);
      setBuildings(b);
    } catch (err) { toast.show(err.message, "error"); }
    finally { setLoading(false); }
  }, [filter, toast]);

  useEffect(() => { load(); }, [load]);

  async function remove(t) {
    if (!confirm(`Remove tenant ${t.name}? Their account will be revoked.`)) return;
    try {
      await api.deleteTenant(t.id);
      toast.show("Tenant removed");
      load();
    } catch (err) { toast.show(err.message, "error"); }
  }

  return (
    <>
      <div className="topbar">
        <div><h2>Tenants</h2><div className="meta">Tenants register themselves from the mobile app. Only admin-approved buildings appear.</div></div>
      </div>
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <input placeholder="Search name, email, unit…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} style={{ minWidth: 280 }} />
          <select value={filter.buildingId} onChange={(e) => setFilter({ ...filter, buildingId: e.target.value })}>
            <option value="">All buildings</option>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <div className="spacer" />
          <button className="btn ghost" onClick={load}>Refresh</button>
        </div>
        {loading ? <div className="empty">Loading…</div> : tenants.length === 0 ? <div className="empty">No tenants registered yet.</div> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Building</th><th>Unit</th><th>Tickets</th><th>Joined</th><th></th></tr></thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.email}</td>
                  <td>{t.buildingName || "—"}</td>
                  <td>{t.unit || "—"}</td>
                  <td>{t.ticketCount ?? 0}</td>
                  <td>{fmtDateOnly(t.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn secondary" onClick={() => setSelected(t)}>View</button>
                      <ExportDropdown kind={`tenants/${t.id}/profile`} label="Export profile" toast={toast} />
                      <button className="btn danger" onClick={() => remove(t)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {selected && <TenantDrawer tenant={selected} onClose={() => setSelected(null)} toast={toast} />}
    </>
  );
}

function TenantDrawer({ tenant, onClose, toast }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => { api.getTenant(tenant.id).then(setDetail).catch((e) => toast.show(e.message, "error")); }, [tenant.id, toast]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-header">
          <div><h3>{tenant.name}</h3><div className="meta">{tenant.email}</div></div>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="drawer-body">
          {!detail ? <div className="empty">Loading…</div> : (
            <>
              <div className="kv">
                <div className="k">Phone</div><div>{detail.tenant?.phone || "—"}</div>
                <div className="k">Building</div><div>{detail.tenant?.Building?.name || "—"}</div>
                <div className="k">Unit</div><div>{detail.tenant?.unit || "—"}</div>
                <div className="k">Verified</div><div>{detail.tenant?.is_verified ? "Yes" : "No"}</div>
                <div className="k">Registered</div><div>{fmtDate(detail.tenant?.createdAt || detail.tenant?.created_at)}</div>
              </div>
              <div className="divider" />
              <h3 style={{ margin: 0 }}>Tickets</h3>
              {!detail.tickets || detail.tickets.length === 0 ? <div className="empty">No tickets.</div> : (
                <table className="table">
                  <thead><tr><th>Ref</th><th>Title</th><th>Status</th><th>Updated</th></tr></thead>
                  <tbody>
                    {detail.tickets.map((t) => {
                      const s = statusBadge(t.status);
                      return <tr key={t.id}><td>{t.id.slice(0,12)}</td><td>{t.title}</td><td><span className={`badge ${s.cls}`}>{s.label}</span></td><td>{fmtDate(t.updated_at || t.submittedAt)}</td></tr>;
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

// -----------------------------------------------------------------------------
// Technicians
// -----------------------------------------------------------------------------

function TechniciansView({ toast }) {
  const [techs, setTechs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try { setLoading(true); setTechs(await api.listTechnicians()); }
    catch (err) { toast.show(err.message, "error"); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  async function remove(t) {
    if (!confirm(`Remove technician ${t.name}?`)) return;
    try { await api.deleteTechnician(t.id); toast.show("Technician removed"); load(); }
    catch (err) { toast.show(err.message, "error"); }
  }

  return (
    <>
      <div className="topbar">
        <div><h2>Technicians</h2><div className="meta">Assigned to tickets by operations staff.</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setEditing("new")}>+ Add technician</button></div>
      </div>
      <div className="card">
        {loading ? <div className="empty">Loading…</div> : techs.length === 0 ? <div className="empty">No technicians yet.</div> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Specialty</th><th>Phone</th><th>Email</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {techs.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.specialty || "—"}</td>
                  <td>{t.phone || "—"}</td>
                  <td>{t.email || "—"}</td>
                  <td>{t.active ? <span className="badge green">active</span> : <span className="badge gray">inactive</span>}</td>
                  <td><div className="row-actions"><button className="btn secondary" onClick={() => setEditing(t)}>Edit</button><button className="btn danger" onClick={() => remove(t)}>Delete</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing !== null && <TechnicianEditor tech={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} toast={toast} />}
    </>
  );
}

function TechnicianEditor({ tech, onClose, onSaved, toast }) {
  const [form, setForm] = useState({ name: tech?.name || "", specialty: tech?.specialty || "", phone: tech?.phone || "", email: tech?.email || "", active: tech?.active ?? true });
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      if (tech?.id) await api.updateTechnician(tech.id, form);
      else await api.createTechnician(form);
      toast.show(tech ? "Technician updated" : "Technician created");
      onSaved();
    } catch (err) { toast.show(err.message, "error"); }
    finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h3>{tech ? "Edit technician" : "New technician"}</h3>
        <div className="form-grid">
          <div><label>Name</label><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label>Specialty</label><input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} placeholder="e.g. Electrical" /></div>
          <div><label>Phone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div><label>Email</label><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="wide"><label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} style={{ width: "auto" }} /> Active (available for new assignments)</label></div>
        </div>
        <div className="footer">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Quality & Documents (read-only lists)
// -----------------------------------------------------------------------------

function QualityView({ toast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api.listQualityReports().then(setItems).catch((e) => toast.show(e.message, "error")).finally(() => setLoading(false)); }, [toast]);
  return (
    <>
      <div className="topbar"><div><h2>Quality reports</h2><div className="meta">Tenant-submitted inspection reports.</div></div></div>
      <div className="card">
        {loading ? <div className="empty">Loading…</div> : items.length === 0 ? <div className="empty">No reports yet.</div> : (
          <table className="table">
            <thead><tr><th>Tenant</th><th>Building</th><th>Rating</th><th>Comment</th><th>Submitted</th></tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>{r.tenantName || "—"}</td>
                  <td>{r.buildingName || "—"}</td>
                  <td>{r.rating != null ? `${r.rating}/5` : "—"}</td>
                  <td style={{ maxWidth: 420 }}>{r.comment || "—"}</td>
                  <td>{fmtDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function DocumentsView({ toast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api.listDocuments().then(setItems).catch((e) => toast.show(e.message, "error")).finally(() => setLoading(false)); }, [toast]);
  return (
    <>
      <div className="topbar"><div><h2>Documents</h2><div className="meta">Tenant-uploaded documents. Stored in Supabase storage, protected by RLS.</div></div></div>
      <div className="card">
        {loading ? <div className="empty">Loading…</div> : items.length === 0 ? <div className="empty">No documents yet.</div> : (
          <table className="table">
            <thead><tr><th>Tenant</th><th>Building</th><th>File</th><th>Kind</th><th>Uploaded</th></tr></thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>{d.tenantName || "—"}</td>
                  <td>{d.buildingName || "—"}</td>
                  <td>{d.fileName || "—"}</td>
                  <td>{d.kind || "—"}</td>
                  <td>{fmtDate(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// -----------------------------------------------------------------------------
// Chat (admin-wide chat panel)
// -----------------------------------------------------------------------------

function ChatView({ socket, wsTick, toast, session }) {
  const [tickets, setTickets] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const scrollRef = useRef(null);

  useEffect(() => {
    api.listTickets({ status: "" }).then(setTickets).catch((e) => toast.show(e.message, "error"));
  }, [toast, wsTick]);

  useEffect(() => {
    if (!activeId) { setDetail(null); return; }
    api.getTicket(activeId).then(setDetail).catch((e) => toast.show(e.message, "error"));
  }, [activeId, wsTick, toast]);

  useEffect(() => {
    if (!socket || !activeId) return;
    socket.subscribe(`ticket:${activeId}`);
    return () => socket.unsubscribe(`ticket:${activeId}`);
  }, [socket, activeId]);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [detail?.timeline?.length]);

  async function send() {
    if (!msg.trim() || !activeId) return;
    setBusy(true);
    try {
      await api.sendTicketMessage(activeId, { message: msg.trim() });
      setMsg("");
      const d = await api.getTicket(activeId);
      setDetail(d);
    } catch (err) { toast.show(err.message, "error"); }
    finally { setBusy(false); }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter((t) => [t.title, t.reference, t.tenantName, t.buildingName].some((x) => String(x || "").toLowerCase().includes(q)));
  }, [tickets, search]);

  return (
    <>
      <div className="topbar"><div><h2>Chat</h2><div className="meta">Real-time conversation with tenants on any ticket.</div></div></div>
      <div className="chat-wrap">
        <div className="chat-list">
          <div className="search"><input placeholder="Search tickets…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <div className="items">
            {filtered.length === 0 ? <div className="empty">No tickets.</div> : filtered.map((t) => (
              <div key={t.id} className={`item ${t.id === activeId ? "active" : ""}`} onClick={() => setActiveId(t.id)}>
                <div className="title">{t.reference || t.id.slice(0,8)} · {t.title}</div>
                <div className="subtitle">{t.tenantName || "—"} · {t.buildingName || "—"}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="chat-panel">
          {!activeId ? <div className="empty" style={{ margin: "auto" }}>Select a ticket to start chatting.</div> : !detail ? <div className="empty">Loading…</div> : (
            <>
              <div className="chat-head">
                <div>
                  <div style={{ fontWeight: 600 }}>{detail.title}</div>
                  <div className="meta">{detail.tenantName || "—"} · {detail.buildingName || "—"}</div>
                </div>
                <div><span className={`badge ${statusBadge(detail.status).cls}`}>{detail.status}</span></div>
              </div>
              <div className="chat-messages" ref={scrollRef}>
                {(detail.timeline || []).length === 0 ? <div className="empty">No messages yet.</div> :
                  detail.timeline.map((m) => (
                    <div key={m.id} className={`chat-msg ${m.author_kind === "admin" ? "me" : "them"}`}>
                      <div>{m.message}</div>
                      <div className="meta">{m.author || m.author_kind} · {fmtDate(m.at)}</div>
                    </div>
                  ))}
              </div>
              <div className="chat-input">
                <textarea rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Type a message…" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
                <button className="btn primary" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send"}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// -----------------------------------------------------------------------------
// Analytics
// -----------------------------------------------------------------------------

function DateInput({ label, value, onChange }) {
  return (
    <div><label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{label}</label>
      <input type="date" value={value || ""} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function useMaintenanceAnalytics(toast) {
  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  const [filter, setFilter] = useState({
    from: defaultFrom.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
    buildingId: "",
  });
  const [data, setData] = useState(null);
  const [buildings, setBuildings] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [res, bs] = await Promise.all([api.maintenanceAnalytics(filter), api.listBuildings()]);
      setData(res);
      setBuildings(bs);
    } catch (err) { toast.show(err.message, "error"); }
    finally { setLoading(false); }
  }, [filter, toast]);

  useEffect(() => { load(); }, [load]);

  return { filter, setFilter, data, buildings, loading, reload: load };
}

function MaintenanceAnalyticsView({ toast }) {
  const { filter, setFilter, data, buildings, loading } = useMaintenanceAnalytics(toast);

  return (
    <>
      <div className="topbar">
        <div><h2>Maintenance report</h2><div className="meta">Volume, categories, and technician performance over the selected period.</div></div>
        <div className="actions">
          <ExportDropdown kind="maintenance-report" query={filter} label="Export report" toast={toast} />
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <DateInput label="From" value={filter.from} onChange={(v) => setFilter({ ...filter, from: v })} />
          <DateInput label="To" value={filter.to} onChange={(v) => setFilter({ ...filter, to: v })} />
          <div>
            <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>Building</label>
            <select value={filter.buildingId} onChange={(e) => setFilter({ ...filter, buildingId: e.target.value })}>
              <option value="">All buildings</option>
              {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {loading || !data ? <LoadingCards count={4} /> : (
        <>
          <div className="grid cols-4">
            <StatCard label="Total tickets" value={data.summary?.total ?? 0} />
            <StatCard label="Resolved" value={data.summary?.resolved ?? 0} sub={`${data.summary?.resolutionRate ?? 0}% resolution`} />
            <StatCard label="Avg. response" value={data.summary?.avgResponseHours != null ? `${data.summary.avgResponseHours}h` : "—"} />
            <StatCard label="Avg. resolution" value={data.summary?.avgResolutionHours != null ? `${data.summary.avgResolutionHours}h` : "—"} />
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h3>Daily volume</h3>
              <div style={{ width: "100%", height: 260 }}>
                <ResponsiveContainer>
                  <LineChart data={data.dailyVolume || []}>
                    <CartesianGrid stroke="#eee" strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <ReTooltip />
                    <Line type="monotone" dataKey="count" stroke={BRAND} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card">
              <h3>By category</h3>
              <div style={{ width: "100%", height: 260 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={data.byCategory || []} dataKey="count" nameKey="category" innerRadius={50} outerRadius={90}>
                      {(data.byCategory || []).map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Pie>
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <ReTooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="card">
            <h3>By building</h3>
            <div style={{ width: "100%", height: 280 }}>
              <ResponsiveContainer>
                <BarChart data={data.byBuilding || []}>
                  <CartesianGrid stroke="#eee" strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <ReTooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="open" stackId="a" fill={BRAND} />
                  <Bar dataKey="resolved" stackId="a" fill="#2F7D57" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card">
            <h3>By technician</h3>
            {!data.byTechnician || data.byTechnician.length === 0 ? <div className="empty">No assignments in range.</div> : (
              <table className="table">
                <thead><tr><th>Technician</th><th>Assigned</th><th>Resolved</th><th>Avg. resolution (h)</th></tr></thead>
                <tbody>
                  {data.byTechnician.map((t) => (
                    <tr key={t.technicianId || t.name}>
                      <td>{t.name}</td>
                      <td>{t.assigned}</td>
                      <td>{t.resolved}</td>
                      <td>{t.avgResolutionHours != null ? t.avgResolutionHours : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="card stat-card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function TicketVolumeView({ toast }) {
  const { filter, setFilter, data, buildings, loading } = useMaintenanceAnalytics(toast);
  return (
    <>
      <div className="topbar"><div><h2>Ticket volume</h2><div className="meta">Daily incoming and resolved counts.</div></div></div>
      <div className="card">
        <div className="toolbar">
          <DateInput label="From" value={filter.from} onChange={(v) => setFilter({ ...filter, from: v })} />
          <DateInput label="To" value={filter.to} onChange={(v) => setFilter({ ...filter, to: v })} />
          <div>
            <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>Building</label>
            <select value={filter.buildingId} onChange={(e) => setFilter({ ...filter, buildingId: e.target.value })}>
              <option value="">All buildings</option>
              {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>
      </div>
      <div className="card">
        <h3>Volume</h3>
        {loading || !data ? <div className="empty">Loading…</div> : (
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <BarChart data={data.dailyVolume || []}>
                <CartesianGrid stroke="#eee" strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <ReTooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="count" fill={BRAND} name="Incoming" />
                <Bar dataKey="resolved" fill="#2F7D57" name="Resolved" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </>
  );
}

function TechnicianLoadView({ toast }) {
  const { filter, setFilter, data, buildings, loading } = useMaintenanceAnalytics(toast);
  return (
    <>
      <div className="topbar"><div><h2>Technician load</h2><div className="meta">Assignments vs resolutions per technician.</div></div></div>
      <div className="card">
        <div className="toolbar">
          <DateInput label="From" value={filter.from} onChange={(v) => setFilter({ ...filter, from: v })} />
          <DateInput label="To" value={filter.to} onChange={(v) => setFilter({ ...filter, to: v })} />
          <div>
            <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>Building</label>
            <select value={filter.buildingId} onChange={(e) => setFilter({ ...filter, buildingId: e.target.value })}>
              <option value="">All buildings</option>
              {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>
      </div>
      <div className="card">
        <h3>Assignments</h3>
        {loading || !data ? <div className="empty">Loading…</div> : (
          <div style={{ width: "100%", height: 340 }}>
            <ResponsiveContainer>
              <BarChart data={data.byTechnician || []} layout="vertical" margin={{ left: 40 }}>
                <CartesianGrid stroke="#eee" strokeDasharray="3 3" />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={140} />
                <ReTooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="assigned" fill={BRAND} />
                <Bar dataKey="resolved" fill="#2F7D57" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </>
  );
}

// -----------------------------------------------------------------------------
// Root App
// -----------------------------------------------------------------------------

export default function App() {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const toast = useToast();

  useEffect(() => {
    const off = window.propertyPortalDesktop?.onPrepareClose?.(async () => {
      const deadline = Date.now() + 8000;
      while (getPendingRequestCount() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      window.propertyPortalDesktop?.confirmReadyToClose?.({ pendingRequests: getPendingRequestCount() });
    });
    return () => off?.();
  }, []);

  // Try to restore session from keychain on startup
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const storedToken = await secureGetToken();
        if (storedToken) {
          setAuthToken(storedToken);
          try {
            const me = await api.adminMe();
            if (!cancelled) setSession({ token: storedToken, admin: me });
          } catch {
            setAuthToken(null);
            await secureClear();
          }
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleLogout = useCallback(async (reason) => {
    setAuthToken(null);
    await secureClear().catch(() => {});
    setSession(null);
    if (reason === "idle") toast.show("Signed out due to inactivity");
    else if (reason === "locked") toast.show("Session locked");
  }, [toast]);

  if (booting) {
    return (
      <div className="login-shell">
        <div className="login-card" style={{ textAlign: "center" }}>
          <div className="login-brand" style={{ justifyContent: "center" }}>
            <div className="login-brand-mark">P</div>
            <div><h1>PropertyPortal</h1><p>Starting up…</p></div>
          </div>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <>
        <LoginScreen onLoggedIn={({ token, admin }) => setSession({ token, admin })} toast={toast} />
        {toast.node}
      </>
    );
  }

  return (
    <>
      <Shell session={session} onLogout={handleLogout} toast={toast} />
      {toast.node}
    </>
  );
}
