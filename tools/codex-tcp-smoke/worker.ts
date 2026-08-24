import { connect } from "cloudflare:sockets";

const TARGET = { hostname: "chatgpt.com", port: 443 };
const REQUEST = [
  "GET /backend-api/codex/responses HTTP/1.1",
  "Host: chatgpt.com",
  "Accept: text/event-stream",
  "Connection: close",
  "",
  "",
].join("\r\n");

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function headerEnd(bytes: Uint8Array): number {
  for (let index = 3; index < bytes.length; index += 1) {
    if (bytes[index - 3] === 13 && bytes[index - 2] === 10 && bytes[index - 1] === 13 && bytes[index] === 10) {
      return index + 1;
    }
  }
  return -1;
}

async function readResponseHeaders(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let bytes = new Uint8Array();
  while (bytes.length < 64 * 1024) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) bytes = append(bytes, value);
    const end = headerEnd(bytes);
    if (end >= 0) return new TextDecoder().decode(bytes.slice(0, end));
  }
  throw new Error("upstream response headers not received");
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/probe") return new Response("Not found", { status: 404 });

    let socket: ReturnType<typeof connect> | undefined;
    try {
      socket = connect(TARGET, { secureTransport: "on" });
      const opened = await socket.opened;
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode(REQUEST));
      await writer.close();
      const reader = socket.readable.getReader();
      const headers = await readResponseHeaders(reader);
      await reader.cancel();
      return Response.json({ ok: true, remoteAddress: opened.remoteAddress, headers });
    } catch (error) {
      return Response.json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await socket?.close().catch(() => undefined);
    }
  },
};
