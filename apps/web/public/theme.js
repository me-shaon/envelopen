// Applies the stored theme, or the system theme, before the first paint. A file and not
// an inline script, so the Content-Security-Policy (public/_headers) needs no hash.
(() => {
  let theme = null;
  try {
    theme = localStorage.getItem("envelopen.theme");
  } catch (_error) {
    // No storage: follow the system.
  }
  if (theme !== "light" && theme !== "dark") {
    theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  if (theme === "dark") document.documentElement.classList.add("dark");
})();
