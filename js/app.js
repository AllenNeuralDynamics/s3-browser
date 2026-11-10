import {
  clampPageSize,
  displayName,
  formatSize,
  isPreviewable,
  listUrl,
  normalizePrefix,
  objectUrl,
  parseDelimited,
  parseListXml,
  parseLocation,
  previewKind,
  s3Uri,
  sortEntries,
} from "./s3.js?v=dev"; // ?v= is replaced with the commit hash at deploy time

const PREVIEW_BYTES = 1024 * 1024; // fetch at most 1 MiB for previews
const CSV_MAX_ROWS = 500;
const VIEW_BYTES = 10 * 1024 * 1024; // full-page view fetches at most 10 MiB
const VIEW_CSV_MAX_ROWS = 5000;
const PAGE_SIZE_KEY = "s3-browser:page-size";

const $ = (id) => document.getElementById(id);

const ICON_ATTRS = 'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const COPY_ICON = `<svg ${ICON_ATTRS}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg ${ICON_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>`;

const state = {
  bucket: "",
  prefix: "",
  key: "", // set in full-page file view
  region: "",
  pageSize: 100,
  page: 0, // zero-based
  tokens: [null], // tokens[i] = continuation token that fetches page i
  isTruncated: false,
  entries: [],
  sort: { field: "name", dir: 1 },
  requestId: 0,
};

// ---------- URL state ----------

function readUrl() {
  const p = new URLSearchParams(location.search);
  return {
    bucket: (p.get("bucket") || "").trim(),
    prefix: normalizePrefix(p.get("prefix") || ""),
    key: p.get("key") || "",
    region: (p.get("region") || "").trim(),
    pageSize: p.has("n") ? clampPageSize(p.get("n")) : storedPageSize(),
  };
}

function writeUrl(push) {
  const p = new URLSearchParams();
  if (state.bucket) p.set("bucket", state.bucket);
  if (state.prefix) p.set("prefix", state.prefix);
  if (state.region) p.set("region", state.region);
  if (state.bucket && state.pageSize !== 100) p.set("n", String(state.pageSize));
  const qs = p.toString();
  const url = `${location.pathname}${qs ? "?" + qs : ""}`;
  if (url === `${location.pathname}${location.search}`) return;
  (push ? history.pushState : history.replaceState).call(history, null, "", url);
}

function storedPageSize() {
  try {
    return clampPageSize(localStorage.getItem(PAGE_SIZE_KEY) || 100);
  } catch {
    return 100;
  }
}

function storePageSize(n) {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(n));
  } catch {
    /* storage unavailable */
  }
}

// ---------- navigation ----------

function navigate({ bucket, prefix, region }, push = true) {
  state.bucket = bucket;
  state.prefix = normalizePrefix(prefix);
  state.key = "";
  state.region = region ?? state.region;
  resetPaging();
  writeUrl(push);
  render();
}

function resetPaging() {
  state.page = 0;
  state.tokens = [null];
  state.isTruncated = false;
}

function loadFromUrl() {
  const u = readUrl();
  state.bucket = u.bucket;
  state.prefix = u.prefix;
  state.key = u.key;
  state.region = u.region;
  state.pageSize = u.pageSize;
  resetPaging();
  render();
}

async function render() {
  const viewing = !!(state.bucket && state.key);
  const uri = state.bucket ? s3Uri(state.bucket, viewing ? state.key : state.prefix) : "";
  $("location-input").value = uri;
  $("region-input").value = state.region;
  syncPageSizeControl();
  $("welcome").hidden = !!state.bucket;
  $("browser").hidden = !state.bucket || viewing;
  $("viewer").hidden = !viewing;
  document.title = uri ? `${uri} · S3 Browser` : "S3 Browser";
  if (!state.bucket) return;
  if (viewing) return renderFileView();
  renderBreadcrumbs($("breadcrumbs"), state.prefix, "", $("copy-current"));
  await loadPage();
}

