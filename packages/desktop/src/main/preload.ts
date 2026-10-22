import { contextBridge, ipcRenderer } from "electron";

/** Typed, minimal surface exposed to the renderer (no node access). */
const api = {
  status: () => ipcRenderer.invoke("agent:status"),
  setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke("agent:setConfig", patch),
  saveApiKey: (value: string, target?: Record<string, unknown>) => ipcRenderer.invoke("agent:saveApiKey", value, target),
  clearApiKey: (target?: Record<string, unknown>) => ipcRenderer.invoke("agent:clearApiKey", target),
  listSessions: () => ipcRenderer.invoke("agent:listSessions"),
  newSession: () => ipcRenderer.invoke("agent:newSession"),
  resumeSession: (id: string) => ipcRenderer.invoke("agent:resumeSession", id),
  history: () => ipcRenderer.invoke("agent:history"),
  send: (prompt: string) => ipcRenderer.invoke("agent:send", prompt),
  abort: () => ipcRenderer.invoke("agent:abort"),
  permissionResult: (key: string, decision: "allow_once" | "allow_always" | "deny") =>
    ipcRenderer.invoke("agent:permissionResult", key, decision),
  pickFolder: () => ipcRenderer.invoke("agent:pickFolder"),
  onEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },

  /* ------------------------------ pet (embedded) ------------------------ */
  getPetPrefs: () => ipcRenderer.invoke("pet:getPrefs"),
  setPetPrefs: (patch: Record<string, unknown>) => ipcRenderer.invoke("pet:setPrefs", patch),
  onBalance: (cb: (info: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("balance:update", listener);
    return () => ipcRenderer.removeListener("balance:update", listener);
  },
  onMood: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("pet:mood", listener);
    return () => ipcRenderer.removeListener("pet:mood", listener);
  },

  /* ------------------------------ balance -------------------------------- */
  getBalance: () => ipcRenderer.invoke("balance:get"),

  /* -------------------------- harness controls ---------------------------- */
  setPlanMode: (on: boolean) => ipcRenderer.invoke("agent:setPlanMode", on),
  undo: () => ipcRenderer.invoke("agent:undo"),
  listCheckpoints: () => ipcRenderer.invoke("agent:checkpoints"),

  /* -------------------------- sessions / config --------------------------- */
  deleteSession: (id: string) => ipcRenderer.invoke("agent:deleteSession", id),
  deleteAllSessions: () => ipcRenderer.invoke("agent:deleteAllSessions"),
  providers: () => ipcRenderer.invoke("agent:providers"),
  providerLogo: (baseUrl: string, label: string) =>
    ipcRenderer.invoke("agent:providerLogo", baseUrl, label),
  env: () => ipcRenderer.invoke("agent:env"),
  keyState: (provider: string, baseUrl: string) =>
    ipcRenderer.invoke("agent:keyState", provider, baseUrl),
  endpointUrl: (baseUrl: string, apiMode: string) => ipcRenderer.invoke("agent:endpointUrl", baseUrl, apiMode),
  saveProvider: (id: string, def: Record<string, unknown>) => ipcRenderer.invoke("agent:saveProvider", id, def),
  deleteProvider: (id: string) => ipcRenderer.invoke("agent:deleteProvider", id),
  duplicateProvider: (id: string) => ipcRenderer.invoke("agent:duplicateProvider", id),
  testConnection: (patch?: Record<string, unknown>) => ipcRenderer.invoke("agent:testConnection", patch),
  listModels: (patch?: Record<string, unknown>) => ipcRenderer.invoke("agent:listModels", patch),
  saveModels: (scope: string, models: string[]) => ipcRenderer.invoke("agent:saveModels", scope, models),
  saveDetectedModels: (scope: string, models: string[]) =>
    ipcRenderer.invoke("agent:saveDetectedModels", scope, models),
  currentModels: () => ipcRenderer.invoke("agent:currentModels"),
  health: () => ipcRenderer.invoke("agent:health"),
  skills: () => ipcRenderer.invoke("agent:skills"),
  mcpServers: () => ipcRenderer.invoke("agent:mcpServers"),
  clearAllowList: () => ipcRenderer.invoke("agent:clearAllowList"),
  openDataDir: () => ipcRenderer.invoke("agent:openDataDir"),
  openExternal: (url: string) => ipcRenderer.invoke("agent:openExternal", url),
};

contextBridge.exposeInMainWorld("aemeath", api);

export type AemeathApi = typeof api;
