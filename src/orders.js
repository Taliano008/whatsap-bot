const memoryOrders = new Map();
const pendingOrders = new Map();
const { appendOrderRow, getOrderRows, updateOrderStatusRow } = require("./sheets");
const { detectLanguage } = require("./language");

const ORDER_TRIGGERS = [
  "i want to order",
  "i want to buy",
  "i'd like to order",
  "id like to order",
  "place an order",
  "can i order",
  "i'll take",
  "ill take",
  "purchase",
  "buy now",
  "order now",
  "i want",
  "i need",
  "nataka kununua",
  "nataka kuorder",
  "naomba",
  "nipe",
  "niletee",
  "nitake",
  "order ya",
];

function getDb() {
  return require("./sessions").getDb();
}

function generateOrderId() {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `ORD-${date}-${rand}`;
}

function normalizeText(text) {
  return String(text || "").trim().toLowerCase();
}

function isOrderRequest(text) {
  const normalized = normalizeText(text);
  return ORDER_TRIGGERS.some((trigger) => normalized.includes(trigger));
}

function isConfirmation(text) {
  return /^(yes|y|yeah|yep|confirm|confirmed|ok|okay|sawa|ndio|ndiyo)\b/i.test(normalizeText(text));
}

function isCancellation(text) {
  return /^(no|n|nope|nah|cancel|stop|not today|hapana)\b/i.test(normalizeText(text));
}

function hasPendingOrder(phone) {
  return pendingOrders.has(phone);
}

function setPendingOrder(phone, order) {
  if (!order) {
    pendingOrders.delete(phone);
    return;
  }

  pendingOrders.set(phone, {
    ...order,
    language: order.language || detectLanguage(`${order.product || ""}`),
  });
}

function getPendingOrder(phone) {
  return pendingOrders.get(phone);
}

function clearPendingOrder(phone) {
  pendingOrders.delete(phone);
}

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("en-KE");
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function sheetOrderToOrder(row) {
  return {
    orderId: row.orderId,
    phone: row.phone,
    name: row.name,
    items: row.product,
    status: normalizeStatus(row.status || "pending"),
    location: row.notes || "",
    createdAt: row.timestamp ? new Date(row.timestamp) : new Date(0),
    updatedAt: row.timestamp ? new Date(row.timestamp) : new Date(0),
    total: row.total,
  };
}

async function getSheetOrders() {
  try {
    return (await getOrderRows()).map(sheetOrderToOrder);
  } catch (err) {
    console.warn("Sheet order lookup failed:", err.message);
    return [];
  }
}

async function logOrderToSheet(phone, customerName, pending) {
  const orderId = generateOrderId();
  const timestamp = new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" });

  await appendOrderRow({
    orderId,
    timestamp,
    customerName,
    phone: `+${phone}`,
    product: pending.product,
    quantity: pending.quantity,
    unitPrice: pending.price,
    total: pending.total,
    status: "Pending",
    notes: "",
  });

  return orderId;
}

function buildConfirmationMessage(order) {
  const sw = order.language === "sw";

  if (sw) {
    return [
      "Hii ndiyo muhtasari wa order yako:",
      "",
      `Bidhaa: ${order.product}`,
      `Idadi: ${order.quantity}`,
      `Bei: KSh ${formatMoney(order.price)} kila moja`,
      `Jumla: KSh ${formatMoney(order.total)}`,
      "",
      "Kuthibitisha, jibu NDIYO.",
      "Kufuta, jibu HAPANA.",
    ].join("\n");
  }

  return [
    "Here's your order summary:",
    "",
    `Product: ${order.product}`,
    `Quantity: ${order.quantity}`,
    `Price: KSh ${formatMoney(order.price)} each`,
    `Total: KSh ${formatMoney(order.total)}`,
    "",
    "To confirm, reply YES.",
    "To cancel, reply NO.",
    "",
    `Payment via M-Pesa Paybill ${process.env.MPESA_PAYBILL || "123456"} after confirmation.`,
  ].join("\n");
}

