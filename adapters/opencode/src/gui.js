// GUI-часть плагина OpenCode (desktop): аналитика Token Lens внутри окна приложения.
// Хост грузит её как "./gui-experimental" в каждом окне desktop-приложения
// (Plugin.define из "@opencode/plugin/gui", см. @opencode/plugin/dist/gui/plugin.d.ts).
//
// Что делает:
// - LinkHandler перехватывает клик по ссылке отчёта (в конце ответа, All Reports, Settings)
//   и открывает её так, как задано в Settings сервера отчётов (`clickBehavior`):
//     · panel (по умолчанию) — встроенный браузер приложения: вкладка в side-панели сессии;
//     · dialog — диалог с iframe внутри окна (сервер не отдаёт X-Frame-Options, iframe работает);
//     · external — системный браузер.
//   Панель недоступна (нет сессии/браузер-плагин выключен) → fallback в диалог.
// - Команды палитры (All Reports / Settings / «в браузере») идут через ту же маршрутизацию.
//
// Без JSX: контент диалога — обычный DOM-узел (валидный JSX.Element), solid-js не нужен.

import { Plugin, Command, LinkHandler } from "@opencode/plugin/gui";
import { Browser } from "@opencode/plugin/gui/browser";

const DEFAULT_BASE = "http://127.0.0.1:3848/";
const BEHAVIORS = ["panel", "dialog", "external"];

function withSlash(url) {
  return /\/$/.test(url) ? url : `${url}/`;
}

// Ссылки этого плагина: http(s)://127.0.0.1[:порт]/ | /settings | /answers/*.html
// (порт может отличаться через TOKEN_LENS_PORT — поэтому матчим по путю, а base берём из ссылки).
function isReportUrl(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
    const path = url.pathname.replace(/\/+$/, "");
    return path === "" || path === "/settings" || path.startsWith("/answers/");
  } catch {
    return false;
  }
}

async function readBehavior(base) {
  try {
    const res = await fetch(`${base}api/settings`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    const value = data && data.settings ? data.settings.clickBehavior : undefined;
    return BEHAVIORS.includes(value) ? value : "panel";
  } catch {
    return "panel";
  }
}

function frame(url) {
  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.title = "Token Lens";
  iframe.setAttribute(
    "style",
    "width:min(1080px,94vw);height:min(800px,90vh);border:0;border-radius:12px;" +
      "background:#0f1115;box-shadow:0 16px 48px rgba(0,0,0,.4);",
  );
  return iframe;
}

function openDialog(ctx, url) {
  ctx.dialogs.open(() => frame(url), { replace: true });
}

function openPanel(ctx, href, link) {
  try {
    const live = ctx.use(Browser)();
    const session = link && link.session ? link.session : ctx.sessions.current();
    if (live.status === "active" && session) {
      if (live.value.canOpen(session, href)) {
        live.value.open(session, href);
        return true;
      }
    }
  } catch {
    /* браузер-панель недоступна — fallback в диалог */
  }
  return false;
}

async function openLink(ctx, href, link) {
  let base = withSlash(DEFAULT_BASE);
  try {
    base = withSlash(new URL(href).origin + "/");
  } catch {
    /* оставляем дефолтный base */
  }
  const behavior = await readBehavior(base);
  if (behavior === "external") {
    try {
      ctx.system.openExternal(href);
    } catch {
      /* system недоступен — ничего не делаем */
    }
    return;
  }
  if (behavior === "panel" && openPanel(ctx, href, link)) return;
  // dialog, либо fallback когда встроенный браузер недоступен
  openDialog(ctx, href);
}

export default Plugin.define({
  setup(ctx) {
    ctx.add(LinkHandler, {
      priority: 10,
      match: (link) => isReportUrl(link.href),
      // Ссылки создаются в начале хода (live-страница), так что цель существует к моменту клика.
      exists: () => true,
      open: (link) => void openLink(ctx, link.href, link),
    });

    ctx.add(Command, {
      id: "reports",
      title: "Token Lens: All Reports",
      description: "Аналитика токенов в окне приложения",
      keywords: "token lens usage токены аналитика отчёты",
      group: "Token Lens",
      slash: { name: "token-lens" },
      run: () => void openLink(ctx, withSlash(DEFAULT_BASE)),
    });

    ctx.add(Command, {
      id: "settings",
      title: "Token Lens: Settings",
      description: "Настройки Token Lens в окне приложения",
      keywords: "token lens настройки settings",
      group: "Token Lens",
      run: () => void openLink(ctx, `${withSlash(DEFAULT_BASE)}settings`),
    });

    ctx.add(Command, {
      id: "reports-external",
      title: "Token Lens: All Reports в браузере",
      description: "Открыть отчёты в системном браузере, минуя настройку",
      keywords: "token lens browser браузер",
      group: "Token Lens",
      run: () => {
        try {
          ctx.system.openExternal(withSlash(DEFAULT_BASE));
        } catch {
          /* system недоступен — ничего не делаем */
        }
      },
    });
  },
});
