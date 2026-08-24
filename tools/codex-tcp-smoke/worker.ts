import { connect } from "cloudflare:sockets";

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/probe") {
      return new Response("not found", { status: 404 });
    }

    try {
      const socket = connect(
        { hostname: "chatgpt.com", port: 443 },
        { secureTransport: "on" },
      );
      const writer = socket.writable.getWriter();
      await writer.write(
        new TextEncoder().encode(
          "GET /backend-api/codex/responses HTTP/1.1\r\n" +
            "Host: chatgpt.com\r\n" +
            "Accept: text/event-stream\r\n" +
            "Connection: close\r\n\r\n",
        ),
      );
      writer.releaseLock();
      const reader = socket.readable.getReader();
      const first = await reader.read();
      await socket.close();
      return Response.json({ ok: true, firstChunk: first.value?.byteLength ?? 0 });
    } catch (error) {
      return Response.json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
