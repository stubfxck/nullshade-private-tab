// Nullshade Private Tab mod — enables fx-autoconfig's privileged script loader.
// general.config.* prefs are already set by config-prefs.js (fx-autoconfig itself).
pref("userChromeJS.enabled", true);
// Documented fx-autoconfig gotcha: gBrowser can be unavailable at script
// execution time even after startupFinished(). Our script also defends
// against this itself (waitForGBrowser), this pref is belt-and-suspenders.
pref("userChromeJS.gBrowser_hack.enabled", true);