async function loadPage() {
  const id = ++state.requestId;
  const { bucket, prefix, region, pageSize, page } = state;
  setStatus("Loading…");
  setPagingDisabled(true);
  let result;
  try {
    const res = await fetch(listUrl({ bucket, prefix, region, pageSize, token: state.tokens[page] }));
    const body = await res.text();
    const doc = new DOMParser().parseFromString(body, "application/xml");
    if (!res.ok && !doc.getElementsByTagName("Error").length) {
      throw Object.assign(new Error(`HTTP ${res.status}`), { code: String(res.status) });
    }
    result = parseListXml(doc);
  } catch (err) {
    if (id !== state.requestId) return;
    state.entries = [];
    renderRows();
    setStatus(describeError(err), true);
    updatePaging();
    return;
  }
  if (id !== state.requestId) return; // a newer request superseded this one
  state.entries = [...result.folders, ...result.files];
  state.isTruncated = result.isTruncated;
  if (result.nextToken) state.tokens[page + 1] = result.nextToken;
  renderRows();
  const n = state.entries.length;
  setStatus(n ? "" : page === 0 ? "This folder is empty." : "No more items.");
  updatePaging();
}

function describeError(err) {
  switch (err.code) {
    case "AccessDenied":
    case "403":
      return "Access denied. This bucket (or prefix) does not allow anonymous listing.";
    case "NoSuchBucket":
    case "404":
      return "No such bucket.";
    case "PermanentRedirect":
    case "AuthorizationHeaderMalformed":
    case "IllegalLocationConstraintException":
      return `Wrong region for this bucket. ${err.message} Try clearing or setting the region field.`;
    default:
      if (err instanceof TypeError) {
        return "Request failed. The bucket may not exist, may not send CORS headers (required for browser access), or the network is down. For bucket names with dots outside us-east-1, set the region.";
      }
      return `Error${err.code ? ` (${err.code})` : ""}: ${err.message}`;
  }
}

// ---------- rendering ----------

/**
 * Breadcrumbs for a folder prefix, optionally ending in a file name.
 * `trailing` (the copy button) is placed right after the last crumb.
 */
function renderBreadcrumbs(nav, prefix, fileName = "", trailing = null) {
  nav.replaceChildren();
  const parts = prefix.split("/").filter(Boolean);
  const crumb = (label, prefix, current) => {
    const el = document.createElement(current ? "span" : "a");
    el.textContent = label;
    if (current) el.setAttribute("aria-current", "page");
    else {
      el.href = hrefFor(state.bucket, prefix);
      el.addEventListener("click", (e) => {
        if (isModified(e)) return;
        e.preventDefault();
        navigate({ bucket: state.bucket, prefix });
      });
    }
    nav.append(el);
  };
  const sep = () => {
    const el = document.createElement("span");
    el.className = "sep";
    el.textContent = "/";
    nav.append(el);
  };
  crumb(state.bucket, "", !fileName && parts.length === 0);
  let acc = "";
  parts.forEach((part, i) => {
    acc += part + "/";
    sep();
    crumb(part, acc, !fileName && i === parts.length - 1);
  });
  if (fileName) {
    sep();
    crumb(fileName, null, true);
  }
  if (trailing) nav.append(trailing);
}

function hrefFor(bucket, prefix) {
  const p = new URLSearchParams({ bucket });
  if (prefix) p.set("prefix", prefix);
  if (state.region) p.set("region", state.region);
  if (state.pageSize !== 100) p.set("n", String(state.pageSize));
  return `?${p}`;
}

function viewHref(bucket, key) {
  const p = new URLSearchParams({ bucket, key });
  if (state.region) p.set("region", state.region);
  return `?${p}`;
}

function isModified(e) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

function renderRows() {
  const tbody = $("listing-body");
  const rows = sortEntries(state.entries, state.sort.field, state.sort.dir).map(renderRow);
  tbody.replaceChildren(...rows);
  for (const btn of document.querySelectorAll("th button[data-sort]")) {
    const active = btn.dataset.sort === state.sort.field;
    btn.parentElement.setAttribute("aria-sort", active ? (state.sort.dir > 0 ? "ascending" : "descending") : "none");
    btn.dataset.arrow = active ? (state.sort.dir > 0 ? "▲" : "▼") : "";
  }
}

