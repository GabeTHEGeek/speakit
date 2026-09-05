import type { MainView } from "./mainView";

export function setupNavigation(view: MainView) {
  const setDrawerOpen = (open: boolean) => {
    view.sideNav.classList.toggle("open", open);
    view.navBackdrop.classList.toggle("open", open);
    view.sideNav.setAttribute("aria-hidden", String(!open));
    view.navOpen.setAttribute("aria-expanded", String(open));
  };

  const showPage = (page: "home" | "history" | "models") => {
    const historyVisible = page === "history";
    const modelsVisible = page === "models";
    view.homeView.classList.toggle("hidden", historyVisible || modelsVisible);
    view.historyView.classList.toggle("hidden", !historyVisible);
    view.modelsView.classList.toggle("hidden", !modelsVisible);
    view.navHome.classList.toggle("active", page === "home");
    view.navHistory.classList.toggle("active", historyVisible);
    view.navModels.classList.toggle("active", modelsVisible);
    setDrawerOpen(false);
  };

  view.navOpen.addEventListener("click", () => setDrawerOpen(true));
  view.navClose.addEventListener("click", () => setDrawerOpen(false));
  view.navBackdrop.addEventListener("click", () => setDrawerOpen(false));
  view.navHome.addEventListener("click", () => showPage("home"));
  view.navModels.addEventListener("click", () => showPage("models"));
  view.navHistory.addEventListener("click", () => showPage("history"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setDrawerOpen(false);
  });

  return { showPage };
}
