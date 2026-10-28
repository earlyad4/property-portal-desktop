const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require("electron");
const path = require("path");

let keytar = null;
try {
  // keytar is an optional native dep; fall back gracefully when unavailable.
  keytar = require("keytar");
} catch (err) {
  console.warn("[property-portal-desktop] keytar not available, secure storage disabled:", err.message);
}

const KEYTAR_SERVICE = "PropertyPortalDesktop";
const KEYTAR_ACCOUNT_TOKEN = "admin-jwt";
const KEYTAR_ACCOUNT_REMEMBER = "remember-email";

const isDev = !app.isPackaged;
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
const allowedExternalHosts = new Set((process.env.PROPERTY_PORTAL_EXTERNAL_LINK_HOSTS || "example.com").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));

let mainWindow = null;
let closeApproved = false;
let closeTimer = null;

function assertTrustedSender(event) {
  const source = event.senderFrame?.url || "";
  const trusted = isDev ? source.startsWith(new URL(VITE_DEV_SERVER_URL).origin) : source.startsWith("file://") && source.includes("/dist/index.html");
  if (!trusted || event.sender !== mainWindow?.webContents) throw new Error("Rejected IPC from an untrusted renderer");
}

function safeString(value, max, label) {
  if (typeof value !== "string" || value.length > max) throw new TypeError(`${label} is invalid`);
  return value;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#F5EFE8",
    title: "PropertyPortal",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === "https:" && allowedExternalHosts.has(target.hostname.toLowerCase())) shell.openExternal(target.toString());
    } catch {}
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url !== current) event.preventDefault();
  });

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    closeApproved = false;
    mainWindow = null;
  });

  mainWindow.on("close", (event) => {
    if (closeApproved || !mainWindow) return;
    event.preventDefault();
    mainWindow.webContents.send("app:prepare-close");
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      // Do not trap the user indefinitely if the renderer has crashed.
      closeApproved = true;
      mainWindow?.close();
    }, 10000);
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Lock session",
          accelerator: "CmdOrCtrl+L",
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send("session:lock");
            }
          },
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -------------- Secure storage IPC (keytar or noop) --------------

async function secureSet(event, account, value, max) {
  assertTrustedSender(event);
  if (!keytar) return false;
  const safeValue = safeString(value || "", max, "secure value");
  try {
    if (!safeValue) {
      await keytar.deletePassword(KEYTAR_SERVICE, account);
    } else {
      await keytar.setPassword(KEYTAR_SERVICE, account, safeValue);
    }
    return true;
  } catch (err) {
    console.error("[property-portal-desktop] secure:set failed:", err);
    return false;
  }
}

async function secureGet(event, account) {
  assertTrustedSender(event);
  if (!keytar) return null;
  try {
    return await keytar.getPassword(KEYTAR_SERVICE, account);
  } catch (err) {
    console.error("[property-portal-desktop] secure:get failed:", err);
    return null;
  }
}

ipcMain.handle("secure:token:set", (event, value) => secureSet(event, KEYTAR_ACCOUNT_TOKEN, value, 8192));
ipcMain.handle("secure:token:get", (event) => secureGet(event, KEYTAR_ACCOUNT_TOKEN));
ipcMain.handle("secure:email:set", (event, value) => secureSet(event, KEYTAR_ACCOUNT_REMEMBER, value, 320));
ipcMain.handle("secure:email:get", (event) => secureGet(event, KEYTAR_ACCOUNT_REMEMBER));

ipcMain.handle("secure:clear", async (event) => {
  assertTrustedSender(event);
  if (!keytar) return false;
  try {
    await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_TOKEN);
    await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REMEMBER);
    return true;
  } catch (err) {
    console.error("[property-portal-desktop] secure:clear failed:", err);
    return false;
  }
});

// -------------- App info --------------

ipcMain.handle("app:info", (event) => {
  assertTrustedSender(event);
  return ({
  version: app.getVersion(),
  platform: process.platform,
  name: app.getName(),
  });
});

ipcMain.on("app:ready-to-close", (event, details) => {
  try { assertTrustedSender(event); } catch { return; }
  if (!mainWindow) return;
  if (Number(details?.pendingRequests || 0) > 0) {
    console.warn("[property-portal-desktop] close timeout reached with pending API requests");
  }
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = null;
  closeApproved = true;
  mainWindow.close();
});

// -------------- Save-as dialog for exports --------------

ipcMain.handle("export:save", async (event, payload) => {
  assertTrustedSender(event);
  if (!mainWindow) return { saved: false };
  if (!payload || typeof payload !== "object") throw new TypeError("Export payload is invalid");
  const defaultName = path.basename(safeString(payload.defaultName || "property-portal-export", 180, "filename")).replace(/[^a-zA-Z0-9._ -]/g, "_");
  const data = safeString(payload.data || payload.base64 || "", 35_000_000, "export data");
  const mime = safeString(payload.mime || "application/octet-stream", 100, "mime");
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(data)) throw new TypeError("Export data is not valid base64");
  if (!["application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv"].includes(mime)) throw new TypeError("Export type is not allowed");
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save export",
    defaultPath: defaultName || "property-portal-export",
  });
  if (result.canceled || !result.filePath) return { saved: false };
  const fs = require("fs");
  try {
    const buffer = Buffer.from(data, "base64");
    fs.writeFileSync(result.filePath, buffer);
    return { saved: true, path: result.filePath, mime };
  } catch (err) {
    console.error("[property-portal-desktop] export:save failed:", err);
    return { saved: false, error: err.message };
  }
});

// -------------- App lifecycle --------------

app.whenReady().then(() => {
  buildMenu();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