function renderRow(entry) {
  const tr = document.createElement("tr");
  tr.className = entry.type;
  const name = displayName(entry.key, state.prefix);

  const tdName = document.createElement("td");
  tdName.className = "col-name";
  const icon = document.createElement("span");
  icon.className = `icon icon-${entry.type}`;
  icon.setAttribute("aria-hidden", "true");
  tdName.append(icon);

  if (entry.type === "folder") {
    const a = document.createElement("a");
    a.href = hrefFor(state.bucket, entry.key);
    a.textContent = name;
    a.addEventListener("click", (e) => {
      if (isModified(e)) return;
      e.preventDefault();
      navigate({ bucket: state.bucket, prefix: entry.key });
    });
    tdName.append(a);
  } else if (isPreviewable(entry.key)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link";
    b.textContent = name;
    b.title = "Preview";
    b.addEventListener("click", () => openPreview(entry));
    tdName.append(b);
  } else {
    const span = document.createElement("span");
    span.textContent = name;
    tdName.append(span);
  }

  const tdSize = document.createElement("td");
  tdSize.className = "col-size";
  if (entry.type === "file") {
    tdSize.textContent = formatSize(entry.size);
    tdSize.title = `${entry.size.toLocaleString()} bytes`;
  }

  const tdMod = document.createElement("td");
  tdMod.className = "col-modified";
  if (entry.lastModified) {
    const d = new Date(entry.lastModified);
    tdMod.textContent = formatDate(d);
    tdMod.title = entry.lastModified;
  }

  const tdAct = document.createElement("td");
  tdAct.className = "col-actions";
  tdAct.append(copyButton(s3Uri(state.bucket, entry.key)));
  if (entry.type === "file") {
    // Text files open in the in-app viewer: many are stored as binary/octet-stream,
    // which browsers download, and S3 rejects content-type overrides on anonymous requests.
    const viewable = isPreviewable(entry.key);
    const a = document.createElement("a");
    a.href = viewable ? viewHref(state.bucket, entry.key) : objectUrl(state.bucket, entry.key, state.region);
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "action-link";
    a.textContent = "Open";
    a.title = viewable ? "View in a new tab" : "Open the HTTPS URL in a new tab";
    tdAct.append(a);
  }

  tr.append(tdName, tdSize, tdMod, tdAct);
  return tr;
}

function formatDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function copyButton(text) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "copy-btn";
  b.innerHTML = COPY_ICON;
  b.title = `Copy ${text}`;
  b.setAttribute("aria-label", `Copy ${text}`);
  b.addEventListener("click", () => copy(text, b));
  return b;
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) {
      toast("Copy failed");
      return;
    }
  }
  toast(`Copied ${text}`);
  if (button) {
    button.innerHTML = CHECK_ICON;
    clearTimeout(button._resetTimer);
    button._resetTimer = setTimeout(() => (button.innerHTML = COPY_ICON), 1200);
  }
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  // A modal dialog sits in the top layer, so the toast must live inside it to be visible.
  const host = $("preview").open ? $("preview") : document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = !msg;
}

// ---------- paging ----------

function updatePaging() {
  const start = state.page * state.pageSize + 1;
  const n = state.entries.length;
  $("page-info").textContent = n ? `Page ${state.page + 1} · items ${start.toLocaleString()}–${(start + n - 1).toLocaleString()}` : `Page ${state.page + 1}`;
  $("first-page").disabled = state.page === 0;
  $("prev-page").disabled = state.page === 0;
  $("next-page").disabled = !state.isTruncated || !state.tokens[state.page + 1];
}

function setPagingDisabled(disabled) {
  for (const id of ["first-page", "prev-page", "next-page"]) $(id).disabled = disabled;
}

function goToPage(page) {
  state.page = page;
  loadPage();
  window.scrollTo({ top: 0 });
}

