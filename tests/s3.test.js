// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildQuery,
  bucketEndpoint,
  clampPageSize,
  displayName,
  encodeKey,
  formatSize,
  isPreviewable,
  listUrl,
  objectUrl,
  parseDelimited,
  parentPrefix,
  parseLocation,
  parsePathParam,
  previewKind,
  s3Uri,
  sortEntries,
} from "../js/s3.js";

test("parseLocation handles common input forms", () => {
  const loc = (s) => {
    const r = parseLocation(s);
    return r && [r.bucket, r.prefix, r.path, r.region];
  };
  assert.deepEqual(loc("aind-open-data"), ["aind-open-data", "", "", ""]);
  assert.deepEqual(loc("s3://aind-open-data/foo/bar"), ["aind-open-data", "foo/bar/", "foo/bar", ""]);
  assert.deepEqual(loc("aind-open-data/foo/"), ["aind-open-data", "foo/", "foo/", ""]);
  assert.deepEqual(loc("https://aind-open-data.s3.us-west-2.amazonaws.com/a/b/"), ["aind-open-data", "a/b/", "a/b/", "us-west-2"]);
  assert.deepEqual(loc("https://aind-open-data.s3.amazonaws.com/a%20b/x.json"), ["aind-open-data", "a b/x.json/", "a b/x.json", ""]);
  assert.deepEqual(loc("https://s3.us-east-2.amazonaws.com/my.bucket/x"), ["my.bucket", "x/", "x", "us-east-2"]);
  assert.deepEqual(loc("https://s3.amazonaws.com/openneuro.org/"), ["openneuro.org", "", "", ""]);
  assert.equal(parseLocation(""), null);
  assert.equal(parseLocation("https://example.com/foo"), null);
});

test("parentPrefix", () => {
  assert.equal(parentPrefix("a/b/c.json"), "a/b/");
  assert.equal(parentPrefix("c.json"), "");
  assert.equal(parentPrefix("a/b/"), "a/b/");
});

test("endpoints use virtual-hosted style unless the bucket has dots", () => {
  assert.equal(bucketEndpoint("b"), "https://b.s3.amazonaws.com");
  assert.equal(bucketEndpoint("b", "us-west-2"), "https://b.s3.us-west-2.amazonaws.com");
  assert.equal(bucketEndpoint("a.b"), "https://s3.amazonaws.com/a.b");
  assert.equal(bucketEndpoint("a.b", "eu-west-1"), "https://s3.eu-west-1.amazonaws.com/a.b");
});

test("keys are encoded per segment", () => {
  assert.equal(encodeKey("a b/c#d/e+f.json"), "a%20b/c%23d/e%2Bf.json");
  assert.equal(objectUrl("b", "x/y z.txt"), "https://b.s3.amazonaws.com/x/y%20z.txt");
  assert.equal(s3Uri("b", "x/y"), "s3://b/x/y");
});

test("listUrl includes paging parameters", () => {
  const u = new URL(listUrl({ bucket: "b", prefix: "p/", pageSize: 25, token: "abc+/=" }));
  assert.equal(u.searchParams.get("list-type"), "2");
  assert.equal(u.searchParams.get("delimiter"), "/");
  assert.equal(u.searchParams.get("max-keys"), "25");
  assert.equal(u.searchParams.get("prefix"), "p/");
  assert.equal(u.searchParams.get("continuation-token"), "abc+/=");
});

test("clampPageSize bounds to 1..1000", () => {
  assert.equal(clampPageSize("50"), 50);
  assert.equal(clampPageSize(5000), 1000);
  assert.equal(clampPageSize(0), 100);
  assert.equal(clampPageSize("x"), 100);
});

