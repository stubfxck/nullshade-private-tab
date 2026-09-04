// private-tab.uc.mjs — приватная вкладка вместо приватного окна.
//
// Перехватывает window.OpenBrowserWindow({private: true}) — единую точку входа,
// через которую Firefox/Zen открывают приватное окно (пункт меню, Ctrl+Shift+P,
// всё остальное стоковое). Вместо нового окна открывает вкладку в этом же окне,
// в СВОЁМ одноразовом контейнере (contextual identity) на каждую вкладку —
// в отличие от Waterfox, где все "приватные" вкладки делят один контейнер и,
// следовательно, куки друг друга. Контейнер и все его данные (куки, localStorage,
// IndexedDB, кэш) удаляются, когда вкладка закрывается — через штатный
// ContextualIdentityService.remove(), который сам чистит данные под капотом.
//
// Загружается через fx-autoconfig (см. builder/vendor/fx-autoconfig).

const LOG_TAG = "[Nullshade private-tab]";
console.log(LOG_TAG, "script loaded, parsing top-level code");

// Дублируем ключевые события в файл — консоль браузера не всегда доступна
// для диагностики (нет интерактивного ввода, ограничения на копирование
// и т.д.), а лог-файл можно прочитать откуда угодно.
const BREADCRUMB_PATH = PathUtils.join(PathUtils.profileDir, "nullshade-private-tab.log");
async function breadcrumb(text) {
  try {
    const line = new Date().toISOString() + " " + text + "\n";
    let existing = "";
    try {
      existing = await IOUtils.readUTF8(BREADCRUMB_PATH);
    } catch (ex) {
      // файла ещё нет — это нормально при первом запуске
    }
    await IOUtils.writeUTF8(BREADCRUMB_PATH, existing + line);
  } catch (ex) {
    // если и запись в файл не удалась — писать больше некуда
  }
}
breadcrumb("script loaded, parsing top-level code");

const { ContextualIdentityService } = ChromeUtils.importESModule(
  "resource://gre/modules/ContextualIdentityService.sys.mjs"
);
const { startupFinished } = ChromeUtils.importESModule(
  "chrome://userchromejs/content/utils.sys.mjs"
);

const IDENTITY_NAME = "Приватная вкладка";
const IDENTITY_ICON = "fingerprint";
const IDENTITY_COLOR = "purple";

// userContextId наших вкладок — чтобы не спутать с обычными контейнерами
// пользователя (Personal/Work/Banking и т.д.) при уборке.
const shadowContexts = new Set();

function openPrivateTab() {
  const identity = ContextualIdentityService.create(
    IDENTITY_NAME,
    IDENTITY_ICON,
    IDENTITY_COLOR
  );
  shadowContexts.add(identity.userContextId);

  const tab = gBrowser.addTab("about:blank", {
    userContextId: identity.userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  gBrowser.selectedTab = tab;
  return tab;
}

function cleanupContextForTab(tab) {
  const userContextId = tab.userContextId;
  if (!userContextId || !shadowContexts.has(userContextId)) {
    return;
  }
  shadowContexts.delete(userContextId);
  try {
    // remove() сам вызывает Services.clearData.deleteDataFromOriginAttributesPattern
    // для этого userContextId — отдельно чистить куки/storage не нужно.
    ContextualIdentityService.remove(userContextId);
  } catch (ex) {
    console.error("[private-tab] не смог очистить контейнер:", ex);
  }
}

function purgeOrphanedContexts() {
  // Если браузер закрыли принудительно (сбой, force-quit) до TabClose,
  // контейнер от прошлой сессии остаётся с данными внутри. Распознаём
  // такие по имени/иконке/цвету — их не могло создать ничего, кроме нас —
  // и подчищаем при старте.
  for (const identity of ContextualIdentityService.getPublicIdentities()) {
    if (
      identity.name === IDENTITY_NAME &&
      identity.icon === IDENTITY_ICON &&
      identity.color === IDENTITY_COLOR
    ) {
      try {
        ContextualIdentityService.remove(identity.userContextId);
      } catch (ex) {
        console.error("[private-tab] не смог убрать осиротевший контейнер:", ex);
      }
    }
  }
}

// gBrowser иногда ещё не готов даже после startupFinished() (задокументированный
// нюанс fx-autoconfig) — на всякий случай ждём его появления в этом window
// отдельно, вместо того чтобы упасть на первой же строке, где он нужен.
async function waitForGBrowser(timeoutMs = 10000) {
  const start = Date.now();
  while (typeof gBrowser === "undefined" || !gBrowser?.tabContainer) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("gBrowser не появился за " + timeoutMs + "мс");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function init() {
  try {
    await breadcrumb("init: waiting for startupFinished()");
    await startupFinished();
    await breadcrumb("init: startupFinished() resolved, waiting for gBrowser");
    await waitForGBrowser();
    await breadcrumb("init: gBrowser ready");
    purgeOrphanedContexts();

    const originalOpenBrowserWindow = window.OpenBrowserWindow;
    window.OpenBrowserWindow = function (options) {
      breadcrumb("OpenBrowserWindow called, options=" + JSON.stringify(options));
      console.log(LOG_TAG, "OpenBrowserWindow called with options:", options);
      if (options && options.private) {
        breadcrumb("intercepted -> opening private tab instead of a window");
        console.log(LOG_TAG, "intercepted -> opening private tab instead of a window");
        return openPrivateTab();
      }
      return originalOpenBrowserWindow.apply(this, arguments);
    };

    gBrowser.tabContainer.addEventListener("TabClose", (event) => {
      cleanupContextForTab(event.target);
    });

    await breadcrumb("init complete — OpenBrowserWindow patched, ready");
    console.log(LOG_TAG, "init complete — OpenBrowserWindow patched, ready");
  } catch (ex) {
    await breadcrumb("init FAILED: " + ex + (ex?.stack ? "\n" + ex.stack : ""));
    console.error(LOG_TAG, "init FAILED:", ex);
  }
}

init();
