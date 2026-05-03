"use strict";
var EPKLib;
(function (EPKLib) {
  let PassedResourceType;
  (function (PassedResourceType) {
    PassedResourceType["URL"] = "URL";
    PassedResourceType["DATA"] = "DATA";
  })(PassedResourceType || (PassedResourceType = {}));

  function getParentUrl(path) {
    const currentUrl = window.location.href;
    let url;
    if (path.includes("://")) {
      url = new URL(path);
    } else {
      url = new URL(path, currentUrl);
    }
    const segments = url.pathname.split("/");
    segments.pop();
    url.pathname = segments.join("/");
    return url;
  }
  EPKLib.getParentUrl = getParentUrl;

  function isAbsoluteUrl(url) {
    return /^(https?:)?\/\//i.test(url) || /^[^/]+\//.test(url);
  }
  EPKLib.isAbsoluteUrl = isAbsoluteUrl;

  function joinUrls(baseUrl, pathSegment) {
    const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    return new URL(pathSegment, base).toString();
  }
  EPKLib.joinUrls = joinUrls;

  function stringifyBlob(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }
  EPKLib.stringifyBlob = stringifyBlob;

  async function compileLargeEPK(filename, file, segmentMaxSize, sha256Hash) {
    const output = { directoryFile: undefined, files: [] };
    const rawMeta = { filename, segments: [], hash: sha256Hash };
    const view = new Uint8Array(file);
    const chunkCount = Math.ceil(file.byteLength / segmentMaxSize);

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const begin = chunkIndex * segmentMaxSize;
      const end = Math.min(begin + segmentMaxSize, view.byteLength);
      const chunk = view.slice(begin, end);
      const outFileName = `${filename.replace(/[^\x00-\x7F]/g, "")}.${chunkIndex}.seg`;
      output.files.push({ filename: outFileName, data: chunk });
      rawMeta.segments.push(outFileName);
    }
    output.directoryFile = JSON.stringify(rawMeta);
    return output;
  }
  EPKLib.compileLargeEPK = compileLargeEPK;

  const MAX_CONCURRENT_DOWNLOADS = 3;
  const PROGRESS_THROTTLE_MS = 60;

  class LargeEPK {
    constructor(resource, resourceType) {
      this.partial = true;
      if (resourceType == PassedResourceType.URL) {
        this.url = resource;
      } else if (resourceType == PassedResourceType.DATA) {
        this.rawData = resource;
      }
    }

    async fetchMetadata() {
      if (!this.partial) throw new Error("Metadata already fetched");
      if (this.url != null) {
        this.rawData = await (await fetch(this.url)).text();
      }
      if (this.rawData instanceof Blob) {
        this.rawData = await stringifyBlob(this.rawData);
      }
      const metadata = JSON.parse(this.rawData);
      this.hash = metadata.hash;
      this.filename = metadata.filename;
      this.segments = metadata.segments.map(segment =>
        new LargeEPKSegment(
          isAbsoluteUrl(segment)
            ? segment
            : this.url != null
              ? joinUrls(getParentUrl(this.url.toString()).toString(), segment)
              : segment
        )
      );
      this.rawData = undefined;
      return this;
    }

    fetch() {
      const eventTarget = new EventTarget();
      const promiseMeta = {};
      const ret = {
        percent: 0,
        progressCallback: eventTarget,
        promise: new Promise((res, rej) => { promiseMeta.res = res; promiseMeta.rej = rej; })
      };

      const totalSegments = this.segments.length;
      let completedCount = 0;
      const segmentProgress = new Float64Array(totalSegments);
      let lastProgressDispatch = 0;

      const dispatchProgress = (force) => {
        if (!force) {
          const now = performance.now();
          if (now - lastProgressDispatch < PROGRESS_THROTTLE_MS) return;
          lastProgressDispatch = now;
        }
        let ongoingSum = 0;
        for (let i = 0; i < totalSegments; i++) ongoingSum += segmentProgress[i];
        const rawPercent = ((completedCount + ongoingSum) / totalSegments) * 100;
        const progressEvent = new Event("progress");
        progressEvent.overallPercent = Math.min(rawPercent, 100);
        eventTarget.dispatchEvent(progressEvent);
      };

      let nextIndex = 0;
      const downloadWorker = async () => {
        while (nextIndex < totalSegments) {
          const idx = nextIndex++;
          const segment = this.segments[idx];
          const { promise: segmentPromise, eventTarget: segmentEventTarget } = segment.fetchSegment();

          segmentEventTarget.addEventListener("progress", () => {
            segmentProgress[idx] = Math.min(segment.progress / 100, 1);
            dispatchProgress(false);
          });

          await segmentPromise;
          completedCount++;
          segmentProgress[idx] = 0;
          dispatchProgress(true);
        }
      };

      const concurrency = Math.min(MAX_CONCURRENT_DOWNLOADS, totalSegments);
      const workers = [];
      for (let i = 0; i < concurrency; i++) workers.push(downloadWorker());

      Promise.all(workers).then(() => {
        const ev = new Event("progress");
        ev.overallPercent = 100;
        eventTarget.dispatchEvent(ev);
        promiseMeta.res(this);
      }).catch(promiseMeta.rej);

      return ret;
    }

    getComplete() {
      let totalLength = 0;
      for (const segment of this.segments) {
        if (segment.data != null) totalLength += segment.data.byteLength;
        else throw new Error("Not all segments fetched");
      }
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const segment of this.segments) {
        result.set(new Uint8Array(segment.data), offset);
        offset += segment.data.byteLength;
      }
      return result.buffer;
    }

    disposeFetchedSegments() {
      this.segments.forEach(s => s.dispose());
      return this;
    }
  }
  EPKLib.LargeEPK = LargeEPK;

  class LargeEPKSegment {
    constructor(url) {
      this.url = url;
      this.progress = 0;
    }
    dispose() {
      this.data = undefined;
      return this;
    }

    fetchSegment() {
      if (this.data != null) throw new TypeError("Already fetched");
      const eventTarget = new EventTarget();
      const ret = { promise: undefined, percent: 100, eventTarget };

      const promise = new Promise(async (res, rej) => {
        try {
          const response = await fetch(this.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
          const reader = response.body.getReader();
          const chunks = [];
          let loaded = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;

            const percent = contentLength > 0 ? Math.min((loaded / contentLength) * 100, 100) : 100;
            this.progress = percent;
            const ev = new Event("progress");
            ev.percent = percent;
            eventTarget.dispatchEvent(ev);
          }

          let totalLength = 0;
          for (let chunk of chunks) totalLength += chunk.byteLength;
          const concatenated = new Uint8Array(totalLength);
          let offset = 0;
          for (let chunk of chunks) {
            concatenated.set(chunk, offset);
            offset += chunk.byteLength;
          }

          this.data = concatenated;
          this.progress = 100;
          res(this);
        } catch (e) {
          console.error("Failed to fetch segment:", this.url, e);
          rej(e);
        }
      });

      ret.promise = promise;
      return ret;
    }
  }
  EPKLib.LargeEPKSegment = LargeEPKSegment;
})(EPKLib || (EPKLib = {}));
