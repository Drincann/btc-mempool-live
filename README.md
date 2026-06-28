# BTC Mempool Live

Realtime Bitcoin mainnet mempool visualization.

The app subscribes to `wss://mempool.space/api/v1/ws`, draws short-lived address nodes, and animates representative transaction flow from input address to output address.

## Local preview

```bash
python -m http.server 5174
```

Open `http://127.0.0.1:5174/`.

## GitHub Pages WebSocket proxy

`mempool.space` may reject WebSocket connections from GitHub Pages browser origins. Deploy the included Cloudflare Worker proxy and point the frontend to it.

1. Install Wrangler:

```bash
npm install -g wrangler
```

2. Log in and deploy:

```bash
wrangler login
wrangler deploy
```

3. Copy the deployed Worker URL, convert it to `wss://`, and put it in `config.js`:

```js
window.BTC_MEMPOOL_WS_URL = "wss://btc-mempool-live-ws.<your-subdomain>.workers.dev/";
```

4. Commit and push `config.js`, then GitHub Pages will connect through the Worker.

For quick testing without editing `config.js`, pass the Worker URL as a query parameter:

```text
https://drincann.github.io/btc-mempool-live/?ws=wss://btc-mempool-live-ws.<your-subdomain>.workers.dev/
```
