const projectRoot = new URL("../", import.meta.url);
const workerURL = new URL("coi-serviceworker.js", projectRoot);

async function waitForController(serviceWorker) {
  if (serviceWorker.controller?.scriptURL === workerURL.href) return;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      serviceWorker.removeEventListener("controllerchange", onChange);
      reject(new Error("Browser setup timed out. Reload the page to retry."));
    }, 15_000);

    function onChange() {
      if (serviceWorker.controller?.scriptURL !== workerURL.href) return;
      clearTimeout(timeout);
      serviceWorker.removeEventListener("controllerchange", onChange);
      resolve();
    }

    serviceWorker.addEventListener("controllerchange", onChange);
    onChange();
  });
}

async function start() {
  if (crossOriginIsolated) {
    await import("./app.mjs");
    return;
  }

  const serviceWorker = navigator.serviceWorker;
  if (!serviceWorker) throw new Error("Open the game over HTTPS in a browser with service worker support.");
  const navigation = performance.getEntriesByType("navigation")[0];
  if (serviceWorker.controller?.scriptURL === workerURL.href && navigation?.workerStart > 0) {
    throw new Error("The browser could not isolate the game. Open the game directly in a browser tab.");
  }

  document.querySelector("#status").textContent = "Preparing the browser";
  await serviceWorker.register(workerURL, { scope: projectRoot.href });
  await waitForController(serviceWorker);
  location.reload();
}

start().catch((error) => {
  document.querySelector("#status").textContent = "Couldn’t start the player";
  document.querySelector("#screen-title").textContent = "Browser setup failed";
  document.querySelector("#screen-message").textContent = error.message;
});
