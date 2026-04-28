const Anthropic = require("@anthropic-ai/sdk");
const { searchInventory, formatInventoryForPrompt, getCategorySummary } = require("./sheets");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Business FAQ / context injected into every prompt ─────────────────────────
function getBusinessContext() {
  return `
SHOP PROFILE:
- Name: ${process.env.SHOP_NAME || "TechHub Electronics"}
- Location: ${process.env.SHOP_LOCATION || "Nairobi, Kenya"}
- Phone / WhatsApp: ${process.env.SHOP_PHONE || "+254 700 000000"}
- Email: ${process.env.SHOP_EMAIL || "info@shop.co.ke"}
- Hours: ${process.env.SHOP_HOURS || "Mon–Sat 8am–7pm, Sun 10am–4pm"}

PAYMENT OPTIONS:
- M-Pesa Paybill: ${process.env.MPESA_PAYBILL || "123456"}
- Cash on delivery (within Nairobi CBD)
- Bank transfer (on request)
- We do NOT accept cheques

DELIVERY & PICKUP:
- Free delivery within Nairobi CBD for orders above KSh 5,000
- Same-day delivery available if ordered before 12pm
- Nationwide delivery via G4S / Sendy (cost calculated per location)
- Walk-in pickup available during shop hours

WARRANTY & RETURNS:
- All products come with manufacturer warranty (varies per product, shown in listing)
- 7-day return policy for sealed, unused items with original receipt
- No returns on opened software or accessories
- Warranty claims handled in-store — bring device + receipt

FREQUENTLY ASKED QUESTIONS:
Q: Do you sell genuine/original products?
A: Yes, all products are 100% genuine sourced from authorised distributors. We provide official receipts.

Q: Can I negotiate the price?
A: Prices shown are already competitive. For bulk orders (3+ units), ask about wholesale pricing.

Q: Do you do repairs?
A: We offer basic diagnostics. For full repairs we refer to trusted partners.

Q: Do you have a physical shop?
A: Yes! Walk-in welcome during business hours. Location shared on request.

Q: Do you take trade-ins?
A: Yes, for phones and laptops. Bring your device for assessment — value depends on condition.

Q: Can I reserve a product?
A: Yes, with a 30% deposit via M-Pesa. We hold for 48 hours.

Q: Do products come with a box and accessories?
A: Yes, all items are brand new in original packaging unless stated as "Open Box".

TONE GUIDELINES (follow strictly):
- Be warm, friendly, and professional — like a knowledgeable shop assistant
- Use natural conversational Kenyan English (you may use light local phrases where appropriate)
- Never be robotic or list-heavy — weave information into natural sentences
- If a product is out of stock, suggest alternatives or offer to notify when back
- If you don't know something, say so honestly and offer to find out
- Keep responses concise — WhatsApp is a messaging app, not an email
- Use line breaks to make messages readable on mobile
- Do not use markdown bold (**) or headers — plain text only
- Always end with a helpful next step or question to keep the conversation going
`.trim();
}

/**
 * Detect what kind of query the customer is asking so we can
 * decide whether to query the inventory sheet or not.
 */
function detectIntent(message) {
  const m = message.toLowerCase();

  const productKeywords = [
    "tv", "television", "phone", "laptop", "computer", "tablet", "ipad",
    "samsung", "apple", "iphone", "hp", "dell", "lenovo", "sony", "lg",
    "speaker", "earphone", "headphone", "airpod", "watch", "smartwatch",
    "fridge", "washing machine", "microwave", "blender", "iron", "fan",
    "camera", "printer", "router", "modem", "hard drive", "ssd", "ram",
    "charger", "cable", "power bank", "keyboard", "mouse", "monitor",
    "playstation", "xbox", "nintendo", "console", "game",
    "price", "cost", "how much", "bei", "stock", "available", "in stock",
    "do you have", "mnauza", "una", "sell", "selling", "buy", "purchase",
    "what do you sell", "products", "items", "brands",
  ];

  const hasProductIntent = productKeywords.some((kw) => m.includes(kw));

  return {
    needsInventory: hasProductIntent,
    isGreeting: /^(hi|hello|hey|habari|sasa|niaje|mambo|good morning|good afternoon|good evening|hujambo)\b/i.test(m.trim()),
    isThankYou: /\b(thank|asante|thanks|sawa|ok cool|perfect|great)\b/i.test(m),
  };
}

/**
 * Extract a search term from the customer message for inventory lookup.
 */
function extractSearchTerm(message) {
  // Strip common filler words to get the core product term
  return message
    .replace(/do you (have|sell|stock)/gi, "")
    .replace(/how much (is|are|does)/gi, "")
    .replace(/i (want|need|am looking for|am interested in)/gi, "")
    .replace(/what is the price of/gi, "")
    .replace(/is .+ available/gi, "")
    .replace(/[?!.,]/g, "")
    .trim();
}

/**
 * Main function: given a customer message + conversation history,
 * query inventory if needed and return Claude's reply.
 */
async function generateReply(userMessage, conversationHistory = []) {
  const intent = detectIntent(userMessage);
  let inventoryContext = "";

  // Query Google Sheets only when relevant
  if (intent.needsInventory) {
    try {
      const searchTerm = extractSearchTerm(userMessage);
      const products = await searchInventory(searchTerm);

      if (products.length > 0) {
        inventoryContext = `\nCURRENT INVENTORY RESULTS for "${searchTerm}":\n${formatInventoryForPrompt(products)}`;
      } else {
        // Try broader category summary
        const summary = await getCategorySummary();
        inventoryContext = `\nNo exact match found for "${searchTerm}". Here is what we currently stock:\n${summary}`;
      }
    } catch (err) {
      console.error("Sheets query failed:", err.message);
      inventoryContext = "\n[Note: Could not fetch live inventory right now — answer based on general knowledge of the shop]";
    }
  }

  const systemPrompt = `You are a friendly, knowledgeable sales assistant for an electronics shop in Nairobi, Kenya, operating via WhatsApp. 

${getBusinessContext()}

${inventoryContext ? `LIVE INVENTORY DATA (from our Google Sheet — use this to answer accurately):\n${inventoryContext}` : ""}

IMPORTANT RULES:
- Base product availability, prices, and stock levels ONLY on the inventory data provided above
- Never make up prices or claim products are in stock if not shown in the inventory data
- If inventory data is not provided for this query, answer general FAQs from the business context
- Keep messages short enough for WhatsApp (aim for under 150 words unless detailed info is needed)`;

  // Build messages array with conversation history
  const messages = [
    ...conversationHistory.slice(-8), // Keep last 8 turns for context window efficiency
    { role: "user", content: userMessage },
  ];

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 500,
    system: systemPrompt,
    messages,
  });

  return response.content[0].text;
}

module.exports = { generateReply };
