const WS_URL =
  window.BTC_MEMPOOL_WS_URL ||
  new URLSearchParams(window.location.search).get("ws") ||
  "wss://mempool.space/api/v1/ws";
const MAX_VISIBLE = 18;
const MAX_PROJECTILES = 120;
const MAX_TRAILS = 180;
const ADDRESS_TTL_MS = 10_000;
const BATCH_SPREAD_MS = 2_200;
const SATS_PER_BTC = 100_000_000;

const state = {
  socket: null,
  connected: false,
  paused: false,
  reconnectTimer: null,
  reconnectDelay: 1200,
  total: 0,
  recentTimestamps: [],
  feeSamples: [],
  addresses: new Map(),
  pendingTransfers: [],
  projectiles: [],
  trails: [],
  hoveredAddress: null,
};

const els = {
  connection: document.querySelector("#connection"),
  connectionText: document.querySelector("#connectionText"),
  totalCount: document.querySelector("#totalCount"),
  latestAmount: document.querySelector("#latestAmount"),
  avgFee: document.querySelector("#avgFee"),
  rate: document.querySelector("#rate"),
  list: document.querySelector("#transactionList"),
  empty: document.querySelector("#emptyState"),
  template: document.querySelector("#transactionTemplate"),
  pauseButton: document.querySelector("#pauseButton"),
  clearButton: document.querySelector("#clearButton"),
  canvas: document.querySelector("#txCanvas"),
};

const ctx = els.canvas.getContext("2d");

els.canvas.addEventListener("mousemove", (event) => {
  const node = findAddressNodeAt(event);
  state.hoveredAddress = node?.address || null;
  els.canvas.style.cursor = node ? "pointer" : "default";
});

els.canvas.addEventListener("mouseleave", () => {
  state.hoveredAddress = null;
  els.canvas.style.cursor = "default";
});

els.canvas.addEventListener("click", (event) => {
  const node = findAddressNodeAt(event);
  if (!node) return;

  const url = `https://www.blockchain.com/explorer/addresses/btc/${encodeURIComponent(node.address)}`;
  window.open(url, "_blank", "noopener,noreferrer");
});

function connect() {
  setConnection("connecting", "连接中");
  clearTimeout(state.reconnectTimer);

  try {
    state.socket = new WebSocket(WS_URL);
  } catch (error) {
    scheduleReconnect();
    return;
  }

  state.socket.addEventListener("open", () => {
    state.connected = true;
    state.reconnectDelay = 1200;
    setConnection("live", "实时在线");
    state.socket.send(JSON.stringify({ "track-mempool": true }));
  });

  state.socket.addEventListener("message", (event) => {
    const payload = parseMessage(event.data);
    if (!payload) return;

    const transactions = extractTransactions(payload);
    if (transactions.length > 0) handleTransactionBatch(transactions);
  });

  state.socket.addEventListener("close", scheduleReconnect);
  state.socket.addEventListener("error", () => {
    setConnection("error", "连接异常");
  });
}

function parseMessage(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function extractTransactions(payload) {
  if (Array.isArray(payload?.["mempool-transactions"]?.added)) {
    return payload["mempool-transactions"].added;
  }

  if (payload?.op === "utx" && payload.x) {
    return [payload.x];
  }

  return [];
}

function handleTransactionBatch(transactions) {
  if (state.paused) return;
  const now = Date.now();
  const normalized = transactions.map(normalizeTransaction);
  if (normalized.length === 0) return;

  state.total += normalized.length;
  state.recentTimestamps = state.recentTimestamps
    .filter((time) => now - time < 60_000)
    .concat(Array.from({ length: normalized.length }, () => now));

  normalized.forEach((tx, index) => {
    if (Number.isFinite(tx.feeBtc) && tx.feeBtc > 0) {
      state.feeSamples.push(tx.feeBtc);
    }
    queueTransfer(tx, index, normalized.length, now);
  });

  evictExpiredAddresses(now);
  state.feeSamples = state.feeSamples.slice(-24);
  updateMetrics(normalized[normalized.length - 1]);
}

function scheduleReconnect() {
  state.connected = false;
  setConnection("error", "重连中");
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(connect, state.reconnectDelay);
  state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, 12000);
}

