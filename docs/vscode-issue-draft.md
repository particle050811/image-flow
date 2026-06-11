Title:

Webview resource cache grows unboundedly: media-preview cache-busts with Date.now(), service worker never evicts (21+ GB observed)

Body:

<!-- ⚠️⚠️ Do Not Delete This! bug_report_template ⚠️⚠️ -->
Does this issue occur when all extensions are disabled?: Yes
(media-preview and the webview service worker are built-in, so `--disable-extensions` does not affect the leak.)

- VS Code Version: 1.123.2 (commit 3c631b164c239e7aeaaae7c626b46c527b361af2, x64)
- OS Version: Windows 11 Pro 10.0.26200 (also observed under WSL Remote – Ubuntu)

## Summary

`%APPDATA%\Code\WebStorage\<n>\CacheStorage` grew to **23.5 GB** on my machine.
I parsed the Chromium simple-cache entry keys to find out why. The root cause is a
combination of two pieces of built-in code:

1. **media-preview cache-busts with the current time, not the file version.**
   `extensions/media-preview/src/imagePreview/index.ts` (`getResourcePath`) appends
   `?version=${Date.now()}` on **every render**. Every time an image is opened or
   re-rendered, the URL is brand new — even if the file is unchanged.

2. **The webview service worker caches every response and never evicts.**
   `src/vs/workbench/contrib/webview/browser/pre/service-worker.js` does
   `cache.put(event.request, ...)` for every 200 response with an ETag, keyed by the
   full URL including the query string. The file contains no eviction, expiry, or
   quota logic. The `activate` handler doesn't even delete caches from previous
   `VERSION`s — my disk holds both `vscode-resource-cache-4` (2.09 GB) and
   `vscode-resource-cache-5` (21.38 GB).

Combined effect: **every view of an image permanently writes a full copy to disk**,
and each copy is dead on arrival — the `Date.now()` query string guarantees no future
request can ever hit it.

## Evidence (from parsing the cache entry keys)

My 21.38 GB cache origin contains 6,413 entries:

- They map to only **1,947 unique files** (1,013 files cached ≥ 2 times).
- The most-viewed image was cached **86 times within a single hour** (one evening,
  up to 9 copies in one minute) — per-render, not per-modification.
- In a sample of the 200 most-duplicated paths, **81% point to files that no longer
  exist** on disk.
- Zero video/audio entries: `<video>` uses Range requests (206), which the SW marks
  `no-store` and the Cache API cannot store anyway. The leak therefore only bites
  image-heavy workflows and grows slowly enough to evade detection — which is
  presumably why earlier reports (#131226, #166632 [145 GB], #152519 [500 GB]) died
  as "cannot reproduce" / stale.

## Steps to Reproduce

1. Note the size of `%APPDATA%\Code\WebStorage` (`du -sh ~/.config/Code/WebStorage` on Linux).
2. Launch `code --disable-extensions` and open a large PNG (e.g. 20 MB) in the
   built-in image preview.
3. Close the tab and reopen the same file 10 times.
4. The folder grows by ~10 × the image size. None of the new entries can ever be
   read back (each was stored under a unique `?version=<timestamp>` URL), and they
   are never cleaned up.

## Expected

Either of:
- media-preview keys the cache-busting parameter on the file's mtime instead of
  `Date.now()`, so unchanged files reuse one cache entry; and/or
- the service worker evicts stale versions of the same base URL when caching a new
  one, applies an LRU/size cap to `vscode-resource-cache-*`, and deletes
  previous-`VERSION` caches on activate.

## Related

#131226 (closed as stale, "needs repro"), #166632 (145 GB, closed as duplicate),
#152519 (500 GB, closed as duplicate), #310384 (open, 30 GB via Remote-SSH — same
mechanism; this report adds the root-cause analysis).
