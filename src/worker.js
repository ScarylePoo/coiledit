// Monaco language-service worker bootstrap (same origin as the page).
self.MonacoEnvironment = { baseUrl: new URL('vendor/monaco/', self.location.href).href };
importScripts(new URL('vendor/monaco/vs/base/worker/workerMain.js', self.location.href).href);