function setConnection(mode, text) {
  els.connection.classList.toggle("is-live", mode === "live");
  els.connection.classList.toggle("is-error", mode === "error");
  els.connectionText.textContent = text;
}

function handleTransaction(tx) {
  const normalized = normalizeTransaction(tx);
  state.total += 1;
  state.recentTimestamps.push(Date.now());
  state.recentTimestamps = state.recentTimestamps.filter((time) => Date.now() - time < 60_000);

  if (Number.isFinite(normalized.feeBtc) && normalized.feeBtc > 0) {
    state.feeSamples.push(normalized.feeBtc);
    state.feeSamples = state.feeSamples.slice(-24);
  }

  queueTransfer(normalized, 0, 1, Date.now());
  evictExpiredAddresses(Date.now());
  updateMetrics(normalized);
}

function normalizeTransaction(tx) {
  const outputs = Array.isArray(tx.vout) ? tx.vout : Array.isArray(tx.out) ? tx.out : [];
  const inputs = Array.isArray(tx.vin) ? tx.vin : Array.isArray(tx.inputs) ? tx.inputs : [];
  const outputSats = outputs.reduce((sum, output) => sum + (Number(output.value) || 0), 0);
  const inputSats = inputs.reduce((sum, input) => {
    const value = Number(input.prevout?.value ?? input.prev_out?.value);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  const feeSats = Number.isFinite(Number(tx.fee))
    ? Number(tx.fee)
    : inputSats > outputSats
      ? inputSats - outputSats
      : null;
  const hash = tx.txid || tx.hash || tx.h || crypto.randomUUID();
  const from = pickInputAddress(inputs);
  const to = pickOutputAddress(outputs, from.address);

  return {
    hash,
    shortHash: `${hash.slice(0, 12)}...${hash.slice(-12)}`,
    time: new Date((Number(tx.time) || Date.now() / 1000) * 1000),
    inputs: inputs.length,
    outputs: outputs.length,
    valueBtc: outputSats / SATS_PER_BTC,
    feeBtc: feeSats ? feeSats / SATS_PER_BTC : null,
    fromAddress: from.address,
    toAddress: to.address,
    transferBtc: to.value / SATS_PER_BTC,
  };
}

function pickInputAddress(inputs) {
  return inputs.reduce(
    (best, input) => {
      const address = input.prevout?.scriptpubkey_address || input.prev_out?.addr || "";
      const value = Number(input.prevout?.value ?? input.prev_out?.value) || 0;
      if (!address || value <= best.value) return best;
      return { address, value };
    },
    { address: "", value: 0 },
  );
}

function pickOutputAddress(outputs, fromAddress) {
  const usable = outputs
    .map((output) => ({
      address: output.scriptpubkey_address || output.addr || "",
      value: Number(output.value) || 0,
    }))
    .filter((output) => output.address);

  const nonChange = usable.filter((output) => output.address !== fromAddress);
  const candidates = nonChange.length > 0 ? nonChange : usable;

  return candidates.reduce(
    (best, output) => (output.value > best.value ? output : best),
    { address: "", value: 0 },
  );
}

function insertTransaction(tx) {
  insertTransactionBatch([tx]);
}

function insertTransactionBatch(transactions) {
  if (transactions.length === 0) return;
  els.empty?.remove();

  const existingCards = [...els.list.querySelectorAll(".tx-card")];
  const firstPositions = new Map(existingCards.map((card) => [card, card.getBoundingClientRect()]));
  const fragment = document.createDocumentFragment();
  const newCards = transactions
    .slice()
    .reverse()
    .map((tx, index) => createTransactionCard(tx, index));

  newCards.forEach((card) => fragment.append(card));
  els.list.prepend(fragment);

  const nextCards = [...els.list.querySelectorAll(".tx-card")];
  nextCards.forEach((item) => {
    const first = firstPositions.get(item);
    if (!first) return;

    const last = item.getBoundingClientRect();
    const deltaY = first.top - last.top;
    item.animate(
      [
        { transform: `translateY(${deltaY}px)` },
        { transform: "translateY(0)" },
      ],
      {
        duration: 520,
        easing: "cubic-bezier(0.2, 0.74, 0.18, 1)",
      },
    );
  });

  requestAnimationFrame(() => {
    newCards.forEach((card) => card.classList.add("is-new"));
    setTimeout(() => newCards.forEach((card) => card.classList.remove("is-new")), 940);
  });

  trimCards();
}

function createTransactionCard(tx, index = 0) {
  const fragment = els.template.content.cloneNode(true);
  const card = fragment.querySelector(".tx-card");
  const hashLink = fragment.querySelector(".tx-hash");
  const time = fragment.querySelector(".tx-time");
  const inputs = fragment.querySelector(".tx-inputs");
  const outputs = fragment.querySelector(".tx-outputs");
  const value = fragment.querySelector(".tx-value strong");
  const fee = fragment.querySelector(".tx-value span");

  hashLink.href = `https://www.blockchain.com/explorer/transactions/btc/${tx.hash}`;
  hashLink.textContent = tx.shortHash;
  hashLink.title = tx.hash;
  time.textContent = tx.time.toLocaleTimeString("zh-CN", { hour12: false });
  inputs.textContent = `${tx.inputs} inputs`;
  outputs.textContent = `${tx.outputs} outputs`;
  value.textContent = formatBtc(tx.valueBtc);
  fee.textContent = tx.feeBtc ? `fee ${formatBtc(tx.feeBtc)}` : "fee unknown";
  card.style.setProperty("--entry-delay", `${Math.min(index * 46, 520)}ms`);

  return card;
}

function trimCards() {
  const cards = [...els.list.querySelectorAll(".tx-card")];
  cards.slice(MAX_VISIBLE).forEach((card) => {
    card.classList.add("is-removing");
    setTimeout(() => card.remove(), 260);
  });
}

function queueTransfer(tx, batchIndex = 0, batchSize = 1, now = Date.now()) {
  const batchSpread = batchSize > 1 ? BATCH_SPREAD_MS : 0;
  const scheduledAt = now + Math.random() * batchSpread;

  state.pendingTransfers.push({ tx, scheduledAt });
}

function flushScheduledTransfers(now) {
  if (state.pendingTransfers.length === 0) return;

  const pending = [];
  state.pendingTransfers.forEach((item) => {
    if (item.scheduledAt <= now) {
      emitAddressTransfer(item.tx, now);
      insertTransaction(item.tx);
    } else {
      pending.push(item);
    }
  });

  state.pendingTransfers = pending;
}

function emitAddressTransfer(tx, now = Date.now()) {
  if (!tx.fromAddress || !tx.toAddress || tx.fromAddress === tx.toAddress) return;

  const from = touchAddress(tx.fromAddress, "from");
  const to = touchAddress(tx.toAddress, "to", from);
  const amountScale = Math.min(1, Math.log10(tx.transferBtc + 1) / 1.6);
  const startsAt = now + Math.random() * 90;

  from.hot = 1;
  to.hot = 1;
  from.sent += 1;
  to.received += 1;

  state.projectiles.push({
    from,
    to,
    startsAt,
    duration: 820 + Math.random() * 520,
    size: 3.5 + amountScale * 7,
    glow: 0.55 + amountScale * 0.45,
    amount: tx.transferBtc,
  });

  state.trails.push({
    from,
    to,
    created: startsAt,
    width: 1 + amountScale * 2.8,
  });

  state.projectiles = state.projectiles.slice(-MAX_PROJECTILES);
  state.trails = state.trails.slice(-MAX_TRAILS);
}

function touchAddress(address, role, anchor) {
  let node = state.addresses.get(address);

  if (!node) {
    node = createAddressNode(address, role, anchor);
    state.addresses.set(address, node);
  }

  node.lastSeen = Date.now();
  node.role = role;
  node.count += 1;
  node.birth = Math.min(1, node.birth + 0.35);

  return node;
}

function createAddressNode(address, role, anchor) {
  const width = Math.max(1, els.canvas.clientWidth);
  const height = Math.max(1, els.canvas.clientHeight);
  const margin = 34;

  let x = margin + Math.random() * Math.max(1, width - margin * 2);
  let y = margin + Math.random() * Math.max(1, height - margin * 2);

  if (anchor) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 90 + Math.random() * 120;
    x = anchor.x + Math.cos(angle) * distance;
    y = anchor.y + Math.sin(angle) * distance;
  }

  return {
    address,
    role,
    x: clamp(x, margin, width - margin),
    y: clamp(y, margin, height - margin),
    vx: (Math.random() - 0.5) * 0.35,
    vy: (Math.random() - 0.5) * 0.35,
    count: 0,
    sent: 0,
    received: 0,
    labelAlpha: 0,
    hot: 0,
    birth: 1,
    bornAt: Date.now(),
    lastSeen: Date.now(),
  };
}

function evictExpiredAddresses(now = Date.now()) {
  state.addresses.forEach((node, address) => {
    if (now - node.lastSeen > ADDRESS_TTL_MS) {
      state.addresses.delete(address);
    }
  });
}

function updateMetrics(tx) {
  els.totalCount.textContent = new Intl.NumberFormat("zh-CN").format(state.total);
  els.latestAmount.textContent = formatBtc(tx.valueBtc);
  els.rate.textContent = `${state.recentTimestamps.length}/min`;

  if (state.feeSamples.length > 0) {
    const avg = state.feeSamples.reduce((sum, fee) => sum + fee, 0) / state.feeSamples.length;
    els.avgFee.textContent = formatBtc(avg);
  }

  [els.totalCount, els.latestAmount, els.avgFee, els.rate].forEach((node) => {
    node.classList.remove("stat-pop");
    requestAnimationFrame(() => node.classList.add("stat-pop"));
  });
}

function formatBtc(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 100) return `${value.toFixed(1)} BTC`;
  if (value >= 1) return `${value.toFixed(3)} BTC`;
  if (value >= 0.01) return `${value.toFixed(4)} BTC`;
  return `${value.toFixed(8)} BTC`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resizeCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  els.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  els.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function draw() {
  const width = els.canvas.clientWidth;
  const height = els.canvas.clientHeight;
  const now = Date.now();

  flushScheduledTransfers(now);
  evictExpiredAddresses(now);
  ctx.clearRect(0, 0, width, height);

  drawAddressEdges(now);
  drawAddressNodes(width, height, now);
  drawProjectiles(now);

  requestAnimationFrame(draw);
}

function drawAddressEdges(now) {
  state.trails = state.trails.filter(
    (trail) =>
      now - trail.created < ADDRESS_TTL_MS &&
      state.addresses.has(trail.from.address) &&
      state.addresses.has(trail.to.address),
  );

  state.trails.forEach((trail) => {
    const age = now - trail.created;
    if (age < 0) return;
    const alpha = Math.max(0, 1 - age / ADDRESS_TTL_MS) * 0.22;
    ctx.lineWidth = trail.width;
    ctx.strokeStyle = `rgba(77, 213, 255, ${alpha})`;
    ctx.beginPath();
    ctx.moveTo(trail.from.x, trail.from.y);
    ctx.lineTo(trail.to.x, trail.to.y);
    ctx.stroke();
  });
}

function drawAddressNodes(width, height, now) {
  const margin = 18;
  const nodes = [...state.addresses.values()];
  const labels = [];

  nodes.forEach((node) => {
    node.x += node.vx;
    node.y += node.vy;

    if (node.x < margin || node.x > width - margin) node.vx *= -1;
    if (node.y < margin || node.y > height - margin) node.vy *= -1;

    node.x = clamp(node.x, margin, width - margin);
    node.y = clamp(node.y, margin, height - margin);
    node.hot *= 0.9;
    node.birth *= 0.965;

    const appear = easeOutCubic(Math.min(1, (now - node.bornAt) / 680));
    const ageAlpha = Math.max(0.18, 1 - (now - node.lastSeen) / ADDRESS_TTL_MS);
    const radius = getNodeRadius(node) * (0.2 + appear * 0.8);
    const hue = node.role === "from" ? 42 : 191;
    const isHovered = state.hoveredAddress === node.address;
    const shouldGlow = isHovered || node.hot > 0.08;

    ctx.beginPath();
    ctx.fillStyle = `hsla(${hue}, 92%, 64%, ${ageAlpha * appear})`;
    if (shouldGlow) {
      ctx.shadowColor = `hsla(${hue}, 92%, 64%, ${0.22 + node.hot * 0.48 + (isHovered ? 0.28 : 0)})`;
      ctx.shadowBlur = 5 + node.hot * 15 + (isHovered ? 14 : 0);
    }
    ctx.arc(node.x, node.y, radius + (isHovered ? 4 : 0), 0, Math.PI * 2);
    ctx.fill();
    if (shouldGlow) ctx.shadowBlur = 0;

    const shouldShowLabel = isHovered || node.hot > 0.2 || now - node.lastSeen < 1400;
    const targetLabelAlpha = shouldShowLabel ? 1 : 0;
    node.labelAlpha += (targetLabelAlpha - node.labelAlpha) * 0.16;

    if (node.labelAlpha > 0.03) {
      labels.push({
        node,
        alpha: node.labelAlpha,
        priority: (isHovered ? 10 : 0) + node.hot + (now - node.lastSeen < 1400 ? 1 : 0),
      });
    }
  });

  labels
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 12)
    .forEach(({ node, alpha }) => drawAddressLabel(node, alpha));
}

