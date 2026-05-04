const memoryOrders = new Map();

function getDb() {
  return require("./sessions").getDb();
}

function generateOrderId() {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `ORD-${date}-${rand}`;
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
  const db = getDb();
  if (db) {
    return db.collection("orders").find({ phone }).sort({ createdAt: -1 }).limit(5).toArray();
  }
  return [...memoryOrders.values()]
    .filter((o) => o.phone === phone)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
}

async function updateOrderStatus(orderId, newStatus) {
  const id = orderId.toUpperCase();
  const now = new Date();
  const db = getDb();
  if (db) {
    await db.collection("orders").updateOne(
      { orderId: id },
      {
        $set: { status: newStatus, updatedAt: now },
        $push: { history: { status: newStatus, at: now } },
      }
    );
    return db.collection("orders").findOne({ orderId: id });
  }
  const order = memoryOrders.get(id);
  if (!order) return null;
  order.status = newStatus;
  order.updatedAt = now;
  order.history.push({ status: newStatus, at: now });
  return order;
}

async function getPendingOrders() {
  const active = ["pending", "confirmed", "processing"];
  const db = getDb();
  if (db) {
    return db
      .collection("orders")
      .find({ status: { $in: active } })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();
  }
  return [...memoryOrders.values()]
    .filter((o) => active.includes(o.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10);
}

module.exports = { createOrder, getOrdersByPhone, updateOrderStatus, getPendingOrders };
