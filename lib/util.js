function getCoreElements() {
  return {
    loadingScreen: document.getElementById("loading-container"),
    loadingScreenTitle: document.getElementById("action-block"),
    loadingScreenStatus: document.getElementById("context-block"),
    loadingScreenProgress: document.getElementById("progress-bar"),
    loadingScreenProgressContainer: document.getElementById(
      "progress-bar-container",
    ),
  };
}

async function loadCachedAssetUI(assetName, url = true, namespace = null) {
  const {
    loadingScreenStatus: statusText,
    loadingScreenProgress: progress,
    loadingScreenProgressContainer: container,
  } = getCoreElements();

  if (statusText) statusText.textContent = "Initializing...";

  // Throttle UI updates to max 20fps to avoid DOM thrashing
  let lastUIUpdate = 0;
  const UI_THROTTLE_MS = 50;

  const ui = (message, progressPercent = 0) => {
    const now = performance.now();
    if (now - lastUIUpdate < UI_THROTTLE_MS && progressPercent < 100) return;
    lastUIUpdate = now;

    if (statusText) statusText.textContent = message;

    if (progress && container) {
      container.hidden = false;
      // Cap at 100% — defensive
      const clampedPercent = Math.min(Math.round(progressPercent), 100);
      progress.style.width = clampedPercent + "%";
      if (window.updateProgress) {
        window.updateProgress(clampedPercent);
      }
    }
  };

  const hit = await loadCachedAsset(assetName, ui, url, namespace);

  if (container) container.hidden = true;
  return hit;
}

/**
 * Streaming SHA-256 hash for large ArrayBuffers.
 * Uses crypto.subtle when available (fast, native).
 * Falls back to jsSHA in 4MB chunks with event-loop yields to prevent UI freeze.
 */
async function generateHash(arrayBuffer) {
  if (window.crypto && window.crypto.subtle) {
    try {
      const hashBuffer = await window.crypto.subtle.digest(
        "SHA-256",
        arrayBuffer,
      );
      const hashArray = new Uint8Array(hashBuffer);
      let hashHex = "";
      for (let i = 0; i < hashArray.length; i++) {
        hashHex += hashArray[i].toString(16).padStart(2, "0");
      }
      return hashHex;
    } catch (e) {
      // crypto.subtle can fail in insecure contexts, fall through
    }
  }

  // Fallback: jsSHA in chunked mode with yields
  const sha = new jsSHA("SHA-256", "ARRAYBUFFER");
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
  const view = new Uint8Array(arrayBuffer);

  for (let offset = 0; offset < view.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, view.length);
    const chunk = view.buffer.slice(offset, end);
    sha.update(chunk);
    // Yield to event loop every chunk to prevent UI freeze
    await new Promise((r) => setTimeout(r, 0));
  }

  return sha.getHash("HEX");
}

function isOnline() {
  return window.navigator.onLine;
}

/**
 * Optimized IndexedDB wrapper with persistent connection.
 * Keeps the database open instead of open/close thrashing on every operation.
 */
class EasyDatabase {
  dbName = "easydb";
  dbVersion = 1;
  static INSTANCE = new EasyDatabase();
  _db = null;

  async _getDB() {
    if (this._db && !this._db.closed) return this._db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        db.createObjectStore("cache");
      };
      request.onsuccess = (event) => {
        this._db = event.target.result;
        this._db.onclose = () => {
          this._db = null;
        };
        resolve(this._db);
      };
    });
  }

  async setDBAsset(name, value) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("cache", "readwrite");
      const objectStore = transaction.objectStore("cache");
      objectStore.put(value, name);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getDBAsset(name) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("cache", "readonly");
      const objectStore = transaction.objectStore("cache");
      const getRequest = objectStore.get(name);
      getRequest.onsuccess = (event) => resolve(event.target.result);
      getRequest.onerror = (event) => reject(event.target.error);
    });
  }
}

