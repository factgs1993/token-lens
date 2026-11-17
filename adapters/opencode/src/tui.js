// TUI-часть плагина OpenCode (plain JS, без JSX): команда «открыть All Reports».
// Регистрируется slash-командой /token-lens через keymap.layer; URL берёт из
// RPC-контракта (server), открывает системный браузер и показывает toast.

import { Plugin } from "@opencode/plugin/tui";
import { spawn } from "node:child_process";
import { TokenLens } from "./rpc.js";

const DEFAULT_URL = "http://127.0.0.1:3848/";

function openUrl(url, platform = process.platform) {
  try {
    if (platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => {});
      child.unref();
      return true;
    }
    if (platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return true;
    }
    const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export default Plugin.define({
  id: "opencode-token-lens.tui",
  setup(context) {
    context.keymap.layer(() => ({
      commands: [
        {
          id: "opencode-token-lens.reports",
          title: "Открыть Token Lens: All Reports",
          description: "Открыть список отчётов Token Lens (http://127.0.0.1:3848) в браузере",
          group: "Token Lens",
          palette: true,
          slash: { name: "token-lens" },
          run: async () => {
            let url = DEFAULT_URL;
            try {
              const info = await context.client.rpc(TokenLens).server();
              if (info?.baseUrl) url = info.baseUrl;
            } catch {
              // Сервер может не подняться — всё равно пробуем открыть дефолтный URL.
            }
            if (!/\/$/.test(url)) url += "/";
            const opened = openUrl(url);
            try {
              if (opened) {
                context.ui.toast.show({
                  title: "Token Lens",
                  message: `All Reports: ${url}`,
                  variant: "success",
                });
              } else {
                context.ui.toast.show({
                  title: "Token Lens",
                  message: `Браузер не открылся. Открой вручную: ${url}`,
                  variant: "warning",
                });
              }
            } catch {
              /* toast недоступен — не критично */
            }
          },
        },
      ],
    }));
  },
});
