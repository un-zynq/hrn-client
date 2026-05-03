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
    const joinedUrl = new URL(pathSegment, base).toString();
    return joinedUrl;
  }
  EPKLib.joinUrls = joinUrls;
  function stringifyBlob(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        resolve(result);
      };
      reader.onerror = () => {
        reject(reader.error);
      };
      reader.readAsText(blob);
    });
  }
  EPKLib.stringifyBlob = stringifyBlob;
  async function compileLargeEPK(filename, file, segmentMaxSize, sha256Hash) {
    const output = {
        directoryFile: undefined,
        files: [],
      },
      rawMeta = {
        filename,
        segments: [],
        hash: sha256Hash,
      };
    const view = new Uint8Array(file),
      chunkCount = Math.ceil(file.byteLength / segmentMaxSize);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const begin = chunkIndex * segmentMaxSize,
        end = Math.min(begin + segmentMaxSize, view.byteLength),
        chunk = view.slice(begin, end),
        outFileName = `${filename.replace(/[^\x00-\x7F]/g, "")}.${chunkIndex}.seg`;
      output.files.push({
        filename: outFileName,
        data: chunk,
      });
      rawMeta.segments.push(outFileName);
    }
    output.directoryFile = JSON.stringify(rawMeta);
    return output;
  }
  EPKLib.compileLargeEPK = compileLargeEPK;

  /**
   * Concurrency limit for parallel segment downloads.
   * 3 concurrent downloads balances speed vs bandwidth saturation.
   */
  const MAX_CONCURRENT_DOWNLOADS = 3;

  /**
   * Throttle interval for progress events (ms).
   * Prevents excessive DOM updates during fast downloads.
   */
  const PROGRESS_THROTTLE_MS = 60;

  class LargeEPK {
    constructor(resource, resourceType) {
      this.partial = true;
      if (resourceType == PassedResourceType.URL) {
        if (resource instanceof Blob) {
          throw new TypeError(
            `Resource of type Blob is not allowed when resourceType is set to URL.`,
          );
        }
        this.url = resource;
      } else if (resourceType == PassedResourceType.DATA) {
        if (resource instanceof URL) {
          throw new TypeError(
            `Resource of type URL is not allowed when resourceType is set to DATA.`,
          );
        } else if (resource instanceof Blob || typeof resource == "string") {
          this.rawData = resource;
        }
      } else {
        throw new TypeError(
          "resourceType must be one of the following values: DATA, URL.",
        );
      }
    }
    async fetchMetadata() {
      if (!this.partial) {
        throw new Error(
          "Metadata has already been fetched - you can't call fetchMeta() twice!",
        );
      }
      if (this.url != null) {
        this.rawData = await (await fetch(this.url)).text();
      }
      if (this.rawData instanceof Blob) {
        this.rawData = await stringifyBlob(this.rawData);
      }
      const metadata = JSON.parse(this.rawData);
      if (metadata.filename == null || typeof metadata.filename != "string") {
        throw new TypeError("metadata.filename must be a string!");
      }
      if (
        metadata.segments == null ||
        metadata.segments instanceof Array == false
      ) {
        throw new TypeError(
          "metadata.segments must be an non-empty string array!",
        );
      } else {
        if (metadata.segments.length == 0) {
          throw new TypeError("metadata.segments cannot be empty!");
        }
        for (const segment of metadata.segments) {
          if (typeof segment != "string") {
            throw new TypeError(
              `metadata.segments[${metadata.segments.indexOf(segment)}] must be a string!`,
            );
          }
        }
      }
      if (metadata.hash == null || typeof metadata.hash != "string") {
        throw new TypeError("metadata.hash must be a string!");
      }
      this.hash = metadata.hash;
      this.filename = metadata.filename;
      this.segments = metadata.segments.map(
        (segment) =>
          new LargeEPKSegment(
            isAbsoluteUrl(segment)
              ? segment
              : this.url != null
                ? segment.startsWith("/")
                  ? new URL(segment, window.location.href)
                  : joinUrls(
                      getParentUrl(
                        this.url instanceof URL
                          ? this.url.toString()
                          : this.url,
                      ).toString(),
                      segment,
                    )
                : segment,
          ),
      );
      this.rawData = undefined; // Free metadata string for GC after parsing
      this._totalSize = 0;
      return this;
    }

    /**
     * Fetch all segments with concurrency limit and throttled progress.
     *
     * BUG FIX: Progress no longer goes over 100%.
     * Previous bug: completed segments were double-counted — once in
     * completedCount AND once in segmentProgress[idx]=1. Now, when a
     * segment completes, segmentProgress[idx] is set to 0 (since it's
     * already counted via completedCount), so the formula
     * (completedCount + sum(segmentProgress)) / totalSegments stays
     * in [0, 1].
     */
    fetch() {
      if (this.segments === null) {
        throw new TypeError("Segments not initialized");
      }
      const eventTarget = new EventTarget();
      const promiseMeta = {};
      const ret = {
        percent: 0,
        progressCallback: eventTarget,
        promise: new Promise((res, rej) => {
          promiseMeta.res = res;
          promiseMeta.rej = rej;
        }),
      };

      const totalSegments = this.segments.length;
      let completedCount = 0;

      // segmentProgress[i] = 0..1 for in-progress segments, 0 for completed
      const segmentProgress = new Float64Array(totalSegments);

      // Throttled progress dispatcher — caps at 100%
      let lastProgressDispatch = 0;
      const dispatchProgress = (force) => {
        if (!force) {
          const now = performance.now();
          if (now - lastProgressDispatch < PROGRESS_THROTTLE_MS) return;
          lastProgressDispatch = now;
        }

        let ongoingSum = 0;
        for (let i = 0; i < totalSegments; i++)
          ongoingSum += segmentProgress[i];
        const rawPercent =
          ((completedCount + ongoingSum) / totalSegments) * 100;
        const progressEvent = new Event("progress");
        progressEvent.overallPercent = Math.min(rawPercent, 100);
        eventTarget.dispatchEvent(progressEvent);
      };

      // Worker pool: MAX_CONCURRENT_DOWNLOADS download slots
      let nextIndex = 0;

      const downloadWorker = async () => {
        while (nextIndex < totalSegments) {
          const idx = nextIndex++;
          const segment = this.segments[idx];
          const { promise: segmentPromise, eventTarget: segmentEventTarget } =
            segment.fetchSegment();

          // Update progress for in-progress segments
          segmentEventTarget.addEventListener("progress", () => {
            segmentProgress[idx] = Math.min(segment.progress / 100, 1);
            dispatchProgress(false);
          });

          await segmentPromise;
          completedCount++;
          // FIX: Set to 0, NOT 1 — segment is already counted via completedCount
          // Previously this was segmentProgress[idx] = 1, causing double-counting
          segmentProgress[idx] = 0;
          dispatchProgress(true); // Force dispatch on completion
        }
      };

      // Launch worker pool
      const concurrency = Math.min(MAX_CONCURRENT_DOWNLOADS, totalSegments);
      const workers = [];
      for (let i = 0; i < concurrency; i++) {
        workers.push(downloadWorker());
      }

      Promise.all(workers)
        .then(() => {
          const progressEvent = new Event("progress");
          progressEvent.overallPercent = 100;
          eventTarget.dispatchEvent(progressEvent);
          promiseMeta.res(this);
        })
        .catch((err) => {
          promiseMeta.rej(err);
        });
      return ret;
    }

    /**
     * Concatenate all segment data into a single ArrayBuffer.
     */
    getComplete() {
      let totalLength = 0;
      for (const segment of this.segments) {
        if (segment.data != null) {
          totalLength += segment.data.byteLength;
        } else {
          throw new Error(
            "One or more LargeEPKSegment(s) haven't been fetched yet. Did you call fetch() beforehand?",
          );
        }
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
      if (this.segments == null) {
        throw new Error("Segments are null!");
      }
      this.segments.forEach((segment) => segment.dispose());
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

    /**
     * Fetch this segment with streaming and progress tracking.
     * Progress is capped at 100% to prevent over-counting from
     * inaccurate Content-Length headers (e.g. gzipped responses).
     */
    fetchSegment() {
      if (this.data != null) {
        throw new TypeError("Cannot call fetchSegment() twice!");
      }
      const eventTarget = new EventTarget();
      const ret = {
        promise: undefined,
        percent: 100,
        eventTarget,
      };

      const promise = new Promise(async (res) => {
        const response = await fetch(this.url);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`,
          );
        }
        const contentLength = parseInt(
          response.headers.get("content-length") || "0",
          10,
        );
        if (response.body == null) {
          throw new Error("response.body is null! This shouldn't happen!");
        }
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;

          // Cap at 100% — Content-Length can be inaccurate with gzip
          const percent =
            contentLength > 0
              ? Math.min((loaded / contentLength) * 100, 100)
              : 100;
          const progressEvent = new Event("progress");
          progressEvent.percent = percent;
          ret.percent = percent;
          this.progress = percent;
          eventTarget.dispatchEvent(progressEvent);
        }

        // Concatenate chunks into a single Uint8Array
        let totalLength = 0;
        for (let i = 0; i < chunks.length; i++) {
          totalLength += chunks[i].byteLength;
        }
        const concatenatedArray = new Uint8Array(totalLength);
        let offset = 0;
        for (let i = 0; i < chunks.length; i++) {
          concatenatedArray.set(chunks[i], offset);
          offset += chunks[i].byteLength;
        }
        this.data = concatenatedArray;
        this.progress = 100;
        chunks.length = 0; // Free chunk references for GC
        res(this);
      });
      ret.promise = Promise.resolve(promise);
      return ret;
    }
  }
  EPKLib.LargeEPKSegment = LargeEPKSegment;
})(EPKLib || (EPKLib = {}));
