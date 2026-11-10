# s3-browser

A static web page for browsing public (anonymous-read) Amazon S3 buckets as folders. It runs entirely in the browser: no server, no build step, no credentials.

**Live:** https://allenneuraldynamics.github.io/s3-browser/

## Features

- Folder-style navigation over `/`-delimited prefixes, with breadcrumbs and browser back/forward
- Paging with a configurable page size (1–1000 items per page)
- Lexicographic order by default (S3's native order); size and date sorting within a page
- Previews for text files (txt, md, json, yaml, csv, tsv, xml, Zarr metadata, …). JSON is pretty-printed; CSV/TSV render as a table. Large files are previewed from their first 1 MiB.
- Copy-to-clipboard buttons for full `s3://bucket/key` URIs
- Light, dark, or system color theme, remembered per browser

## Usage

Open the page and enter a bucket in any of these forms:

```
aind-open-data
aind-open-data/some/prefix/
s3://aind-open-data/some/prefix/
https://aind-open-data.s3.us-west-2.amazonaws.com/some/prefix/
```

The location is kept in the URL (`?bucket=…&prefix=…&n=…`), so links to a folder can be shared.

Requirements on the bucket:

- It allows anonymous `ListBucket` and `GetObject`.
- It returns CORS headers for `GET` (and allows the `Range` header for previews of large files). Without CORS the browser blocks the request.
- For bucket names containing dots outside `us-east-1`, fill in the region field.

## Development

Plain HTML, CSS, and ES modules. Serve the directory with any static server:

```
python3 -m http.server 8000
```

Unit tests for the helpers in `js/s3.js` use Node's built-in test runner (Node 22+), with no dependencies:

```
node --test
```

Pushes to `main` deploy to GitHub Pages via [.github/workflows/pages.yml](.github/workflows/pages.yml), which replaces `?v=dev` in asset URLs with the commit hash so browsers never mix cached old files with new ones. Reference any new script or stylesheet with `?v=dev`. See [PLAN.md](PLAN.md) for direction.
