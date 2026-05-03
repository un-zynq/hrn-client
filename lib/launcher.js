// lib/launcher.js
function setViewportScale(scale) {
  let defaultScale = 1.0;
  const w = window.screen ? window.screen.width : window.innerWidth;
  const dpr = window.devicePixelRatio || 1;

  if (w > 1920 || dpr > 1.5) {
    defaultScale = Math.min(dpr, 1.5);
  } else {
    defaultScale = Math.min(dpr, 1.0);
  }

  if (scale === undefined || scale === null || isNaN(scale) || scale <= 0) {
    scale = defaultScale;
  }

  scale = Math.max(0.5, Math.min(scale, 2.0));

  try {
    Object.defineProperty(window, "devicePixelRatio", {
      get: function () {
        return scale;
      },
      set: function (v) {},
      configurable: true,
    });
  } catch (e) {
    window.devicePixelRatio = scale;
  }

  var viewportMeta = document.querySelector('meta[name="viewport"]');
  if (!viewportMeta) {
    viewportMeta = document.createElement("meta");
    viewportMeta.name = "viewport";
    document.head.appendChild(viewportMeta);
  }

  viewportMeta.content =
    "width=device-width, initial-scale=" +
    scale +
    ", maximum-scale=" +
    scale +
    ", user-scalable=0";
}

function parseParams(opts) {
  var q = window.location.search;
  if (typeof q === "string" && q.startsWith("?")) {
    q = new URLSearchParams(q);
    var s = q.get("server"),
      d = q.get("demo"),
      scale = q.get("scale"),
      retina = q.get("retina"),
      wgl1 = q.get("wgl1"),
      expwgl1 = q.get("expwgl1"),
      usewglext = q.get("usewglext"),
      ramdisk = q.get("ramdisk"),
      singlethread = q.get("singleThreadMode");

    if (wgl1 && wgl1.toLowerCase() == "true") opts.forceWebGL1 = true;
    if (expwgl1 && expwgl1.toLowerCase() == "true")
      opts.allowExperimentalWebGL1 = true;
    if (usewglext && usewglext.toLowerCase() == "true") opts.useWebGLExt = true;
    else if (usewglext && usewglext.toLowerCase() == "false")
      opts.useWebGLExt = false;
    if (ramdisk && ramdisk.toLowerCase() == "true") opts.ramdiskMode = true;
    if (singlethread && singlethread.toLowerCase() == "true")
      opts.singleThreadMode$ = true;

    if (s) opts.joinServer = s;
    if (d && d.toLowerCase() == "true") opts.demoMode = true;
    if (retina != null && retina.toLowerCase() == "true") {
      setViewportScale(Math.min(1.0, window.devicePixelRatio));
    }
    if (scale != null) {
      scale = parseFloat(scale);
      if (!isNaN(scale)) setViewportScale(scale);
      else {
        alert("Invalid scale value: " + scale);
        throw new Error("Invalid scale value: " + scale);
      }
    }
  }
}

function launch(js, options, ui = getCoreElements(), wasm = false) {
  requestAnimationFrame(() => {
    if (ui && ui.loadingScreen) ui.loadingScreen.remove();
    try {
      const jsElement = document.createElement("script");
      jsElement.type = "text/javascript";
      jsElement.innerHTML = js;

      window.eaglercraftXOpts = options;
      document.head.appendChild(jsElement);
      window.eaglercraftXClientScriptElement = jsElement;
    } catch (err) {
      console.error("[bootstrap] Uncaught error/exception was thrown by game!");
      console.error(err.stack ?? err);
      alert("**** UNCAUGHT ERROR CAUGHT!\n" + (err.stack ?? err));
    }
    if (!wasm) main();
  });
}
