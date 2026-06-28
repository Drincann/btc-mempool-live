const UPSTREAM_WS_URL = "wss://mempool.space/api/v1/ws";

export default {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket endpoint. Use wss:// for browser clients.", {
        status: 426,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    const pair = new WebSocketPair();
    const [client, browserSocket] = Object.values(pair);
    browserSocket.accept();

    let upstreamSocket;
    const pendingMessages = [];

    const closeBoth = (code = 1011, reason = "proxy closed") => {
      try {
        browserSocket.close(code, reason);
      } catch {}

      try {
        upstreamSocket?.close(code, reason);
      } catch {}
    };

    try {
      upstreamSocket = new WebSocket(UPSTREAM_WS_URL);

      upstreamSocket.addEventListener("open", () => {
        while (pendingMessages.length > 0 && upstreamSocket.readyState === WebSocket.OPEN) {
          upstreamSocket.send(pendingMessages.shift());
        }
      });

      upstreamSocket.addEventListener("message", (event) => {
        if (browserSocket.readyState === WebSocket.OPEN) {
          browserSocket.send(event.data);
        }
      });

      upstreamSocket.addEventListener("close", () => closeBoth(1011, "upstream closed"));
      upstreamSocket.addEventListener("error", () => closeBoth(1011, "upstream error"));

      browserSocket.addEventListener("message", (event) => {
        if (upstreamSocket.readyState === WebSocket.OPEN) {
          upstreamSocket.send(event.data);
        } else {
          pendingMessages.push(event.data);
        }
      });

      browserSocket.addEventListener("close", () => {
        try {
          upstreamSocket.close(1000, "browser closed");
        } catch {}
      });
    } catch {
      closeBoth(1011, "proxy setup failed");
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  },
};
