import type { Tool } from "../../types.js";
import { fetchWithRetry } from "../../llm/base.js";

const MAX_BYTES = 600_000;
const MAX_TEXT = 40_000;

/** Strip tags/scripts/styles and collapse whitespace into readable text. */
function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Preserve some structure
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = s.replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ");
  s = s.replace(/<[^>]+>/g, "");
  // Entities
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Reject non-public hosts to avoid SSRF against localhost / metadata services. */
function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`无效的 URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`仅支持 http/https: ${raw}`);
  const host = u.hostname.toLowerCase();
  const blocked = [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "169.254.169.254", // cloud metadata
    "metadata.google.internal",
  ];
  if (blocked.includes(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`出于安全考虑，拒绝访问内网/本地地址: ${host}`);
  }
  // Private IPv4 ranges
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127) {
      throw new Error(`出于安全考虑，拒绝访问内网地址: ${host}`);
    }
  }
  return u;
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a public http(s) URL and return its text content (HTML is converted to readable text). " +
    "Use for reading documentation, release notes or a specific web page. Private/local addresses are blocked.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full http(s) URL." },
      maxChars: { type: "number", description: "Max characters of text to return (default 20000)." },
      raw: { type: "boolean", description: "Return raw response body instead of extracted text." },
    },
    required: ["url"],
  },
  async execute(input, ctx) {
    const { url, maxChars = 20_000, raw } = input as { url: string; maxChars?: number; raw?: boolean };

    let target: URL;
    try {
      target = assertPublicUrl(url);
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    const decision = await ctx.requestPermission({
      kind: "network",
      title: `访问网络`,
      detail: `GET ${target.toString()}`,
      key: `web_fetch:${target.host}`,
    });
    if (decision === "deny") return { content: "用户拒绝访问该网络地址。", isError: true };

    try {
      const res = await fetchWithRetry(
        target.toString(),
        {
          method: "GET",
          headers: {
            "user-agent": "AemeathAgent/0.1 (+https://github.com/)",
            accept: "text/html,application/json,text/plain,*/*",
          },
          redirect: "follow",
        },
        { signal: ctx.signal, retries: 2 },
      );
      if (!res.ok) {
        return { content: `请求失败 (${res.status} ${res.statusText})`, isError: true };
      }
      const buf = await res.arrayBuffer();
      const slice = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
      const body = new TextDecoder().decode(slice);
      const contentType = res.headers.get("content-type") ?? "";

      let text = raw || !/html/i.test(contentType) ? body : htmlToText(body);
      const limit = Math.min(maxChars, MAX_TEXT);
      let truncated = false;
      if (text.length > limit) {
        text = text.slice(0, limit);
        truncated = true;
      }
      return {
        content: `# ${target.toString()}\n${contentType}\n\n${text}${truncated ? "\n\n... [内容已截断]" : ""}`,
        display: { url: target.toString(), bytes: slice.byteLength, truncated },
      };
    } catch (err) {
      return {
        content: `抓取失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
