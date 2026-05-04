require("dotenv").config();
const express = require("express");
const { sendMessage, markAsRead, extractMessage, sendTyping, typingDelay } = require("./whatsapp");
const { generateReply } = require("./claude");
const { connectMongo, connectRedis, getSession, updateSession, setHandoff, getHandoffSessions, setPendingOrder } = require("./sessions");
const { getInventory } = require("./sheets");
const { isHandoffRequest, activateHandoff } = require("./handoff");
const { createOrder, getOrdersByPhone, updateOrderStatus, getPendingOrders } = require("./orders");

// ── Order tracking constants ──────────────────────────────────────────────────
const STATUS_LABELS = {
  pending:    "Pending confirmation ⏳",
  confirmed:  "Confirmed ✅",
  processing: "Being prepared 🔧",
  shipped:    "Shipped 🚚",
  delivered:  "Delivered 📦",
  cancelled:  "Cancelled ❌",
};

const VALID_STATUSES = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];

function isTrackingRequest(text) {
  return /track.{0,10}order|order.{0,10}status|check.{0,10}order|my orders?|ambia.{0,5}order|order yangu/i.test(text);
}

function isOrderIntent(text) {
  return /place.{0,5}order|place an order|nataka order|niagize|nataka kuagiza|order now|i want to order/i.test(text);
}

function buildStatusMessage(order, status) {
  const msgs = {
    confirmed:  `Your order ${order.orderId} has been confirmed! ✅\n${order.items}\nWe're getting it ready for delivery to ${order.location} 🙌`,
    processing: `Your order ${order.orderId} is being prepared! 🔧\n${order.items}\nAlmost ready for delivery to ${order.location}`,
    shipped:    `Your order ${order.orderId} is on its way! 🚚\n${order.items}\nHeading to ${order.location} — expect it soon!`,
    delivered:  `Your order ${order.orderId} has been delivered! 📦\nThank you for shopping with us 🙏\nEnjoy your purchase!`,
    cancelled:  `Your order ${order.orderId} has been cancelled.\nSorry about that! Feel free to reach out if you have any questions 🙏`,
  };
  return msgs[status] || `Your order ${order.orderId} has been updated. Status: ${status}`;
}

