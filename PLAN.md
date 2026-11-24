# Plan

## Goal

A minimal, dependency-free static page for browsing public S3 buckets like a file system, hosted on GitHub Pages.

## Approach

- Call the S3 REST API (`ListObjectsV2` with `delimiter=/`) directly from the browser; no SDK, no backend.
- Virtual-hosted URLs (`https://<bucket>.s3.amazonaws.com`) route to any region; dotted bucket names use path-style URLs with an optional region.
- Paging uses S3 continuation tokens, which are forward-only, so the app keeps the tokens it has seen for Prev/First.
- Previews fetch at most 5 MiB with a `Range` request.
- Videos are not fetched by the app: a `<video>` element streams them from S3 with range requests, so they have no size limit.
- Search is S3's own prefix match (`prefix` = folder + typed text), so it covers the whole folder, not just the loaded page. Kept in the URL as `q`.
- A `?path=` without a trailing `/` names a file; if no such file exists but a folder does, the folder opens. Empty folder-marker objects (key equal to the folder) are hidden.
- Pure logic lives in `js/s3.js` and is unit-tested with `node --test`; DOM code is in `js/app.js`.

## Open questions

- Support S3-compatible endpoints (MinIO, R2, GCS interop) via a custom endpoint field?
- Jump to an arbitrary page number, or keep the page in the URL (both require walking tokens)?
- Host somewhere other than GitHub Pages? (#13)