function syncPageSizeControl() {
  const sel = $("page-size");
  const custom = $("page-size-custom");
  const preset = [...sel.options].some((o) => o.value === String(state.pageSize));
  sel.value = preset ? String(state.pageSize) : "custom";
  custom.hidden = preset;
  custom.value = String(state.pageSize);
}

function setPageSize(n) {
  const size = clampPageSize(n);
  storePageSize(size);
  if (size === state.pageSize) return;
  state.pageSize = size;
  resetPaging();
  writeUrl(false);
  syncPageSizeControl();
  loadPage();
}

// ---------- file viewer (preview dialog and full-page view) ----------

// A viewer renders one text file into a set of elements. The preview dialog
// and the full-page view (?bucket=…&key=…) each have one.
function makeViewer(ids, maxBytes, maxRows) {
  return {
    body: $(ids.body),
    notice: $(ids.notice),
    toggle: $(ids.toggle),
    maxBytes,
    maxRows,
    key: "",
    size: null, // bytes, or null if unknown
    raw: "",
    truncated: false,
    kind: "text",
    showRaw: false,
    requestId: 0,
  };
}

const dialogViewer = makeViewer({ body: "preview-body", notice: "preview-notice", toggle: "preview-toggle" }, PREVIEW_BYTES, CSV_MAX_ROWS);
const pageViewer = makeViewer({ body: "viewer-body", notice: "viewer-notice", toggle: "viewer-toggle" }, VIEW_BYTES, VIEW_CSV_MAX_ROWS);

/** Fetch up to v.maxBytes of a file and render it. size may be null (unknown). */
async function loadIntoViewer(v, key, size) {
  const id = ++v.requestId;
  v.key = key;
  v.size = size;
  v.kind = previewKind(key);
  v.showRaw = false;
  v.toggle.hidden = true;
  v.notice.hidden = true;
  v.body.replaceChildren(textBlock("Loading…"));
  try {
    const res = await fetch(objectUrl(state.bucket, key, state.region), { headers: { Range: `bytes=0-${v.maxBytes - 1}` } });
    if (res.status === 416) {
      v.raw = ""; // empty object: any byte range is unsatisfiable
    } else if (!res.ok) {
      throw new Error(res.status === 403 ? "access denied" : res.status === 404 ? "file not found" : `HTTP ${res.status}`);
    } else {
      const buf = await res.arrayBuffer();
      v.raw = new TextDecoder("utf-8", { fatal: false }).decode(buf.byteLength > v.maxBytes ? buf.slice(0, v.maxBytes) : buf);
      v.truncated = size != null ? size > v.maxBytes : buf.byteLength >= v.maxBytes;
    }
  } catch (err) {
    if (id !== v.requestId) return;
    v.body.replaceChildren(textBlock(`Could not load file: ${err.message}`));
    return;
  }
  if (id !== v.requestId) return;
  v.toggle.hidden = v.kind === "text";
  renderViewer(v);
}

function renderViewer(v) {
  v.toggle.textContent = v.showRaw ? "Formatted" : "Raw";
  const notes = [];
  if (v.truncated) notes.push(`Showing the first ${formatSize(v.maxBytes)}${v.size != null ? ` of ${formatSize(v.size)}` : ""}.`);
  const show = (el) => {
    v.body.replaceChildren(el);
    v.notice.textContent = notes.join(" ");
    v.notice.hidden = !notes.length;
  };
  if (v.showRaw || v.kind === "text") return show(textBlock(v.raw));
  if (v.kind === "json") {
    if (v.truncated) return show(textBlock(v.raw));
    try {
      return show(textBlock(JSON.stringify(JSON.parse(v.raw), null, 2)));
    } catch {
      return show(textBlock(v.raw));
    }
  }
  // csv / tsv
  let text = v.raw;
  if (v.truncated) text = text.slice(0, text.lastIndexOf("\n") + 1); // drop partial last line
  const rows = parseDelimited(text, v.kind === "tsv" ? "\t" : ",", v.maxRows + 1);
  if (rows.length > v.maxRows) notes.push(`Showing the header and first ${v.maxRows.toLocaleString()} rows.`);
  show(csvTable(rows));
}