async function handleOrderStep(from, contact, text, session) {
  const { step, items, location } = session.pendingOrder;
  const lower = text.trim().toLowerCase();

  if (step === "product") {
    await setPendingOrder(from, { step: "location", items: text.trim(), location: "" });
    await sendMessage(from, `Got it! 📝\n\nWhat's your delivery location?\n(e.g. Westlands, Nairobi)`);
    return;
  }

  if (step === "location") {
    await setPendingOrder(from, { step: "confirm", items, location: text.trim() });
    await sendMessage(
      from,
      `Here's your order summary:\n\n` +
      `🛒 Item: ${items}\n` +
      `📍 Delivery: ${text.trim()}\n\n` +
      `Our team will confirm the total and send payment details.\n\n` +
      `Confirm this order? (Yes / No)`
    );
    return;
  }

  if (step === "confirm") {
    if (/^(yes|ndio|confirm|sawa|ok|yep|yeah|sure)\b/i.test(lower)) {
      const order = await createOrder({ phone: from, name: contact, items, location });
      await setPendingOrder(from, null);

      const ownerPhone = process.env.OWNER_PHONE;
      if (ownerPhone) {
        await sendMessage(
          ownerPhone,
          `🛒 *New Order*\n\n` +
          `ID: ${order.orderId}\n` +
          `Customer: ${contact} (+${from})\n` +
          `Items: ${order.items}\n` +
          `Location: ${order.location}\n\n` +
          `Reply: #order ${order.orderId} confirmed`
        );
      }

      await sendMessage(
        from,
        `Order placed! 🎉\n\n` +
        `Order ID: ${order.orderId}\n\n` +
        `Our team will contact you shortly with payment details and delivery timeline.\n\n` +
        `To check your order anytime, just say "track my order" 📦`
      );
      console.log(`🛒 [New order ${order.orderId} — ${contact} | ${from}]`);

    } else if (/^(no|hapana|cancel|nope|nah)\b/i.test(lower)) {
      await setPendingOrder(from, null);
      await sendMessage(from, "No worries, order cancelled!\nLet me know if you'd like to start over or need anything else 😊");

    } else {
      await sendMessage(from, "Just reply Yes to confirm or No to cancel your order 😊");
    }
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} — ${Date.now() - start}ms`);
  });
  next();
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  let sheetsStatus = "ok";
  let productCount = null;

  try {
    const inventory = await getInventory();
    productCount = inventory.length;
  } catch (err) {
    sheetsStatus = `error: ${err.message}`;
  }

  const healthy = sheetsStatus === "ok";

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: `${process.env.SHOP_NAME || "Electronics Shop"} WhatsApp Bot`,
    timestamp: new Date().toISOString(),
    checks: {
      server: "ok",
      googleSheets: sheetsStatus,
      ...(productCount !== null && { productCount }),
    },
  });
});

// ── Privacy policy ───────────────────────────────────────────────────────────
app.get("/privacy", (req, res) => {
  res.send(`
    <h1>TechHub Electronics — Privacy Policy</h1>
    <p>We collect your WhatsApp name and phone number solely to respond
    to your enquiries. We do not share your data with third parties.
    Conversations are stored for service continuity only.</p>
    <p>Contact: ${process.env.SHOP_EMAIL || "info@techhub.co.ke"}</p>
  `);
});

// ── Webhook verification (Meta one-time handshake) ───────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    res.status(200).send(challenge);
  } else {
    console.warn("❌ Webhook verification failed — token mismatch");
    res.sendStatus(403);
  }
});

// ── Incoming message handler ─────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  const message = extractMessage(req.body);
  if (!message) return;

  const { from, messageId, text, contact } = message;
  console.log(`📩 [${contact} | ${from}]: ${text}`);

  await markAsRead(messageId);

  // Prevent duplicate processing (Meta sometimes sends twice)
  const dedupKey = `${from}:${messageId}`;
  if (app.locals.processedMessages?.has(dedupKey)) return;
  if (!app.locals.processedMessages) app.locals.processedMessages = new Set();
  app.locals.processedMessages.add(dedupKey);
  setTimeout(() => app.locals.processedMessages.delete(dedupKey), 5 * 60 * 1000);

  try {
    const ownerPhone = process.env.OWNER_PHONE;
    const isOwner = ownerPhone && from === ownerPhone;

    // ── Owner: resume bot (#bot) ──────────────────────────────────────────────
    if (isOwner && text.trim().toLowerCase().startsWith("#bot")) {
      const parts = text.trim().split(/\s+/);
      let customerPhones;
      if (parts[1]) {
        customerPhones = [parts[1].replace(/^\+/, "")];
      } else {
        customerPhones = await getHandoffSessions();
      }

      if (customerPhones.length === 0) {
        await sendMessage(from, "No customers currently in handoff mode.");
        return;
      }

      for (const customerPhone of customerPhones) {
        await setHandoff(customerPhone, false);
        await sendMessage(customerPhone, "You're back with our assistant! How can I help you? 😊");
        console.log(`🤖 [Bot resumed for ${customerPhone}]`);
      }
      await sendMessage(from, `✅ Bot resumed for ${customerPhones.length} customer(s).`);
      return;
    }

    // ── Owner: list active orders (#orders) ───────────────────────────────────
    if (isOwner && text.trim().toLowerCase() === "#orders") {
      const orders = await getPendingOrders();
      if (orders.length === 0) {
        await sendMessage(from, "No active orders at the moment.");
        return;
      }
      const list = orders
        .map((o) =>
          `${o.orderId}\n👤 ${o.name} (+${o.phone})\n🛒 ${o.items}\n📍 ${o.location}\nStatus: ${STATUS_LABELS[o.status] || o.status}`
        )
        .join("\n─────────────\n");
      await sendMessage(from, `📋 Active Orders (${orders.length}):\n\n${list}`);
      return;
    }

    // ── Owner: update order status (#order <id> <status>) ─────────────────────
    if (isOwner && /^#order\s+\S+\s+\S+/i.test(text.trim())) {
      const parts = text.trim().split(/\s+/);
      const orderId = parts[1].toUpperCase();
      const newStatus = parts[2].toLowerCase();

      if (!VALID_STATUSES.includes(newStatus)) {
        await sendMessage(from, `Invalid status. Use one of:\n${VALID_STATUSES.join(", ")}`);
        return;
      }

      const order = await updateOrderStatus(orderId, newStatus);
      if (!order) {
        await sendMessage(from, `Order ${orderId} not found.`);
        return;
      }

      await sendMessage(from, `✅ ${orderId} → ${newStatus}`);

      if (process.env.ORDER_NOTIFY !== "false") {
        await sendMessage(order.phone, buildStatusMessage(order, newStatus));
        console.log(`📬 [Status notification → ${order.phone}]: ${newStatus}`);
      }
      return;
    }

    // ── Load session ──────────────────────────────────────────────────────────
    const session = await getSession(from);

    // ── Handoff mode active — bot stays silent ────────────────────────────────
    if (session.handoff) {
      console.log(`⏸️  [Handoff active — ignoring message from ${from}]`);
      return;
    }

    // ── Order tracking request ────────────────────────────────────────────────
    if (isTrackingRequest(text)) {
      const orders = await getOrdersByPhone(from);
      if (orders.length === 0) {
        await sendMessage(from, "I don't see any orders linked to your number yet.\nReady to place one? Just let me know what you'd like! 😊");
        return;
      }
      const lines = orders
        .map((o) => `${o.orderId} — ${o.items}\nStatus: ${STATUS_LABELS[o.status] || o.status}`)
        .join("\n\n");
      await sendMessage(from, `Here are your recent orders:\n\n${lines}\n\nQuestions about your order? Just ask 😊`);
      return;
    }

    // ── Pending order step in progress ────────────────────────────────────────
    if (session.pendingOrder) {
      await handleOrderStep(from, contact, text, session);
      return;
    }

    // ── Order intent — start order flow ──────────────────────────────────────
    if (isOrderIntent(text)) {
      await setPendingOrder(from, { step: "product", items: "", location: "" });
      await sendMessage(from, "Sure, let's get your order sorted! 🛒\n\nWhat would you like to order?\n(e.g. Samsung Galaxy A55, 1 unit)");
      return;
    }

    // ── Human handoff request ─────────────────────────────────────────────────
    if (isHandoffRequest(text)) {
      await setHandoff(from, true);
      await activateHandoff(from, contact, text);
      console.log(`🔔 [Handoff activated for ${contact} | ${from}]`);
      return;
    }

    // ── Normal AI flow ────────────────────────────────────────────────────────
    await sendTyping(from);

    const reply = await generateReply(text, session.history);

    await typingDelay(reply);

    await updateSession(from, text, reply);

    await sendMessage(from, reply);

    console.log(`📤 [Bot → ${from}]: ${reply.substring(0, 80)}...`);

  } catch (err) {
    console.error("❌ Error processing message:", err.message);

    try {
      await sendMessage(
        from,
        "Sorry, I ran into a small issue on my end. Please try again in a moment, or call us directly on " +
          (process.env.SHOP_PHONE || "+254 700 000000") +
          " 🙏"
      );
    } catch {
      console.error("Failed to send fallback message");
    }
  }
});

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

Promise.all([connectRedis(), connectMongo()]).then(([redisClient, mongoDb]) => {
  const sessionStore = redisClient ? "Redis" : "In-memory";
  const orderStore   = mongoDb    ? "MongoDB" : "In-memory";
  app.listen(PORT, () => {
    console.log(`\n🚀 ${process.env.SHOP_NAME || "Electronics Shop"} WhatsApp Bot`);
    console.log(`   Port     : ${PORT}`);
    console.log(`   Sessions : ${sessionStore}`);
    console.log(`   Orders   : ${orderStore}`);
    console.log(`   Typing   : ✅ enabled`);
    console.log(`   Handoff  : ✅ enabled`);
    console.log(`   Orders   : ✅ enabled\n`);
  });
});
