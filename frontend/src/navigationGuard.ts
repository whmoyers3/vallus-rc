type UnsavedNavigationGuard = {
  id: string;
  hasUnsavedChanges: () => boolean;
  message?: string;
};

let activeGuard: UnsavedNavigationGuard | null = null;
let bypassNextNavigation = false;

export function registerUnsavedNavigationGuard(guard: UnsavedNavigationGuard) {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

export function hasUnsavedNavigationChanges() {
  return Boolean(activeGuard?.hasUnsavedChanges());
}

export function allowNextUnsavedNavigation() {
  bypassNextNavigation = true;
}

export function shouldBlockUnsavedUnload() {
  if (bypassNextNavigation) {
    bypassNextNavigation = false;
    return false;
  }
  return hasUnsavedNavigationChanges();
}

export function confirmUnsavedNavigation() {
  if (bypassNextNavigation) {
    bypassNextNavigation = false;
    return true;
  }
  if (!activeGuard?.hasUnsavedChanges()) return true;
  return window.confirm(
    activeGuard.message ??
      "You have unsaved changes. Select OK to leave without saving, or Cancel to stay and save your work.",
  );
}
