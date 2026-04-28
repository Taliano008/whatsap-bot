const axios = require("axios");

const BASE_URL = "https://graph.facebook.com/v19.0";

/**
 * Send a plain text WhatsApp message to a recipient.
 */
async function sendMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  try {
    const response = await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error("WhatsApp send error:", JSON.stringify(errData, null, 2));
    throw err;
  }
}

/**
 * Mark a message as read (shows double blue ticks to customer).
 */
async function markAsRead(messageId) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  try {
    await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch {
    // Non-critical — don't crash on read receipt failure
  }
}

/**
 * Parse the incoming webhook payload and extract message data.
 * Returns null if this is not a text message (e.g. status update).
 */
function extractMessage(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Ignore delivery/read status updates
    if (!value?.messages?.length) return null;

    const message = value.messages[0];

    // Only handle text messages for now
    if (message.type !== "text") return null;

    return {
      from: message.from,           // e.g. "254745247600"
      messageId: message.id,
      text: message.text.body,
      timestamp: message.timestamp,
      contact: value.contacts?.[0]?.profile?.name || "Customer",
    };
  } catch {
    return null;
  }
}

module.exports = { sendMessage, markAsRead, extractMessage };
