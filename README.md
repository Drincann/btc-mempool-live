# BTC Mempool Live

Realtime Bitcoin mainnet mempool visualization.

The app subscribes to `wss://mempool.space/api/v1/ws`, draws short-lived address nodes, and animates representative transaction flow from input address to output address.

## Local preview

```bash
python -m http.server 5174
```

Open `http://127.0.0.1:5174/`.

