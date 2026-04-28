require("dotenv").config();
const express = require("express");
const { sendMessage, markAsRead, extractMessage } = require("./whatsapp");
const { generateReply } = require("./claude");
const { getSession, updateSession } = require("./sessions");

const app = express();
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: `${process.env.SHOP_NAME || "Electronics Shop"} WhatsApp Bot`,
    timestamp: new Date().toISOString(),
  });
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
    // Load conversation history for this number
    const session = getSession(from);

    // Generate reply using Claude + live inventory
    const reply = await generateReply(text, session.history);

    // Save to session memory
    updateSession(from, text, reply);

    // Send reply back via WhatsApp
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
app.listen(PORT, () => {
  console.log(`\n🚀 ${process.env.SHOP_NAME || "Electronics Shop"} WhatsApp Bot running`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Webhook URL: https://YOUR_RAILWAY_URL/webhook`);
  console.log(`   Verify token: ${process.env.WEBHOOK_VERIFY_TOKEN || "(not set)"}\n`);
});
