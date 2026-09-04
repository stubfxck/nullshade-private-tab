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

// Пишем лог через ClassicXPCOM (Cc/Ci), не через IOUtils/PathUtils — те
// иногда недоступны как голые глобалы в module-scope в зависимости от того,
// как именно fx-autoconfig прокидывает window. Cc/Ci — самый базовый,
// гарантированно доступный слой privileged JS, старше и надёжнее всего
// остального здесь.
function breadcrumb(text) {
  const line = new Date().toISOString() + " " + text + "\r\n";
  try {
    console.log("[Nullshade private-tab]", text);
  } catch (ex) {
    // консоль недоступна — не страшно, ниже есть файл
  }
  try {
    const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    const file = profileDir.clone();
    file.append("nullshade-private-tab.log");
    const foStream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
      Ci.nsIFileOutputStream
    );
    // write | create | append, права 0644
    foStream.init(file, 0x02 | 0x08 | 0x10, 0o644, 0);
    const converter = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(
      Ci.nsIConverterOutputStream
    );
    converter.init(foStream, "UTF-8");
    converter.writeString(line);
    converter.close();
  } catch (ex) {
    // и классический способ не сработал — писать больше некуда
  }
}

(async () => {
  await breadcrumb("script started executing (top-level)");

  try {
    const { ContextualIdentityService } = ChromeUtils.importESModule(
      "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
    );
    const { PlacesUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/PlacesUtils.sys.mjs"
    );
    const { startupFinished } = ChromeUtils.importESModule(
      "chrome://userchromejs/content/utils.sys.mjs"
    );
    await breadcrumb("imports OK (ContextualIdentityService, startupFinished)");

    const IDENTITY_NAME = "Приватная вкладка";
    const IDENTITY_ICON = "fingerprint";
    const IDENTITY_COLOR = "purple";
    const TAB_ICON = "chrome://global/skin/icons/indicator-private-browsing.svg";

    // userContextId наших вкладок — чтобы не спутать с обычными контейнерами
    // пользователя (Personal/Work/Banking и т.д.) при уборке.
    const shadowContexts = new Set();

    // ВАЖНО: контейнеры Firefox изолируют куки/localStorage/IndexedDB/кэш,
    // но НЕ изолируют историю посещений и историю поиска в адресной строке —
    // это отдельная, не привязанная к userContextId база (Places/moz_places,
    // moz_inputhistory). Поэтому сам факт "своего контейнера" не делает
    // вкладку приватной по-настоящему — историю и поисковые подсказки нужно
    // чистить руками. Настоящий per-tab Private Browsing (usePrivateBrowsing)
    // жёстко привязан к ОКНУ на уровне chromeFlags при его создании и не
    // выставляется на отдельную вкладку без патча движка — см. README.
    const tabHistory = new Map(); // tab -> Set<url>

    function trackTabHistory(tab) {
      const urls = new Set();
      const listener = {
        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),
        onLocationChange(webProgress, request, location) {
          if (webProgress.isTopLevel && location && location.spec) {
            urls.add(location.spec);
          }
        },
      };
      try {
        tab.linkedBrowser.addProgressListener(
          listener,
          Ci.nsIWebProgress.NOTIFY_LOCATION
        );
      } catch (ex) {
        breadcrumb("trackTabHistory failed to attach listener: " + ex);
      }
      tabHistory.set(tab, { listener, urls });
    }

    async function purgeTabHistory(tab) {
      const entry = tabHistory.get(tab);
      if (!entry) {
        return;
      }
      tabHistory.delete(tab);
      try {
        tab.linkedBrowser.removeProgressListener(entry.listener);
      } catch (ex) {
        // вкладка уже закрыта/browser уничтожен — не страшно
      }
      if (entry.urls.size === 0) {
        return;
      }
      try {
        // Убирает эти адреса из истории посещений — вместе с ними чистятся
        // и связанные записи истории ввода (откуда берутся подсказки поиска
        // по этому адресу в адресной строке), т.к. они хранятся по ссылке
        // на конкретную запись в moz_places.
        await PlacesUtils.history.remove([...entry.urls]);
      } catch (ex) {
        breadcrumb("purgeTabHistory failed: " + ex);
      }
    }

    // Свой минимальный тост — не через gZenUIManager.showToast(), потому что
    // тот требует зарегистрированной Fluent-строки (пришлось бы трогать
    // локализацию Zen). Плюс с ним всё равно ещё всплывает штатный тост
    // Zen "Открыта новая фоновая вкладка" (он видит вкладку в фоне в момент
    // TabOpen, до нашего gBrowser.selectedTab — событие синхронное, раньше
    // не вклиниться без патча). Наш тост просто уточняет рядом.
    function showPrivateTabToast() {
      try {
        const doc = window.top.document;
        const toast = doc.createElement("div");
        toast.textContent = "Открыта новая приватная вкладка";
        toast.style.cssText = [
          "position:fixed",
          "top:16px",
          "right:16px",
          "z-index:2147483647",
          "background:#403A68",
          "color:#fff",
          "padding:10px 16px",
          "border-radius:8px",
          "font-size:13px",
          "font-family:system-ui,sans-serif",
          "box-shadow:0 4px 16px rgba(0,0,0,.35)",
          "pointer-events:none",
          "opacity:0",
          "transition:opacity .15s ease",
        ].join(";");
        doc.documentElement.appendChild(toast);
        window.requestAnimationFrame(() => {
          toast.style.opacity = "1";
        });
        window.setTimeout(() => {
          toast.style.opacity = "0";
          window.setTimeout(() => toast.remove(), 200);
        }, 2500);
      } catch (ex) {
        breadcrumb("showPrivateTabToast failed: " + ex);
      }
    }

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
      try {
        gBrowser.setIcon(tab, TAB_ICON);
      } catch (ex) {
        // не критично, цветовая полоска контейнера всё равно видна
      }
      trackTabHistory(tab);
      gBrowser.selectedTab = tab;
      showPrivateTabToast();
      return tab;
    }

    function cleanupContextForTab(tab) {
      const userContextId = tab.userContextId;
      if (!userContextId || !shadowContexts.has(userContextId)) {
        return;
      }
      shadowContexts.delete(userContextId);
      purgeTabHistory(tab);
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
