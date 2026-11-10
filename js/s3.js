// Pure helpers for talking to public S3 buckets over the REST API.
// No DOM access here except parseListXml, which takes an already-parsed Document.

export const MAX_PAGE_SIZE = 1000; // S3 ListObjectsV2 caps max-keys at 1000

const TEXT_EXTENSIONS = new Set([
  "txt", "text", "log", "md", "markdown", "rst", "json", "jsonl", "ndjson", "geojson",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "csv", "tsv", "xml", "html", "htm",
  "py", "js", "ts", "sh", "r", "m", "c", "h", "cpp", "java", "sql", "tex", "bib",
  "nwb.json", "zattrs", "zarray", "zgroup", "zmetadata", "properties", "env", "svg",
]);
const TEXT_FILENAMES = new Set([
  "readme", "license", "licence", "changelog", "makefile", "dockerfile", ".gitignore",
  ".zattrs", ".zarray", ".zgroup", ".zmetadata",
]);

/**
 * Parse user input into { bucket, prefix, region }.
 * Accepts: "bucket", "bucket/prefix", "s3://bucket/prefix",
 * "https://bucket.s3[.region].amazonaws.com/prefix",
 * "https://s3[.region].amazonaws.com/bucket/prefix".
 * A non-empty prefix is normalized to end with "/" so it is treated as a folder;
 * the original is kept as `path` so callers can check whether it names an object.
 */
