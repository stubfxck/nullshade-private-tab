# Nullshade Private Tab

*by [Nullshade Studio](https://github.com/stubfxck)*

*[Читать по-русски](README_RU.md)*

**Private tabs instead of private windows, for any Firefox-based browser.**
One click opens a private tab in the *same* window — no separate OS window,
no shared cookies between "private" tabs, no source patch to the browser.

Built for [Nullshade Portable](https://github.com/stubfxck/nullshade-portable)
(a portable Zen Browser build), but it's plain Firefox chrome-level JS —
it works on any Firefox/Zen install, portable or not.

💬 Discord: **[discord.gg/eCQYpRx8Wv](https://discord.gg/eCQYpRx8Wv)**

---

## Why not just use a private window?

Firefox's real Private Browsing is engine-level and solid, but some
Firefox-based browsers (Waterfox, for one) ship a "private tab" that's
actually just a regular container tab reused across every "private" tab you
open — meaning they all share the same cookies and storage
([BrowserWorks/waterfox#3956](https://github.com/BrowserWorks/waterfox/issues/3956)).
Not private from each other, just from your regular tabs.

This mod does it properly: **every private tab gets its own, disposable
container** (a Firefox contextual identity), created fresh and destroyed —
cookies, storage, cache and all — the moment you close the tab. No sharing
between tabs, no leftover data.

## What it does

- Overrides `window.OpenBrowserWindow({private: true})` — the single entry
  point Firefox/Zen route the private-window menu item, `Ctrl+Shift+P`, and
  everything else private-window-related through — so all of them open a
  tab in the current window instead.
- Each tab gets a brand-new contextual identity (`ContextualIdentityService.create`).
- On tab close, the identity is removed — which wipes its cookies,
  localStorage, IndexedDB and cache as part of removal.
- Every URL the tab visits is tracked and purged from browsing history
  (and the address bar's search suggestions, which key off it) the moment
  the tab closes — containers don't isolate history/input history from the
  rest of your profile on their own, so this is done by hand.
- A startup sweep removes any container left behind by a crash/force-quit
  before its tab could close normally.

**Known limitations (please read):**

- **Not real Private Browsing.** Firefox's actual `usePrivateBrowsing` flag
  is set per *window* at creation time (via chrome flags) and can't be
  applied to a single tab in an otherwise normal window without patching
  the engine — that's a hard technical wall, not something this mod chose
  to skip. What you get instead is: no shared data between tabs (unlike
  Waterfox's private tab, [BrowserWorks/waterfox#3956](https://github.com/BrowserWorks/waterfox/issues/3956)),
  and cookies/storage/cache/history purged on close. Both approaches
  ultimately rely on cleanup, not on the browser never writing the data in
  the first place — the difference is Waterfox's cleanup misses whole
  tabs' worth of shared state, this one's scoped correctly per tab.
- Extensions are not disabled in these tabs (unlike a real private window,
  which disables them by default). If an extension you have installed
  tracks you across tabs, it can still see you here.
- History cleanup is best-effort: only URLs this specific tab actually
  navigated to get removed. If the exact same URL was also open in a
  regular tab during the same session, it stays in history (removing it
  would affect your regular browsing, not just the private tab). This
  covers both real page navigations and text typed directly into the
  address bar (Firefox records that as a separate "typed" history entry,
  independent of the page load). Cleanup happens in two passes: everything
  already known at the moment the tab closes gets purged immediately, then
  the tab keeps listening a couple more seconds to catch anything that was
  still in flight (a typed search that hadn't finished recording yet) and
  purges that too. Before this, cleanup only ran after that whole delay,
  which meant closing a tab and immediately typing in the address bar could
  briefly still show the old suggestion.
- Form autofill values (search boxes, any named `<input>` you type into)
  are cleaned up too. This is a separate database from history
  (`formhistory.sqlite`) with no concept of containers at all — Firefox
  stores it the same way regardless of which tab or container you typed
  into, so this needed its own tracking and cleanup independent of the
  container.
- If a private tab opens another tab that shares its container ("Open
  Link in New Tab", "Duplicate Tab"), the container and its cookies stay
  alive until *every* tab using it is closed — closing just one no longer
  kills the session for the others still open on it.
- Dragging a private tab into its own new window is safe: everything it
  visited up to that point is cleaned up immediately, and the new window
  picks up tracking it from there. Dragging it into an *already open*
  second window isn't retroactively tracked until that window is next
  restarted — an uncommon enough action that this is a documented gap
  rather than a fully engineered fix.

## Install

Needs [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)-style
privileged chrome scripting, which this mod ships bundled — you don't need
to install fx-autoconfig separately.

1. Download the latest zip from [Releases](../../releases/latest).
2. **Close the browser completely.**
3. Extract it anywhere, then run:

   ```powershell
   # Nullshade Portable
   .\scripts\install.ps1 -BrowserRoot "X:\path\to\ZenBrowserPortable"

   # any other Firefox/Zen install
   .\scripts\install.ps1 -AppDir "C:\Program Files\Zen Browser" -ProfileDir "$env:APPDATA\zen\Profiles\xxxxxxxx.default"
   ```

   (Find your profile path via `about:support` → *Profile Folder* if you're
   not sure.)
4. Start the browser. Press `Ctrl+Shift+P` (or use the private-window menu
   item) — it should open a tab, not a window.

No installer needed on the browser side beyond that — the script just copies
files into two folders. To uninstall, delete `chrome\JS\private-tab.uc.mjs`
and `chrome\utils\` from your profile, and `config.js` +
`defaults\pref\config-prefs.js` + `defaults\pref\private-tab-mod.js` from the
browser's install folder.

## What gets installed where

```text
payload/
├─ app-overlay/                    → copied into the browser's install folder (e.g. App\Zen\)
│  ├─ config.js                    fx-autoconfig bootstrap
│  └─ defaults/pref/
│     ├─ config-prefs.js           fx-autoconfig prefs
│     └─ private-tab-mod.js        userChromeJS.enabled = true
└─ profile-overlay/chrome/         → copied into the profile's chrome\ folder
   ├─ JS/private-tab.uc.mjs        the mod itself
   └─ utils/                       fx-autoconfig loader (vendored, MPL-2.0)
```

## Building a release zip yourself

```powershell
Compress-Archive -Path .\payload\*, .\scripts, .\mod.json -DestinationPath output\NullshadePrivateTab.zip
```

(CI does this automatically on every push to `payload/**` or `mod.json` —
see `.github/workflows/build-mod.yml`.)

## Credits and license

- Uses [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) by
  MrOtherGuy (MPL-2.0) — vendored under `payload/profile-overlay/chrome/utils/`,
  full license text in `licenses/fx-autoconfig-LICENSE.txt`.
- This repository is MPL-2.0 licensed — see `LICENSE`.
