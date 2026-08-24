interface Env {
  EGRESS: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/probe") {
      return new Response("not found", { status: 404 });
    }

    try {
      const response = await env.EGRESS.fetch(
        "https://chatgpt.com/backend-api/wham/usage",
        {
          headers: {
            accept: "application/json",
            "user-agent": "rueisiang-vpc-smoke/1.0",
          },
        },
      );
      const body = await response.text();
      return Response.json({
        ok: true,
        status: response.status,
        contentType: response.headers.get("content-type"),
        server: response.headers.get("server"),
        bodyPreview: body.slice(0, 256),
      });
    } catch (error) {
      return Response.json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
