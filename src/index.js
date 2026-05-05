require("dotenv").config();
const express = require("express");
const { sendMessage, markAsRead, extractMessage, sendTyping, typingDelay } = require("./whatsapp");
const { generateReply } = require("./claude");
const { connectMongo, connectRedis, getSession, updateSession, setHandoff, getHandoffSessions } = require("./sessions");
const { getInventory, getOrdersFromSheet, updateOrderStatusRow } = require("./sheets");
const { isHandoffRequest, activateHandoff } = require("./handoff");
const {
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
  getOrdersByPhone,
} = require("./orders");
const { detectLanguage } = require("./language");

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

function chunkMessage(text, limit = 3800) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + line + "\n").length > limit) {
      if (current) chunks.push(current.trim());
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function isTrackingRequest(text) {
  return /track.{0,10}order|order.{0,10}status|check.{0,10}order|my orders?|ambia.{0,5}order|order yangu/i.test(text);
}

function buildStatusMessage(order, status) {
  const id = order.orderId;
  const item = order.product || order.items || "";
  const msgs = {
    confirmed:  `Your order ${id} is confirmed! ✅\n${item}\nWe're getting it ready 🙌`,
    processing: `Your order ${id} is being prepared! 🔧\n${item}\nAlmost ready!`,
    shipped:    `Your order ${id} is on its way! 🚚\n${item}\nExpect it soon!`,
    delivered:  `Your order ${id} has been delivered! 📦\nThank you for shopping with us 🙏`,
    cancelled:  `Your order ${id} has been cancelled.\nSorry about that! Feel free to reach out if you have questions 🙏`,
  };
  return msgs[status] || `Your order ${id} has been updated. Status: ${status}`;
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

    // ── Owner: query orders from sheet (#orders [today|<status>]) ────────────────
    if (isOwner && /^#orders?\b/i.test(text.trim())) {
      const arg = text.trim().split(/\s+/)[1]?.toLowerCase();
      try {
        const filter = {};
        if (arg === "today") filter.dateFilter = "today";
        else if (arg) filter.status = arg;

        const orders = await getOrdersFromSheet(filter);
        if (orders.length === 0) {
          await sendMessage(from, arg ? `No orders found for "${arg}".` : "No orders in the sheet yet.");
          return;
        }

        const header = arg === "today" ? `Today's Orders` : arg ? `Orders — ${arg}` : `All Orders`;
        const list = orders.slice(-15).reverse()
          .map((o) =>
            `${o.orderId}\n👤 ${o.name} (${o.phone})\n🛒 ${o.product} x${o.quantity}\n💰 KSh ${o.total}\n📋 ${o.status}\n🕐 ${o.timestamp}`
          )
          .join("\n─────────────\n");

        for (const chunk of chunkMessage(`📋 ${header} (${orders.length}):\n\n${list}`)) {
          await sendMessage(from, chunk);
        }
      } catch (err) {
        console.error("Orders sheet query failed:", err.message);
        await sendMessage(from, "Failed to read orders from sheet. Check Google Sheets config.");
      }
      return;
    }

    // ── Owner: update order status in sheet (#order <id> <status>) ───────────────
    if (isOwner && /^#order\s+\S+\s+\S+/i.test(text.trim())) {
      const parts = text.trim().split(/\s+/);
      const orderId = parts[1].toUpperCase();
      const newStatus = parts[2].toLowerCase();

      if (!VALID_STATUSES.includes(newStatus)) {
        await sendMessage(from, `Invalid status. Use one of:\n${VALID_STATUSES.join(", ")}`);
        return;
      }

      try {
        const order = await updateOrderStatusRow(orderId, newStatus);
        if (!order) {
          await sendMessage(from, `Order ${orderId} not found in sheet.`);
          return;
        }

        await sendMessage(from, `✅ ${orderId} → ${newStatus}`);

        if (process.env.ORDER_NOTIFY !== "false" && order.phone) {
          await sendMessage(order.phone, buildStatusMessage(order, newStatus));
          console.log(`📬 [Status notification → ${order.phone}]: ${newStatus}`);
        }
      } catch (err) {
        console.error("Order status update failed:", err.message);
        await sendMessage(from, "Failed to update order status.");
      }
      return;
    }

    // ── Owner: full inventory catalogue (#stock [category]) ───────────────────────
    if (isOwner && /^#(stock|inventory)\b/i.test(text.trim())) {
      const category = text.trim().split(/\s+/).slice(1).join(" ").toLowerCase();
      try {
        let inventory = await getInventory();
        if (category) {
          inventory = inventory.filter((p) => p.category.toLowerCase().includes(category));
        }
        if (inventory.length === 0) {
          await sendMessage(from, category ? `No products found in "${category}".` : "Inventory is empty.");
          return;
        }

        const grouped = {};
        inventory.forEach((p) => {
          if (!grouped[p.category]) grouped[p.category] = [];
          grouped[p.category].push(p);
        });

        let msg = `📦 *Inventory* (${inventory.length} items):\n\n`;
        for (const [cat, items] of Object.entries(grouped)) {
          msg += `*${cat}*\n`;
          items.forEach((p) => {
            const stock = p.quantity > 0 ? `${p.quantity} units` : "OUT OF STOCK";
            msg += `• ${p.brand} ${p.name} ${p.model} — KSh ${p.price} (${stock})\n`;
          });
          msg += "\n";
        }

        for (const chunk of chunkMessage(msg)) {
          await sendMessage(from, chunk);
        }
        console.log(`📦 [Inventory sent to owner — ${inventory.length} items]`);
      } catch (err) {
        console.error("Inventory query failed:", err.message);
        await sendMessage(from, "Failed to read inventory from sheet.");
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
    // Customer has a pending order awaiting confirmation
    if (hasPendingOrder(from)) {
      const pending = getPendingOrder(from);

      if (isConfirmation(text)) {
        try {
          const orderId = await logOrderToSheet(from, contact, pending);
          clearPendingOrder(from);

          const successMsg = buildSuccessMessage(orderId, pending);
          await typingDelay(successMsg);
          await sendMessage(from, successMsg);
          await updateSession(from, text, successMsg);

          const ownerPhone = (process.env.OWNER_PHONE || "").replace(/\D/g, "");
          if (ownerPhone) {
            await sendMessage(
              ownerPhone,
              `New Order!\n\nOrder: ${orderId}\nCustomer: ${contact} (+${from})\nProduct: ${pending.product}\nTotal: KSh ${pending.total}\n\nCheck your Google Sheet.`
            );
          }
        } catch (err) {
          console.error("Order logging failed:", err.message);
          await sendMessage(from, "Sorry, there was an issue placing your order. Please try again or call us directly.");
        }
        return;
      }

      if (isCancellation(text)) {
        clearPendingOrder(from);
        const cancelMsg = pending.language === "sw"
          ? "Sawa, order yako imefutwa.\nUnaweza kurudi ukiwa tayari.\nKuna kitu kingine nikusaidie?"
          : "No problem! Your order has been cancelled.\nFeel free to come back when you're ready.\nIs there anything else I can help you with?";
        await sendMessage(from, cancelMsg);
        await updateSession(from, text, cancelMsg);
        return;
      }

      const reminder = pending.language === "sw"
        ? "Jibu NDIYO kuthibitisha au HAPANA kufuta order yako."
        : "Please reply YES to confirm or NO to cancel your order.";
      await sendMessage(from, reminder);
      return;
    }

    // Customer is requesting to place an order
    if (isOrderRequest(text)) {
      await sendTyping(from);

      const language = detectLanguage(text);
      const orderPrompt = `${text}\n\n[SYSTEM: The customer wants to place an order. Check inventory for the product they mentioned. If found, respond ONLY with this exact format so the system can parse it:\nORDER_PRODUCT: {full product name}\nORDER_PRICE: {price as number only}\nORDER_QTY: 1\nThen on a new line write the confirmation message to the customer.]`;

      const reply = await generateReply(orderPrompt, session.history);
      const productMatch = reply.match(/ORDER_PRODUCT:\s*(.+)/i);
      const priceMatch = reply.match(/ORDER_PRICE:\s*([\d,]+)/i);
      const qtyMatch = reply.match(/ORDER_QTY:\s*(\d+)/i);

      if (productMatch && priceMatch) {
        const product = productMatch[1].trim();
        const price = parseInt(priceMatch[1].replace(/\D/g, ""), 10);
        const quantity = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
        const total = price * quantity;
        const pendingOrder = { product, price, quantity, total, language };

        setPendingOrder(from, pendingOrder);

        const confirmMsg = buildConfirmationMessage(pendingOrder);
        await typingDelay(confirmMsg);
        await sendMessage(from, confirmMsg);
        await updateSession(from, text, confirmMsg);
      } else {
        const cleanReply = reply
          .replace(/ORDER_PRODUCT:.*/gi, "")
          .replace(/ORDER_PRICE:.*/gi, "")
          .replace(/ORDER_QTY:.*/gi, "")
          .trim();
        await updateSession(from, text, cleanReply);
        await sendMessage(from, cleanReply);
      }
      return;
    }

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
    // ── Order intent — start order flow ──────────────────────────────────────
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