function getNodeRadius(node) {
  const activityCount = node.sent + node.received;
  return 2.2 + Math.min(12, Math.log2(activityCount + 1) * 2.1) + node.hot * 7;
}

function findAddressNodeAt(event) {
  const rect = els.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let closest = null;
  let closestDistance = Infinity;

  state.addresses.forEach((node) => {
    const radius = Math.max(10, getNodeRadius(node) + 6);
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance <= radius && distance < closestDistance) {
      closest = node;
      closestDistance = distance;
    }
  });

  return closest;
}

function drawAddressLabel(node, alpha = 1) {
  const label = `${node.address.slice(0, 6)}...${node.address.slice(-4)}`;
  const x = node.x + 10;
  const y = node.y - 10;
  const width = Math.min(112, 54 + label.length * 6);

  ctx.fillStyle = `rgba(9, 10, 13, ${0.72 * alpha})`;
  ctx.strokeStyle = `rgba(255, 255, 255, ${0.12 * alpha})`;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y - 15, width, 23, 5);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = `rgba(244, 247, 251, ${0.86 * alpha})`;
  ctx.font = "11px Consolas, monospace";
  ctx.fillText(label, x + 7, y);
}

function drawProjectiles(now) {
  state.projectiles = state.projectiles.filter(
    (shot) =>
      now - shot.startsAt < shot.duration &&
      state.addresses.has(shot.from.address) &&
      state.addresses.has(shot.to.address),
  );

  state.projectiles.forEach((shot) => {
    if (now < shot.startsAt) return;

    const rawProgress = Math.min(1, (now - shot.startsAt) / shot.duration);
    const t = easeOutCubic(rawProgress);
    const x = shot.from.x + (shot.to.x - shot.from.x) * t;
    const y = shot.from.y + (shot.to.y - shot.from.y) * t;
    const tailT = Math.max(0, easeOutCubic(Math.max(0, rawProgress - 0.08)));
    const tailX = shot.from.x + (shot.to.x - shot.from.x) * tailT;
    const tailY = shot.from.y + (shot.to.y - shot.from.y) * tailT;

    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(77, 213, 255, ${0.22 + shot.glow * 0.28})`;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(x, y);
    ctx.stroke();

    ctx.beginPath();
    ctx.fillStyle = `rgba(246, 184, 74, ${0.7 + shot.glow * 0.3})`;
    ctx.shadowColor = "rgba(246, 184, 74, 0.9)";
    ctx.shadowBlur = 18 + shot.size * 1.8;
    ctx.arc(x, y, shot.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  });
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - Math.min(value, 1), 3);
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
}

els.pauseButton.addEventListener("click", () => {
  state.paused = !state.paused;
  els.pauseButton.setAttribute("aria-pressed", String(state.paused));
  els.pauseButton.querySelector("span").textContent = state.paused ? "继续" : "暂停";
  els.pauseButton.querySelector("svg use");
});

els.clearButton.addEventListener("click", () => {
  state.pendingTransfers = [];
  state.addresses.clear();
  state.projectiles = [];
  state.trails = [];
  els.list.querySelectorAll(".tx-card").forEach((card) => card.remove());
  if (!document.querySelector("#emptyState")) {
    els.list.append(els.empty);
  }
});

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
draw();
connect();

if (window.lucide) {
  window.lucide.createIcons();
}
