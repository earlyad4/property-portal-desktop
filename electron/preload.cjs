const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("propertyPortalDesktop", {
  getAppInfo: () => ipcRenderer.invoke("app:info"),

  secureToken: {
    get: () => ipcRenderer.invoke("secure:token:get"),
    set: (value) => ipcRenderer.invoke("secure:token:set", value),
  },
  rememberedEmail: {
    get: () => ipcRenderer.invoke("secure:email:get"),
    set: (value) => ipcRenderer.invoke("secure:email:set", value),
  },
  clearSecureSession: () => ipcRenderer.invoke("secure:clear"),

  // Save-as dialog for exports (PDF/Excel). `data` is base64-encoded.
  saveExport: (payload) => ipcRenderer.invoke("export:save", payload),

  // Listen for menu-driven session lock.
  onSessionLock: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("session:lock", wrapped);
    return () => ipcRenderer.removeListener("session:lock", wrapped);
  },

  // The main process asks the renderer to finish active API writes before exit.
  onPrepareClose: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:prepare-close", wrapped);
    return () => ipcRenderer.removeListener("app:prepare-close", wrapped);
  },
  confirmReadyToClose: (details) => ipcRenderer.send("app:ready-to-close", details || {}),
});
