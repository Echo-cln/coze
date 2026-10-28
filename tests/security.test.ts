import assert from "node:assert/strict";
import test from "node:test";
import { renderInlineSafe } from "../src/lib/safe-markdown";
import {
  exceedsContentLength,
  normalizePublicHttpUrls,
  validateFiles,
  MAX_FILE_BYTES,
} from "../src/lib/request-validation";

test("report inline rendering escapes HTML and rejects active URL schemes", () => {
  const rendered = renderInlineSafe('<img src=x onerror=alert(1)> [click](javascript:alert(1))');
  assert.match(rendered, /&lt;img/);
  assert.doesNotMatch(rendered, /<img|<script/i);
  assert.doesNotMatch(rendered, /href="javascript:/i);
  assert.match(rendered, /click/);
});

test("safe report links retain only HTTP(S) and escaped attributes", () => {
  const rendered = renderInlineSafe('[source](https://example.com/report?a=1&b=2)');
  assert.match(rendered, /href="https:\/\/example\.com\/report\?a=1&amp;b=2"/);
  assert.match(rendered, /rel="noopener noreferrer"/);
});

test("source URL validation blocks local and private network targets", () => {
  for (const url of ["http://localhost/admin", "http://127.0.0.1/", "http://10.0.0.1/", "http://[::1]/", "file:///etc/passwd"]) {
    assert.ok(normalizePublicHttpUrls([url]).error, `${url} should be rejected`);
  }
  assert.deepEqual(normalizePublicHttpUrls(["https://example.com/a"]).urls, ["https://example.com/a"]);
});

test("request and upload limits reject malformed and oversized input", () => {
  assert.equal(exceedsContentLength("512", 1024), false);
  assert.equal(exceedsContentLength("not-a-number", 1024), true);
  assert.equal(exceedsContentLength("2048", 1024), true);
  assert.match(validateFiles([{ name: "large.pdf", size: MAX_FILE_BYTES + 1 }]) || "", /不能超过/);
});