function buildSuccessMessage(orderId, order) {
  const sw = order.language === "sw";
  const paybill = process.env.MPESA_PAYBILL || "123456";

  if (sw) {
    return [
      "Order imethibitishwa!",
      "",
      `Order ID: ${orderId}`,
      `Bidhaa: ${order.product}`,
      `Jumla: KSh ${formatMoney(order.total)}`,
      "",
      "Hatua inayofuata: Lipa kupitia M-Pesa",
      `Paybill: ${paybill}`,
      `Account: ${orderId}`,
      "",
      "Tutathibitisha delivery tukipokea malipo. Asante!",
    ].join("\n");
  }

  return [
    "Order confirmed!",
    "",
    `Order ID: ${orderId}`,
    `Product: ${order.product}`,
    `Total: KSh ${formatMoney(order.total)}`,
    "",
    "Next step: Pay via M-Pesa",
    `Paybill: ${paybill}`,
    `Account: ${orderId}`,
    "",
    "We'll confirm delivery details once payment is received. Thank you!",
  ].join("\n");
}

async function createOrder({ phone, name, items, location }) {
  const orderId = generateOrderId();
  const now = new Date();
  const order = {
    orderId,
    phone,
    name,
    items,
    status: "pending",
    location,
    createdAt: now,
    updatedAt: now,
    history: [{ status: "pending", at: now }],
  };

  const db = getDb();
  if (db) {
    await db.collection("orders").insertOne(order);
  } else {
    memoryOrders.set(orderId, { ...order });
  }
  return order;
}

async function getOrdersByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  const db = getDb();
  const ordersById = new Map();

  if (db) {
    const dbOrders = await db
      .collection("orders")
      .find({ phone: normalizedPhone })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
    dbOrders.forEach((order) => ordersById.set(order.orderId, order));
  } else {
    [...memoryOrders.values()]
      .filter((o) => normalizePhone(o.phone) === normalizedPhone)
      .forEach((order) => ordersById.set(order.orderId, order));
  }

  const sheetOrders = await getSheetOrders();
  sheetOrders
    .filter((o) => normalizePhone(o.phone) === normalizedPhone)
    .forEach((order) => ordersById.set(order.orderId, order));

  return [...ordersById.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
}

async function updateOrderStatus(orderId, newStatus) {
  const id = orderId.toUpperCase();
  const now = new Date();
  const db = getDb();
  if (db) {
    const result = await db.collection("orders").updateOne(
      { orderId: id },
      {
        $set: { status: newStatus, updatedAt: now },
        $push: { history: { status: newStatus, at: now } },
      }
    );
    if (result.matchedCount > 0) {
      return db.collection("orders").findOne({ orderId: id });
    }
  } else {
    const order = memoryOrders.get(id);
    if (order) {
      order.status = newStatus;
      order.updatedAt = now;
      order.history.push({ status: newStatus, at: now });
      return order;
    }
  }

  try {
    const sheetOrder = await updateOrderStatusRow(id, newStatus);
    return sheetOrder ? sheetOrderToOrder(sheetOrder) : null;
  } catch (err) {
    console.warn("Sheet order status update failed:", err.message);
    throw err;
  }
}

async function getPendingOrders() {
  const active = ["pending", "confirmed", "processing"];
  const db = getDb();
  const ordersById = new Map();

  if (db) {
    const dbOrders = await db
      .collection("orders")
      .find({ status: { $in: active } })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();
    dbOrders.forEach((order) => ordersById.set(order.orderId, order));
  } else {
    [...memoryOrders.values()]
      .filter((o) => active.includes(normalizeStatus(o.status)))
      .forEach((order) => ordersById.set(order.orderId, order));
  }

  const sheetOrders = await getSheetOrders();
  sheetOrders
    .filter((o) => active.includes(normalizeStatus(o.status)))
    .forEach((order) => ordersById.set(order.orderId, order));

  return [...ordersById.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10);
}

module.exports = {
  ORDER_TRIGGERS,
  isOrderRequest,
  isConfirmation,
  isCancellation,
  hasPendingOrder,
  setPendingOrder,
  getPendingOrder,
  clearPendingOrder,
  logOrderToSheet,
  buildConfirmationMessage,
  buildSuccessMessage,
  createOrder,
  getOrdersByPhone,
  updateOrderStatus,
  getPendingOrders,
};