function openPreview(entry) {
  const dlg = $("preview");
  $("preview-name").textContent = entry.key.split("/").pop();
  $("preview-meta").textContent = formatSize(entry.size);
  $("preview-open").href = viewHref(state.bucket, entry.key);
  if (!dlg.open) dlg.showModal();
  loadIntoViewer(dialogViewer, entry.key, entry.size);
}

async function renderFileView() {
  const key = state.key;
  const slash = key.lastIndexOf("/");
  renderBreadcrumbs($("viewer-breadcrumbs"), key.slice(0, slash + 1), key.slice(slash + 1), $("viewer-copy"));
  $("viewer-meta").textContent = "";
  $("viewer-raw").href = objectUrl(state.bucket, key, state.region);
  // HEAD gives the size (Content-Length is readable cross-origin); fall back to unknown.
  let size = null;
  try {
    const res = await fetch(objectUrl(state.bucket, key, state.region), { method: "HEAD" });
    const len = res.ok ? res.headers.get("content-length") : null;
    if (len != null) size = Number(len);
  } catch {
    /* size stays unknown */
  }
  if (key !== state.key) return;
  if (size != null) $("viewer-meta").textContent = formatSize(size);
  await loadIntoViewer(pageViewer, key, size);
}

function textBlock(text) {
  const pre = document.createElement("pre");
  pre.textContent = text;
  return pre;
}

function csvTable(rows) {
  const table = document.createElement("table");
  table.className = "csv";
  if (!rows.length) return table;
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of rows[0]) {
    const th = document.createElement("th");
    th.textContent = h;
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement("tbody");
  for (const r of rows.slice(1)) {
    const tr = document.createElement("tr");
    for (const c of r) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}
// ---------- wiring ----------

function init() {
  $("location-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const loc = parseLocation($("location-input").value);
    if (!loc) {
      toast("Enter a bucket name, s3:// URI, or S3 https URL");
      return;
    }
    const regionField = $("region-input").value.trim();
    navigate({ ...loc, region: regionField || loc.region });
  });

  $("page-size").addEventListener("change", (e) => {
    if (e.target.value === "custom") {
      const custom = $("page-size-custom");
      custom.hidden = false;
      custom.focus();
      custom.select();
    } else setPageSize(e.target.value);
  });
  $("page-size-custom").addEventListener("change", (e) => setPageSize(e.target.value));

  $("first-page").addEventListener("click", () => goToPage(0));
  $("prev-page").addEventListener("click", () => goToPage(Math.max(0, state.page - 1)));
  $("next-page").addEventListener("click", () => goToPage(state.page + 1));

  for (const btn of document.querySelectorAll("th button[data-sort]")) {
    btn.addEventListener("click", () => {
      const field = btn.dataset.sort;
      state.sort = state.sort.field === field ? { field, dir: -state.sort.dir } : { field, dir: 1 };
      renderRows();
    });
  }

  $("copy-current").addEventListener("click", (e) => copy(s3Uri(state.bucket, state.prefix), e.currentTarget));

  $("preview-close").addEventListener("click", () => $("preview").close());
  $("preview").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close(); // click on backdrop
  });
  $("preview-copy").addEventListener("click", (e) => dialogViewer.key && copy(s3Uri(state.bucket, dialogViewer.key), e.currentTarget));
  $("viewer-copy").addEventListener("click", (e) => copy(s3Uri(state.bucket, state.key), e.currentTarget));
  for (const v of [dialogViewer, pageViewer]) {
    v.toggle.addEventListener("click", () => {
      v.showRaw = !v.showRaw;
      renderViewer(v);
    });
  }

  // Example links and home link: handle in-app instead of full reload.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.examples-link, .examples a, #home-link");
    if (!a || isModified(e)) return;
    e.preventDefault();
    history.pushState(null, "", a.getAttribute("href"));
    loadFromUrl();
  });

  window.addEventListener("popstate", loadFromUrl);
  loadFromUrl();
}

init();
