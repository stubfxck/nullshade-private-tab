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
// Загружается через fx-autoconfig (см. payload/profile-overlay/chrome/utils).
//
// ВЕСЬ файл обёрнут в один try/catch: любая ошибка (в том числе на верхнем
// уровне модуля — например, если какой-то глобал недоступен в этом scope)
// попадает в лог-файл Data\profile\nullshade-private-tab.log, а не тонет
// молча. Консоль браузера не всегда доступна для диагностики, файл — всегда.

const BREADCRUMB_PATH_FALLBACK =
  (typeof PathUtils !== "undefined" && PathUtils.profileDir)
    ? PathUtils.profileDir + "/nullshade-private-tab.log"
    : null;

async function breadcrumb(text) {
  const line = new Date().toISOString() + " " + text + "\n";
  try {
    console.log("[Nullshade private-tab]", text);
  } catch (ex) {
    // консоль недоступна — не страшно, ниже есть файл
  }
  if (!BREADCRUMB_PATH_FALLBACK) {
    return;
  }
  try {
    let existing = "";
    try {
      existing = await IOUtils.readUTF8(BREADCRUMB_PATH_FALLBACK);
    } catch (ex) {
      // файла ещё нет — нормально при первом запуске
    }
    await IOUtils.writeUTF8(BREADCRUMB_PATH_FALLBACK, existing + line);
  } catch (ex) {
    // и запись в файл не удалась — писать больше некуда
  }
}

(async () => {
  await breadcrumb("script started executing (top-level)");

  try {
    const { ContextualIdentityService } = ChromeUtils.importESModule(
      "resource://gre/modules/ContextualIdentityService.sys.mjs"
    );
    const { startupFinished } = ChromeUtils.importESModule(
      "chrome://userchromejs/content/utils.sys.mjs"
    );
    await breadcrumb("imports OK (ContextualIdentityService, startupFinished)");

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
        breadcrumb("cleanupContextForTab failed: " + ex);
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
            breadcrumb("purgeOrphanedContexts failed: " + ex);
          }
        }
      }
    }

    // gBrowser иногда ещё не готов даже после startupFinished() (задокументированный
    // нюанс fx-autoconfig) — ждём его появления в этом window отдельно.
    async function waitForGBrowser(timeoutMs = 10000) {
      const start = Date.now();
      while (typeof gBrowser === "undefined" || !gBrowser?.tabContainer) {
        if (Date.now() - start > timeoutMs) {
          throw new Error("gBrowser не появился за " + timeoutMs + "мс");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    await breadcrumb("waiting for startupFinished()");
    await startupFinished();
    await breadcrumb("startupFinished() resolved, waiting for gBrowser");
    await waitForGBrowser();
    await breadcrumb("gBrowser ready");

    purgeOrphanedContexts();

    const originalOpenBrowserWindow = window.OpenBrowserWindow;
    window.OpenBrowserWindow = function (options) {
      breadcrumb("OpenBrowserWindow called, options=" + JSON.stringify(options));
      if (options && options.private) {
        breadcrumb("intercepted -> opening private tab instead of a window");
        return openPrivateTab();
      }
      return originalOpenBrowserWindow.apply(this, arguments);
    };

    gBrowser.tabContainer.addEventListener("TabClose", (event) => {
      cleanupContextForTab(event.target);
    });

    await breadcrumb("init complete — OpenBrowserWindow patched, ready");
  } catch (ex) {
    await breadcrumb("init FAILED: " + ex + (ex && ex.stack ? "\n" + ex.stack : ""));
  }
})();