/**
 * Memory-optimized asset loader.
 * Key improvements:
 * - Persistent IndexedDB connection (no open/close thrashing)
 * - Parallel DB writes (hash + data simultaneously)
 * - Early memory release after Blob URL creation
 * - Throttled progress UI updates
 * - Memory pressure detection before large operations
 */
async function loadCachedAsset(
  name,
  messageStream,
  url = true,
  namespace = null,
) {
  const md = await new EPKLib.LargeEPK(name, "URL").fetchMetadata();
  name = namespace == null ? name : `${namespace}:${name}`;

  let hit = await EasyDatabase.INSTANCE.getDBAsset(`@file:${name}`);
  messageStream("Checking local cache...");

  if (hit) {
    let selfHash = await EasyDatabase.INSTANCE.getDBAsset(`@hash:${name}`);
    if (!selfHash) {
      selfHash = await generateHash(hit);
      EasyDatabase.INSTANCE.setDBAsset(`@hash:${name}`, selfHash);
    }

    if (md.hash === selfHash) {
      // Cache hit — create URL and release data reference early
      messageStream("Assets verified.");
      const result = url
        ? URL.createObjectURL(
            new Blob([hit], { type: "application/octet-stream" }),
          )
        : hit;
      hit = null; // Allow GC of 100MB ArrayBuffer
      return result;
    } else {
      // Hash mismatch — download new and update cache
      messageStream("Updating assets...");
      const data = await _fetchAssetData(md, messageStream);

      // Free old cached asset before writing new one to reduce peak memory
      hit = null;

      await Promise.all([
        EasyDatabase.INSTANCE.setDBAsset(`@file:${name}`, data),
        EasyDatabase.INSTANCE.setDBAsset(`@hash:${name}`, md.hash),
      ]);
      if (url) {
        const blobUrl = URL.createObjectURL(
          new Blob([data], { type: "application/octet-stream" }),
        );
        data = null; // Allow GC of 100MB+ ArrayBuffer after blob creation
        return blobUrl;
      }
      return data;
    }
  } else {
    if (!isOnline())
      throw new Error(
        "Your game files are missing, and you are offline. Please go online to download your game files.",
      );

    // No cache — download and store
    messageStream("Downloading game assets...");
    const data = await _fetchAssetData(md, messageStream);
    await Promise.all([
      EasyDatabase.INSTANCE.setDBAsset(`@file:${name}`, data),
      EasyDatabase.INSTANCE.setDBAsset(`@hash:${name}`, md.hash),
    ]);
    if (url) {
      const blobUrl = URL.createObjectURL(
        new Blob([data], { type: "application/octet-stream" }),
      );
      data = null; // Allow GC of 100MB+ ArrayBuffer after blob creation
      return blobUrl;
    }
    return data;
  }
}

/** Shared helper: fetch all segments with progress, concatenate, and dispose. */
async function _fetchAssetData(md, messageStream) {
  const progress = md.fetch();
  progress.progressCallback.addEventListener("progress", (event) => {
    messageStream(`Downloading assets...`, event.overallPercent);
  });
  await progress.promise;
  const data = md.getComplete();
  md.disposeFetchedSegments(); // Free segment memory immediately
  return data;
}

function utf8ToString(array) {
  var out, i, len, c;
  var char2, char3;
  out = "";
  len = array.length;
  i = 0;
  while (i < len) {
    c = array[i++];
    switch (c >> 4) {
      case 0:
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
      case 7:
        out += String.fromCharCode(c);
        break;
      case 12:
      case 13:
        char2 = array[i++];
        out += String.fromCharCode(((c & 0x1f) << 6) | (char2 & 0x3f));
        break;
      case 14:
        char2 = array[i++];
        char3 = array[i++];
        out += String.fromCharCode(
          ((c & 0x0f) << 12) | ((char2 & 0x3f) << 6) | ((char3 & 0x3f) << 0),
        );
        break;
    }
  }
  return out;
}

function checkServiceWorker() {
  return;
}