test("sortEntries: folders first, lexicographic by default", () => {
  const entries = [
    { type: "file", key: "p/b.txt", size: 5, lastModified: "2024-01-02" },
    { type: "file", key: "p/B.txt", size: 50, lastModified: "2024-01-01" },
    { type: "folder", key: "p/z/" },
    { type: "file", key: "p/a.txt", size: 1, lastModified: "2024-01-03" },
    { type: "folder", key: "p/a/" },
  ];
  assert.deepEqual(sortEntries(entries).map((e) => e.key), ["p/a/", "p/z/", "p/B.txt", "p/a.txt", "p/b.txt"]);
  assert.deepEqual(sortEntries(entries, "name", -1).map((e) => e.key), ["p/z/", "p/a/", "p/b.txt", "p/a.txt", "p/B.txt"]);
  assert.deepEqual(sortEntries(entries, "size", -1).map((e) => e.key), ["p/a/", "p/z/", "p/B.txt", "p/b.txt", "p/a.txt"]);
  assert.deepEqual(sortEntries(entries, "modified").map((e) => e.key), ["p/a/", "p/z/", "p/B.txt", "p/b.txt", "p/a.txt"]);
});

test("display helpers", () => {
  assert.equal(displayName("p/q/r.txt", "p/q/"), "r.txt");
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(50 * 1024 * 1024), "50 MB");
});

test("preview detection", () => {
  for (const k of ["a/b.txt", "x.JSON", "c.yaml", "d.yml", "e.csv", "f.tsv", "README", "z/.zattrs", "m.md"]) {
    assert.ok(isPreviewable(k), k);
  }
  for (const k of ["a.zarr/0/0", "img.tif", "data.nwb", "x.h5"]) assert.ok(!isPreviewable(k), k);
  assert.equal(previewKind("a.json"), "json");
  assert.equal(previewKind("a.zarr/.zattrs"), "json");
  assert.equal(previewKind("a.csv"), "csv");
  assert.equal(previewKind("a.tsv"), "tsv");
  assert.equal(previewKind("a.yaml"), "text");
});

test("parseDelimited handles quotes and CRLF", () => {
  assert.deepEqual(parseDelimited('a,b\r\n1,"x, ""y"""\n2,z'), [
    ["a", "b"],
    ["1", 'x, "y"'],
    ["2", "z"],
  ]);
  assert.deepEqual(parseDelimited("a\tb\n1\t2\n", "\t"), [
    ["a", "b"],
    ["1", "2"],
  ]);
  assert.equal(parseDelimited("a\nb\nc\nd\n", ",", 2).length, 2);
});

test("path query parameter round-trips", () => {
  assert.deepEqual(parsePathParam("aind-open-data"), { bucket: "aind-open-data", prefix: "", key: "" });
  assert.deepEqual(parsePathParam("aind-open-data/"), { bucket: "aind-open-data", prefix: "", key: "" });
  assert.deepEqual(parsePathParam("b/a/c/"), { bucket: "b", prefix: "a/c/", key: "" });
  assert.deepEqual(parsePathParam("b/a/c.json"), { bucket: "b", prefix: "a/", key: "a/c.json" });
  assert.deepEqual(parsePathParam("s3://b/x.txt"), { bucket: "b", prefix: "", key: "x.txt" });
  assert.equal(parsePathParam(""), null);
  assert.equal(parsePathParam(null), null);

  assert.equal(buildQuery({ bucket: "" }), "");
  assert.equal(buildQuery({ bucket: "b" }), "?path=b");
  assert.equal(buildQuery({ bucket: "b", path: "a/c/", region: "us-west-2", pageSize: 50 }), "?path=b/a/c/&region=us-west-2&n=50");
  assert.equal(buildQuery({ bucket: "b", path: "a/", query: "x y&z" }), "?path=b/a/&q=x%20y%26z");
  // Characters that are special in query strings are escaped; slashes are not.
  const q = buildQuery({ bucket: "b", path: "x y/a+b&c=d#e?.csv" });
  assert.equal(q, "?path=b/x%20y/a%2Bb%26c%3Dd%23e%3F.csv");
  assert.deepEqual(parsePathParam(new URLSearchParams(q).get("path")), { bucket: "b", prefix: "x y/", key: "x y/a+b&c=d#e?.csv" });
});
