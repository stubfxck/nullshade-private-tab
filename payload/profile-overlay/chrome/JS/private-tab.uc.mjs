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

    // Локализация: если язык интерфейса браузера русский — RU-строки,
    // иначе английский. Комментарии/breadcrumb-лог намеренно не переводим —
    // это для нас, не для пользователя.
    const isRussianUI = Services.locale.appLocaleAsBCP47.startsWith("ru");
    const t = (ru, en) => (isRussianUI ? ru : en);

    const IDENTITY_NAME = t("Приватная вкладка", "Private Tab");
    const IDENTITY_ICON = "fingerprint";
    const IDENTITY_COLOR = "purple";
    const TAB_ICON = "chrome://global/skin/icons/indicator-private-browsing.svg";
    const TOAST_TEXT = t("Открыта новая приватная вкладка", "New private tab opened");

    // userContextId наших вкладок — чтобы не спутать с обычными контейнерами
    // пользователя (Personal/Work/Banking и т.д.) при уборке.
    const shadowContexts = new Set();

    // Какая из наших вкладок была активна последней и когда — нужно, чтобы
    // правильно приписать page-visited событие, если оно прилетело чуть позже
    // (асинхронно), чем сама вкладка перестала быть выбранной (см. ниже).
    // ВАЖНО ограничивать это окном по времени (ATTRIBUTION_GRACE_MS), а не
    // держать привязку бессрочно, пока вкладка не закрыта — иначе, если
    // пользователь переключится в обычную вкладку и долго там сидит, вся её
    // история будет ошибочно приписываться ещё не закрытой приватной вкладке
    // и удалится вместе с ней.
    let lastFocusedPrivateTab = null;
    let lastFocusedPrivateTabTime = 0;
    const ATTRIBUTION_GRACE_MS = 2500;

    // ВАЖНО: контейнеры Firefox изолируют куки/localStorage/IndexedDB/кэш,
    // но НЕ изолируют историю посещений и историю поиска в адресной строке —
    // это отдельная, не привязанная к userContextId база (Places/moz_places,
    // moz_inputhistory). Поэтому сам факт "своего контейнера" не делает
    // вкладку приватной по-настоящему — историю и поисковые подсказки нужно
    // чистить руками. Настоящий per-tab Private Browsing (usePrivateBrowsing)
    // жёстко привязан к ОКНУ на уровне chromeFlags при его создании и не
    // выставляется на отдельную вкладку без патча движка — см. README.
    //
    // РАСКРЫТЫЙ БАГОМ НЮАНС: onLocationChange (webProgress) ловит только
    // навигации САМОЙ вкладки. Но когда текст вводится прямо в адресную
    // строку (urlbar) и подтверждается как поисковый запрос, Firefox пишет
    // "typed"-visit (moz_historyvisits.visit_type=2, from_visit=0) НАПРЯМУЮ
    // в Places из кода самого urlbar — это происходит МИМО webProgress вкладки
    // и с URL, который может отличаться от того, что потом реально загрузится
    // (например, DuckDuckGo сам переписывает свой URL через history.replaceState,
    // убирая параметры atb/ia — получается ещё один, третий вариант адреса).
    // Проверено вживую: PlacesUtils.history.remove() отработал успешно для
    // двух отслеженных вариантов адреса, а третий (тот самый typed-visit без
    // atb/ia) остался в базе, потому что onLocationChange его вообще не видел.
    //
    // Починено подпиской на PlacesObservers "page-visited" — это единая точка,
    // через которую ЛЮБАЯ запись попадает в moz_places, независимо от того,
    // какой именно внутренний путь её туда положил (webProgress вкладки,
    // urlbar напрямую, replaceState со страницы). Слушатель глобальный
    // (на всё окно), поэтому фильтруется по gBrowser.selectedTab — событие
    // учитывается, только если прямо сейчас активна одна из наших приватных
    // вкладок. Источник подтверждён вживую: тем же способом (PlacesObservers.
    // addListener(["page-visited"], ...)) пользуется сам browser/components/
    // urlbar/UrlbarUtils.sys.mjs в исходниках Firefox.
    const tabHistory = new Map(); // tab -> {listener, urls: Set<url>}

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

    // Единый на всё окно слушатель Places — ловит в том числе visit'ы,
    // записанные urlbar'ом напрямую (см. комментарий выше). Живёт всю сессию,
    // отдельно снимать его не нужно (как и патч OpenBrowserWindow).
    const globalVisitListener = (events) => {
      let targetTab = null;
      try {
        const selected = gBrowser.selectedTab;
        if (selected && shadowContexts.has(selected.userContextId)) {
          targetTab = selected;
        } else if (
          lastFocusedPrivateTab &&
          tabHistory.has(lastFocusedPrivateTab) &&
          Date.now() - lastFocusedPrivateTabTime < ATTRIBUTION_GRACE_MS
        ) {
          // Приватная вкладка уже не в фокусе (например, только что закрылась),
          // но событие могло быть инициировано ещё до этого — короткое окно
          // прощения по времени, не бессрочная привязка.
          targetTab = lastFocusedPrivateTab;
        }
      } catch (ex) {
        return;
      }
      if (!targetTab) {
        return;
      }
      const entry = tabHistory.get(targetTab);
      if (!entry) {
        return;
      }
      for (const event of events) {
        if (event.type === "page-visited" && event.url) {
          entry.urls.add(event.url);
          breadcrumb("global page-visited captured for active private tab: " + event.url);
        }
      }
    };
    try {
      PlacesObservers.addListener(["page-visited"], globalVisitListener);
    } catch (ex) {
      breadcrumb("failed to attach global PlacesObservers listener: " + ex);
    }

    async function purgeTabHistory(tab) {
      const entry = tabHistory.get(tab);
      if (!entry) {
        breadcrumb("purgeTabHistory: no tracked entry for this tab (not attached?)");
        return;
      }
      try {
        tab.linkedBrowser.removeProgressListener(entry.listener);
      } catch (ex) {
        // вкладка уже закрыта/browser уничтожен — не страшно
      }
      // Небольшая пауза перед финальным сбором: page-visited может прилететь
      // с небольшой асинхронной задержкой относительно самого действия
      // (например, urlbar успевает записать typed-visit чуть позже TabClose,
      // если пользователь закрыл вкладку сразу после ввода). Запись в
      // tabHistory НАРОЧНО не удаляется до конца этой паузы — globalVisitListener
      // должен иметь возможность найти entry и дописать в неё запоздавший url.
      await new Promise((resolve) => setTimeout(resolve, ATTRIBUTION_GRACE_MS));
      tabHistory.delete(tab);
      const urls = [...entry.urls];
      breadcrumb("purgeTabHistory: tracked " + urls.length + " url(s): " + JSON.stringify(urls));
      if (urls.length === 0) {
        return;
      }
      try {
        // Убирает эти адреса из истории посещений — вместе с ними чистятся
        // и связанные записи истории ввода (откуда берутся подсказки поиска
        // по этому адресу в адресной строке), т.к. они хранятся по ссылке
        // на конкретную запись в moz_places.
        await PlacesUtils.history.remove(urls);
        breadcrumb("purgeTabHistory: PlacesUtils.history.remove() completed OK");
      } catch (ex) {
        breadcrumb("purgeTabHistory failed: " + ex);
      }
    }

    // Свой минимальный тост — не через gZenUIManager.showToast(), потому что
    // тот требует зарегистрированной Fluent-строки (пришлось бы трогать
    // локализацию Zen). Плюс с ним всё равно ещё всплывает штатный тост
    // Zen "Открыта новая фоновая вкладка" (он видит вкладку в фоне в момент
    // TabOpen, до нашего gBrowser.selectedTab — событие синхронное, раньше
    // не вклиниться без патча). Наш тост просто уточняет рядом — в НИЖНЕМ
    // правом углу, а не в верхнем, где рендерится штатный тост Zen, иначе
    // они налипают друг на друга.
    function showPrivateTabToast() {
      try {
        const doc = window.top.document;
        const toast = doc.createElement("div");
        toast.textContent = TOAST_TEXT;
        toast.style.cssText = [
          "position:fixed",
          "bottom:16px",
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

    async function cleanupContextForTab(tab) {
      const userContextId = tab.userContextId;
      breadcrumb("TabClose fired, userContextId=" + userContextId + ", tracked=" + shadowContexts.has(userContextId));
      if (!userContextId || !shadowContexts.has(userContextId)) {
        return;
      }
      shadowContexts.delete(userContextId);
      await purgeTabHistory(tab);
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

    // Обновляет lastFocusedPrivateTab, когда одна из наших вкладок становится
    // активной — используется globalVisitListener'ом, чтобы правильно
    // приписать чуть запоздавшее page-visited событие (см. комментарий выше).
    gBrowser.tabContainer.addEventListener("TabSelect", (event) => {
      const tab = event.target;
      if (tab && shadowContexts.has(tab.userContextId)) {
        lastFocusedPrivateTab = tab;
        lastFocusedPrivateTabTime = Date.now();
      }
    });

    await breadcrumb("init complete — OpenBrowserWindow patched, ready");
  } catch (ex) {
    await breadcrumb("init FAILED: " + ex + (ex && ex.stack ? "\n" + ex.stack : ""));
  }
})();
