require("dotenv").config();
const express = require("express");
const { sendMessage, markAsRead, extractMessage, sendTyping, typingDelay } = require("./whatsapp");
const { generateReply } = require("./claude");
const { connectMongo, getSession, updateSession, setHandoff, getHandoffSessions } = require("./sessions");
const { getInventory } = require("./sheets");
const { isHandoffRequest, activateHandoff } = require("./handoff");

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
  if (!message) return; // Status update or unsupported type — ignore

  const { from, messageId, text, contact } = message;
  console.log(`📩 [${contact} | ${from}]: ${text}`);

  // Mark as read (shows blue ticks)
  await markAsRead(messageId);

  // Prevent duplicate processing (Meta sometimes sends twice)
  const dedupKey = `${from}:${messageId}`;
  if (app.locals.processedMessages?.has(dedupKey)) return;
  if (!app.locals.processedMessages) app.locals.processedMessages = new Set();
  app.locals.processedMessages.add(dedupKey);
  // Clean up dedup set after 5 minutes
  setTimeout(() => app.locals.processedMessages.delete(dedupKey), 5 * 60 * 1000);

  try {
    const ownerPhone = process.env.OWNER_PHONE;
    const isOwner = ownerPhone && from === ownerPhone;

    // ── Owner #bot command — resume handoff sessions ──────────────────────────
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

    // ── Load session ──────────────────────────────────────────────────────────
    const session = await getSession(from);

    // ── Handoff mode active — bot stays silent for this customer ─────────────
    if (session.handoff) {
      console.log(`⏸️  [Handoff active — ignoring message from ${from}]`);
      return;
    }

    // ── Detect human handoff request ─────────────────────────────────────────
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

    // Send a graceful fallback message so customer isn't left hanging
    try {
      await sendMessage(
        from,
        "Sorry, I ran into a small issue on my end. Please try again in a moment, or call us directly on " +
          (process.env.SHOP_PHONE || "+254 700 000000") +
          " 🙏"
      );
    } catch {
      // If even fallback fails, log and move on
      console.error("Failed to send fallback message");
    }
  }
});

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

connectMongo().then((mongoDb) => {
  const memoryMode = mongoDb ? "MongoDB persistent (last 5 exchanges)" : "In-memory (no MONGODB_URI set)";
  app.listen(PORT, () => {
    console.log(`\n🚀 ${process.env.SHOP_NAME || "Electronics Shop"} WhatsApp Bot`);
    console.log(`   Port    : ${PORT}`);
    console.log(`   Memory  : ${memoryMode}`);
    console.log(`   Typing  : ✅ enabled\n`);
  });
});
