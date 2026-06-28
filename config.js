// GitHub Pages cannot reliably connect to mempool.space directly because the
// public WebSocket may reject browser Origin headers. Set this to your
// Cloudflare Worker WebSocket URL after deploying worker/ws-proxy.js.
window.BTC_MEMPOOL_WS_URL = "wss://btc-mempool-live-ws.1019933576.workers.dev";
