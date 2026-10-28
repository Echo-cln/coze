import { isIP } from "node:net";

export const MAX_UPLOAD_FILES = 20;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_JSON_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_URLS = 20;

export async function readJsonWithLimit(request: Request, maxBytes: number): Promise<
  { ok: true; value: unknown } | { ok: false; reason: "too_large" | "invalid" }
> {
  if (!request.body) return { ok: false, reason: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(joined)) as unknown };
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    reader.releaseLock();
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exceedsContentLength(contentLength: string | null, limit: number): boolean {
  if (!contentLength) return false;
  const parsed = Number(contentLength);
  return !Number.isSafeInteger(parsed) || parsed < 0 || parsed > limit;
}

export function validateFiles(files: Array<Pick<File, "size" | "name">>): string | null {
  if (files.length > MAX_UPLOAD_FILES) return `单次最多上传 ${MAX_UPLOAD_FILES} 个文件`;
  const allowedExtensions = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md"]);
  let totalBytes = 0;
  for (const file of files) {
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (!extension || !allowedExtensions.has(extension)) return `文件 ${file.name} 的格式不受支持`;
    if (file.size <= 0) return `文件 ${file.name} 为空`;
    if (file.size > MAX_FILE_BYTES) return `单个文件不能超过 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB`;
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) return "单次上传总大小不能超过 100 MB";
  }
  return null;
}

export function normalizePublicHttpUrls(value: unknown): { urls: string[]; error: string | null } {
  if (!Array.isArray(value)) return { urls: [], error: "来源 URL 必须是数组" };
  if (value.length > MAX_SOURCE_URLS) return { urls: [], error: `单次最多添加 ${MAX_SOURCE_URLS} 个来源 URL` };

  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > 2048) {
      return { urls: [], error: "来源 URL 格式无效或超过 2048 字符" };
    }
    try {
      const url = new URL(item);
      if (!isPublicHttpUrl(url)) return { urls: [], error: "来源 URL 仅允许公网 HTTP/HTTPS 地址" };
      urls.push(url.href);
    } catch {
      return { urls: [], error: "来源 URL 格式无效" };
    }
  }
  return { urls, error: null };
}

function isPublicHttpUrl(url: URL): boolean {
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".test")) return false;

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const [a, b] = hostname.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)) return false;
  }
  // Permit only global unicast IPv6 addresses; this excludes loopback, link-local,
  // unique-local, unspecified, and IPv4-mapped addresses.
  if (ipVersion === 6 && !/^2[0-9a-f]{3}:/i.test(hostname)) return false;
  return true;
}