export function parseLocation(input) {
  let s = (input || "").trim();
  if (!s) return null;
  let bucket;
  let rest = "";
  let region = "";

  const httpMatch = s.match(/^https?:\/\/([^/]+)\/?(.*)$/i);
  if (httpMatch) {
    const host = httpMatch[1].toLowerCase();
    const path = safeDecode(httpMatch[2].split(/[?#]/)[0]);
    const vhost = host.match(/^(.+)\.s3[.-]?([a-z0-9-]*)\.amazonaws\.com$/);
    const pathStyle = host.match(/^s3[.-]?([a-z0-9-]*)\.amazonaws\.com$/);
    if (vhost) {
      bucket = vhost[1];
      region = cleanRegion(vhost[2]);
      rest = path;
    } else if (pathStyle) {
      region = cleanRegion(pathStyle[1]);
      const i = path.indexOf("/");
      bucket = i < 0 ? path : path.slice(0, i);
      rest = i < 0 ? "" : path.slice(i + 1);
    } else {
      return null;
    }
  } else {
    s = s.replace(/^s3:\/\//i, "").replace(/^\/+/, "");
    const i = s.indexOf("/");
    bucket = i < 0 ? s : s.slice(0, i);
    rest = i < 0 ? "" : s.slice(i + 1);
  }
  if (!bucket) return null;
  // `path` is the prefix as typed. Without a trailing "/" it may name an object.
  return { bucket, prefix: normalizePrefix(rest), path: rest.replace(/^\/+/, ""), region };
}

/** The folder containing a key: "a/b/c.json" -> "a/b/", "c.json" -> "". */
export function parentPrefix(key) {
  return key.slice(0, key.lastIndexOf("/") + 1);
}

/**
 * Parse the page's ?path= value, "bucket/prefix/" or "bucket/key".
 * A trailing "/" (or no part after the bucket) means a folder; otherwise it is
 * a file, shown in the viewer. Returns { bucket, prefix, key } or null.
 */
export function parsePathParam(value) {
  const v = (value || "").trim().replace(/^s3:\/\//i, "").replace(/^\/+/, "");
  if (!v) return null;
  const i = v.indexOf("/");
  const bucket = i < 0 ? v : v.slice(0, i);
  const rest = i < 0 ? "" : v.slice(i + 1);
  if (!rest || rest.endsWith("/")) return { bucket, prefix: rest, key: "" };
  return { bucket, prefix: parentPrefix(rest), key: rest };
}

/**
 * Build the page's query string. `path` is a prefix (ending in "/") or a key.
 * Slashes stay unescaped so links read like S3 URIs.
 */
export function buildQuery({ bucket, path = "", region = "", pageSize = 100, query = "" }) {
  if (!bucket) return "";
  let q = `?path=${encodeKey(path ? `${bucket}/${path}` : bucket)}`;
  if (query) q += `&q=${encodeURIComponent(query)}`;
  if (region) q += `&region=${encodeURIComponent(region)}`;
  if (pageSize !== 100) q += `&n=${pageSize}`;
  return q;
}

function cleanRegion(r) {
  return r && r !== "external-1" && r !== "website" ? r : "";
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function normalizePrefix(prefix) {
  const p = (prefix || "").replace(/^\/+/, "");
  return p && !p.endsWith("/") ? p + "/" : p;
}

/** Base HTTPS endpoint for a bucket, without trailing slash. */
export function bucketEndpoint(bucket, region = "") {
  // Dotted bucket names break TLS with virtual-hosted URLs, so use path style.
  if (bucket.includes(".")) {
    return region ? `https://s3.${region}.amazonaws.com/${bucket}` : `https://s3.amazonaws.com/${bucket}`;
  }
  return region ? `https://${bucket}.s3.${region}.amazonaws.com` : `https://${bucket}.s3.amazonaws.com`;
}

/** Percent-encode a key for use in a URL path, keeping "/" separators. */
export function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function objectUrl(bucket, key, region = "") {
  return `${bucketEndpoint(bucket, region)}/${encodeKey(key)}`;
}

export function s3Uri(bucket, key = "") {
  return `s3://${bucket}/${key}`;
}

export function listUrl({ bucket, prefix = "", region = "", pageSize = 100, token = null }) {
  const params = new URLSearchParams({ "list-type": "2", delimiter: "/", "max-keys": String(pageSize) });
  if (prefix) params.set("prefix", prefix);
  if (token) params.set("continuation-token", token);
  return `${bucketEndpoint(bucket, region)}/?${params}`;
}

export function clampPageSize(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 100;
  return Math.min(v, MAX_PAGE_SIZE);
}

/** Extract folders and files from a ListObjectsV2 XML Document. */
export function parseListXml(doc) {
  const text = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent ?? "";
  const err = doc.getElementsByTagName("Error")[0];
  if (err) {
    const e = new Error(text(err, "Message") || "S3 error");
    e.code = text(err, "Code");
    throw e;
  }
  const root = doc.documentElement;
  const folders = [...root.getElementsByTagName("CommonPrefixes")].map((cp) => ({
    type: "folder",
    key: text(cp, "Prefix"),
  }));
  const files = [...root.getElementsByTagName("Contents")].map((c) => ({
    type: "file",
    key: text(c, "Key"),
    size: Number(text(c, "Size")),
    lastModified: text(c, "LastModified"),
    storageClass: text(c, "StorageClass"),
  }));
  return {
    folders,
    files,
    isTruncated: text(root, "IsTruncated") === "true",
    nextToken: text(root, "NextContinuationToken") || null,
  };
}

/** Byte-order (code unit) comparison, matching S3's lexicographic listing order. */
export function lexCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort a page of entries. field: "name" | "size" | "modified"; dir: 1 or -1.
 * Folders always come before files. Ties fall back to name order.
 */
export function sortEntries(entries, field = "name", dir = 1) {
  const value = (e) => (field === "size" ? e.size ?? -1 : field === "modified" ? e.lastModified ?? "" : null);
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    if (field !== "name") {
      const va = value(a);
      const vb = value(b);
      if (va !== vb) return (va < vb ? -1 : 1) * dir;
    }
    return lexCompare(a.key, b.key) * (field === "name" ? dir : 1);
  });
}

/** Name of an entry relative to the current prefix. */
export function displayName(key, prefix) {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function formatSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function isPreviewable(key) {
  const name = key.split("/").pop().toLowerCase();
  if (TEXT_FILENAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1));
}

export function previewKind(key) {
  const name = key.toLowerCase();
  if (/\.(json|geojson|zattrs|zarray|zgroup|zmetadata)$/.test(name) || /\/\.z(attrs|array|group|metadata)$/.test(name)) return "json";
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".tsv")) return "tsv";
  return "text";
}

/** Minimal RFC 4180 parser. Returns rows (arrays of strings), up to maxRows. */
export function parseDelimited(text, delimiter = ",", maxRows = 500) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === "") inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length >= maxRows) return rows;
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
