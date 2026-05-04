const { sendMessage } = require("./whatsapp");

const TRIGGER_PHRASES = [
  "speak to a person",
  "human agent",
  "live agent",
  "talk to someone",
  "real person",
  "human support",
  "need a human",
  "want a human",
  "nataka mtu",
  "niongee na mtu",
];

function isHandoffRequest(text) {
  const lower = text.toLowerCase();
  return TRIGGER_PHRASES.some((phrase) => lower.includes(phrase));
}

async function activateHandoff(from, contact, text) {
  await sendMessage(
    from,
    "Got it! Connecting you with our team... 🙏\nA team member will be with you shortly. Please hold on."
  );

  const ownerPhone = process.env.OWNER_PHONE;
  if (!ownerPhone) return;

  const alert =
    `🔔 *Human Support Requested*\n\n` +
    `Customer: ${contact}\n` +
    `Phone: +${from}\n` +
    `Message: "${text}"\n\n` +
    `The bot has paused. Reply to them directly,\n` +
    `then send *#bot* (or *#bot ${from}*) to resume the bot.`;

  await sendMessage(ownerPhone, alert);
}

module.exports = { isHandoffRequest, activateHandoff };
