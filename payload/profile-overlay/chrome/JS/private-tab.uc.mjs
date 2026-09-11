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
    const { FormHistory } = ChromeUtils.importESModule(
      "resource://gre/modules/FormHistory.sys.mjs"
    );
    const { startupFinished } = ChromeUtils.importESModule(
      "chrome://userchromejs/content/utils.sys.mjs"
    );
    await breadcrumb("imports OK (ContextualIdentityService, FormHistory, startupFinished)");

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

    // userContextId наших контейнеров — чтобы не спутать с обычными
    // контейнерами пользователя (Personal/Work/Banking и т.д.) при уборке.
    const shadowContexts = new Set();

    // Сколько СЕЙЧАС ОТКРЫТЫХ вкладок используют данный контейнер. Нужно
    // потому что одним нашим контейнером могут пользоваться НЕСКОЛЬКО вкладок
    // одновременно — не только та, что открыл сам мод, но и любая, которую
    // породила уже открытая приватная вкладка: "Open Link in New Tab"
    // (Firefox открывает такую ссылку в ТОМ ЖЕ контейнере, что и родительская
    // вкладка) или "Duplicate Tab". Раньше при закрытии ЛЮБОЙ из них контейнер
    // сносился немедленно — если открыты две вкладки на одном контейнере и
    // закрыть только одну, вторая вживую теряла куки/сессию у себя под носом.
    // Теперь ContextualIdentityService.remove() вызывается только когда счётчик
    // дошёл до нуля, т.е. закрылась ПОСЛЕДНЯЯ вкладка на этом контейнере.
    const contextRefCounts = new Map(); // userContextId -> открытых вкладок

    // Какая из наших вкладок была активна последней и когда — нужно, чтобы
    // правильно приписать page-visited/formhistory-add событие, если оно
    // прилетело чуть позже (асинхронно), чем сама вкладка перестала быть
    // выбранной (см. resolveActivePrivateTab ниже). ВАЖНО ограничивать это
    // окном по времени (ATTRIBUTION_GRACE_MS), а не держать привязку
    // бессрочно, пока вкладка не закрыта — иначе, если пользователь
    // переключится в обычную вкладку и долго там сидит, вся её история будет
    // ошибочно приписываться ещё не закрытой приватной вкладке и удалится
    // вместе с ней.
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
    // urlbar напрямую, replaceState со страницы). Тем же способом
    // (PlacesObservers.addListener(["page-visited"], ...)) пользуется сам
    // browser/components/urlbar/UrlbarUtils.sys.mjs в исходниках Firefox.
    //
    // ВТОРОЙ, ОТДЕЛЬНЫЙ ИСТОЧНИК УТЕЧКИ: formhistory.sqlite (автозаполнение
    // текстовых полей форм — не только урлбар, любое <input> с сохранением
    // истории, включая поисковую панель самого браузера). Эта база НЕ имеет
    // отношения к Places и, что важнее, в её схеме вообще нет колонки
    // userContextId/originAttributes — она не привязана к контейнеру НИКАК,
    // проверено напрямую по содержимому файла. Значит контейнер сам по себе
    // тут не спасает вообще, чистить нужно всегда руками. Ловится через
    // Services.obs topic "satchel-storage-changed" с data="formhistory-add"
    // (проверено по исходнику toolkit/components/satchel/FormHistory.sys.mjs) —
    // ловим только "add" (новая запись), не "update"/"bump": bump означает,
    // что переиспользовалось уже СУЩЕСТВОВАВШЕЕ до открытия приватной вкладки
    // значение, и его удаление снесло бы кусок обычной, не связанной с этой
    // сессией истории автозаполнения.
    const tabHistory = new Map(); // tab -> {listener, urls: Set<url>, formGuids: Set<guid>}

    // Считает переданный userContextId "нашим" — то есть контейнером,
    // созданным этим модом (а не обычным контейнером пользователя), даже
    // если для ЭТОГО конкретного window-инстанса скрипта он ещё не в
    // shadowContexts (например, вкладка только что появилась из другого
    // окна). Смотрим на сам объект контейнера в ContextualIdentityService —
    // имя/иконка/цвет однозначно наши, ничто другое их создать не могло.
    function isOurIdentity(userContextId) {
      if (!userContextId) {
        return false;
      }
      if (shadowContexts.has(userContextId)) {
        return true;
      }
      try {
        const identity = ContextualIdentityService.getPublicIdentityFromId(userContextId);
        return !!(
          identity &&
          identity.name === IDENTITY_NAME &&
          identity.icon === IDENTITY_ICON &&
          identity.color === IDENTITY_COLOR
        );
      } catch (ex) {
        return false;
      }
    }

    function trackTabHistory(tab) {
      const urls = new Set();
      const formGuids = new Set();
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
      tabHistory.set(tab, { listener, urls, formGuids });
    }

    // Общая точка входа для ЛЮБОЙ вкладки, использующей наш контейнер:
    // - открытая самим модом (openPrivateTab, через TabOpen);
    // - "Open Link in New Tab" / "Duplicate Tab" из уже открытой приватной
    //   вкладки — Firefox сам создаёт их в том же userContextId;
    // - вкладка, перетащенная из другого окна в это (см. cleanupContextForTab
    //   и reconcileAtStartup ниже) — здесь она попадает под учёт заново.
    // Не трогает уже отслеживаемые вкладки (idempotent).
    function reconcileTab(tab) {
      const userContextId = tab.userContextId;
      if (tabHistory.has(tab) || !isOurIdentity(userContextId)) {
        return;
      }
      shadowContexts.add(userContextId);
      trackTabHistory(tab);
      contextRefCounts.set(userContextId, (contextRefCounts.get(userContextId) || 0) + 1);
      breadcrumb(
        "reconcileTab: now tracking tab for userContextId=" + userContextId +
        ", refcount=" + contextRefCounts.get(userContextId)
      );
    }

    // См. комментарии выше про lastFocusedPrivateTab/ATTRIBUTION_GRACE_MS —
    // общая логика "к какой из наших вкладок отнести это глобальное событие"
    // для обоих слушателей (Places и FormHistory).
    function resolveActivePrivateTab() {
      try {
        const selected = gBrowser.selectedTab;
        if (selected && tabHistory.has(selected)) {
          return selected;
        }
      } catch (ex) {
        // gBrowser недоступен в моменте — редкий момент закрытия окна целиком
      }
      if (
        lastFocusedPrivateTab &&
        tabHistory.has(lastFocusedPrivateTab) &&
        Date.now() - lastFocusedPrivateTabTime < ATTRIBUTION_GRACE_MS
      ) {
        // Приватная вкладка уже не в фокусе (например, только что закрылась),
        // но событие могло быть инициировано ещё до этого — короткое окно
        // прощения по времени, не бессрочная привязка.
        return lastFocusedPrivateTab;
      }
      return null;
    }

    // Единый на всё окно слушатель Places — ловит в том числе visit'ы,
    // записанные urlbar'ом напрямую (см. комментарий выше). Живёт всю сессию,
    // отдельно снимать его не нужно (как и патч OpenBrowserWindow).
    const globalVisitListener = (events) => {
      const targetTab = resolveActivePrivateTab();
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

    // Аналог globalVisitListener, но для formhistory.sqlite (см. комментарий
    // про второй источник утечки выше). "formhistory-add" — единственный
    // interesting случай: значение появилось в базе впервые.
    const formHistoryObserver = {
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
      observe(subject, topic, data) {
        if (topic !== "satchel-storage-changed" || data !== "formhistory-add") {
          return;
        }
        const targetTab = resolveActivePrivateTab();
        if (!targetTab) {
          return;
        }
        const entry = tabHistory.get(targetTab);
        if (!entry) {
          return;
        }
        let guid;
        try {
          guid = subject.QueryInterface(Ci.nsISupportsString).data;
        } catch (ex) {
          return;
        }
        entry.formGuids.add(guid);
        breadcrumb("global formhistory-add captured for active private tab, guid=" + guid);
      },
    };
    try {
      Services.obs.addObserver(formHistoryObserver, "satchel-storage-changed");
    } catch (ex) {
      breadcrumb("failed to attach FormHistory observer: " + ex);
    }

    // Общий воркер удаления — вызывается дважды из purgeTabHistory (немедленно
    // и повторно после паузы), поэтому вынесен отдельно.
    async function purgeCollected(urls, formGuids) {
      if (urls.length > 0) {
        try {
          // Убирает эти адреса из истории посещений — вместе с ними чистятся
          // и связанные записи истории ввода (откуда берутся подсказки поиска
          // по этому адресу в адресной строке), т.к. они хранятся по ссылке
          // на конкретную запись в moz_places.
          await PlacesUtils.history.remove(urls);
          breadcrumb("purgeCollected: PlacesUtils.history.remove() OK for " + urls.length + " url(s)");
        } catch (ex) {
          breadcrumb("purgeCollected: PlacesUtils.history.remove() failed: " + ex);
        }
      }
      for (const guid of formGuids) {
        try {
          await FormHistory.update({ op: "remove", guid });
        } catch (ex) {
          breadcrumb("purgeCollected: FormHistory.update(remove) failed for " + guid + ": " + ex);
        }
      }
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

      // ФАЗА 1 — чистим немедленно всё, что уже накопилось к моменту закрытия.
      // На практике почти все visit'ы (обычная навигация, urlbar-поиск,
      // formhistory-add) успевают прилететь через глобальные слушатели ЕЩЁ
      // ПОКА вкладка открыта — за секунды до TabClose, а не после него.
      // Раньше вся чистка целиком откладывалась на ATTRIBUTION_GRACE_MS вперёд
      // без всякой нужды, и всё это время адрес продолжал всплывать в
      // подсказках урлбара — ровно это и увидел пользователь при проверке
      // "закрыл вкладку и сразу начал печатать в адресную строку".
      const firstPassUrls = [...entry.urls];
      const firstPassGuids = [...entry.formGuids];
      breadcrumb(
        "purgeTabHistory: immediate pass, " + firstPassUrls.length + " url(s), " +
        firstPassGuids.length + " form entr" + (firstPassGuids.length === 1 ? "y" : "ies") +
        ": " + JSON.stringify(firstPassUrls)
      );
      await purgeCollected(firstPassUrls, firstPassGuids);

      // ФАЗА 2 — запись в tabHistory нарочно не удаляется ещё ATTRIBUTION_GRACE_MS:
      // держим её живой на случай, если что-то (тот самый urlbar-typed visit)
      // всё же придёт с задержкой уже после закрытия. Добираем только НОВОЕ,
      // появившееся после первого прохода — то, что уже почистили, второй раз
      // не трогаем.
      await new Promise((resolve) => setTimeout(resolve, ATTRIBUTION_GRACE_MS));
      tabHistory.delete(tab);
      const secondPassUrls = [...entry.urls].filter((u) => !firstPassUrls.includes(u));
      const secondPassGuids = [...entry.formGuids].filter((g) => !firstPassGuids.includes(g));
      if (secondPassUrls.length > 0 || secondPassGuids.length > 0) {
        breadcrumb(
          "purgeTabHistory: follow-up pass, " + secondPassUrls.length + " new url(s), " +
          secondPassGuids.length + " new form entr" + (secondPassGuids.length === 1 ? "y" : "ies") +
          ": " + JSON.stringify(secondPassUrls)
        );
        await purgeCollected(secondPassUrls, secondPassGuids);
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
      // Сама постановка на учёт (shadowContexts/trackTabHistory/refcount)
      // происходит в reconcileTab через слушатель TabOpen ниже — addTab
      // диспатчит TabOpen синхронно, так что к моменту, когда мы вызовем
      // gBrowser.selectedTab ниже, вкладка уже отслеживается.
      const tab = gBrowser.addTab("about:blank", {
        userContextId: identity.userContextId,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      try {
        gBrowser.setIcon(tab, TAB_ICON);
      } catch (ex) {
        // не критично, цветовая полоска контейнера всё равно видна
      }
      gBrowser.selectedTab = tab;
      showPrivateTabToast();
      return tab;
    }

    // adoptedBy приходит из event.detail для TabClose, которое Firefox
    // диспатчит и когда вкладку по-настоящему закрывают, И когда её
    // перетаскивают в другое окно (тут её содержимое переживает событие,
    // просто переезжает). Раньше это не различалось: перетаскивание приватной
    // вкладки в новое окно мгновенно сносило её контейнер и куки, пока
    // вкладка ещё жива и видна пользователю в другом окне — проверено по
    // Bugzilla 491431, где именно под это добавили detail.adoptedBy.
    //
    // При переезде чистим только то, что вкладка успела насобирать К ЭТОМУ
    // моменту (историю/formhistory) — это безопасно и не зависит от того, где
    // вкладка окажется дальше — но НЕ трогаем сам контейнер: он мог быть
    // общим с другой ещё открытой вкладкой (см. contextRefCounts), а если и
    // нет — за него отвечает reconcileAtStartup нового окна, куда вкладка
    // переехала (см. ниже), когда там всё-таки закроется по-настоящему.
    async function cleanupContextForTab(tab, adoptedBy) {
      const userContextId = tab.userContextId;
      if (adoptedBy) {
        breadcrumb(
          "TabClose (adopted by another window, not a real close) userContextId=" + userContextId
        );
        if (tabHistory.has(tab)) {
          await purgeTabHistory(tab);
        }
        return;
      }
      breadcrumb("TabClose fired, userContextId=" + userContextId + ", tracked=" + tabHistory.has(tab));
      if (!userContextId || !tabHistory.has(tab)) {
        return;
      }
      await purgeTabHistory(tab);
      const remaining = (contextRefCounts.get(userContextId) || 1) - 1;
      if (remaining > 0) {
        // Контейнер всё ещё используется другой открытой вкладкой (например,
        // ссылка была открыта из этой же приватной вкладки в новой) — куки и
        // сессию убивать рано, иначе она мгновенно разлогинится/потеряет
        // данные прямо во время использования.
        contextRefCounts.set(userContextId, remaining);
        breadcrumb(
          "userContextId=" + userContextId + " still has " + remaining +
          " open sibling tab(s) — keeping the container alive"
        );
        return;
      }
      contextRefCounts.delete(userContextId);
      shadowContexts.delete(userContextId);
      try {
        // remove() сам вызывает Services.clearData.deleteDataFromOriginAttributesPattern
        // для этого userContextId — отдельно чистить куки/storage не нужно.
        ContextualIdentityService.remove(userContextId);
      } catch (ex) {
        breadcrumb("cleanupContextForTab failed: " + ex);
      }
    }

    // Проходит по ВСЕМ вкладкам этого окна (вызывается один раз при старте) и
    // берёт под учёт (reconcileTab) любую, что использует наш контейнер, но
    // ещё не отслеживается — это одновременно чинит два случая:
    //  1) вкладку перетащили в НОВОЕ окно (оно создаётся с нуля и запускает
    //     этот скрипт впервые, уже с вкладкой внутри) — она подхватывается
    //     тут вместо того, чтобы остаться вообще без присмотра;
    //  2) браузер закрыли принудительно (сбой, force-quit) до TabClose —
    //     контейнер от прошлой сессии остался без единой живой вкладки.
    // Личности, у которых после прохода по вкладкам refcount так и не
    // появился — это ровно случай (2), их можно спокойно удалять.
    function reconcileAtStartup() {
      for (const tab of gBrowser.tabs) {
        reconcileTab(tab);
      }
      for (const identity of ContextualIdentityService.getPublicIdentities()) {
        if (
          identity.name === IDENTITY_NAME &&
          identity.icon === IDENTITY_ICON &&
          identity.color === IDENTITY_COLOR &&
          !contextRefCounts.has(identity.userContextId)
        ) {
          try {
            ContextualIdentityService.remove(identity.userContextId);
            breadcrumb("reconcileAtStartup: removed orphaned identity userContextId=" + identity.userContextId);
          } catch (ex) {
            breadcrumb("reconcileAtStartup: failed to remove orphan: " + ex);
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

    reconcileAtStartup();

    const originalOpenBrowserWindow = window.OpenBrowserWindow;
    window.OpenBrowserWindow = function (options) {
      breadcrumb("OpenBrowserWindow called, options=" + JSON.stringify(options));
      if (options && options.private) {
        breadcrumb("intercepted -> opening private tab instead of a window");
        return openPrivateTab();
      }
      return originalOpenBrowserWindow.apply(this, arguments);
    };

    // Берёт под учёт вкладки, которые появляются НЕ через openPrivateTab(), но
    // всё равно используют наш контейнер: "Open Link in New Tab"/"Duplicate
    // Tab" из уже открытой приватной вкладки, или вкладка, только что
    // перетащенная в это окно из другого (см. cleanupContextForTab выше).
    gBrowser.tabContainer.addEventListener("TabOpen", (event) => {
      reconcileTab(event.target);
    });

    gBrowser.tabContainer.addEventListener("TabClose", (event) => {
      cleanupContextForTab(event.target, event.detail && event.detail.adoptedBy);
    });

    // Обновляет lastFocusedPrivateTab, когда одна из наших вкладок становится
    // активной — используется resolveActivePrivateTab(), чтобы правильно
    // приписать чуть запоздавшее page-visited/formhistory-add событие.
    gBrowser.tabContainer.addEventListener("TabSelect", (event) => {
      const tab = event.target;
      if (tab && tabHistory.has(tab)) {
        lastFocusedPrivateTab = tab;
        lastFocusedPrivateTabTime = Date.now();
      }
    });

    await breadcrumb("init complete — OpenBrowserWindow patched, ready");
  } catch (ex) {
    await breadcrumb("init FAILED: " + ex + (ex && ex.stack ? "\n" + ex.stack : ""));
  }
})();
