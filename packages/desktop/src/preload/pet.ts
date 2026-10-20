import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("pet", {
  onCommand(listener: (command: unknown) => void) {
    const wrapped = (_event: IpcRendererEvent, command: unknown) => listener(command);
    ipcRenderer.on("zcode:pet-command", wrapped);
    return () => ipcRenderer.removeListener("zcode:pet-command", wrapped);
  },
  send(event: unknown) {
    ipcRenderer.send("zcode:pet-event", event);
  },
});
