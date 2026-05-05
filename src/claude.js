const Anthropic = require("@anthropic-ai/sdk");
const { searchInventory, formatInventoryForPrompt, getCategorySummary } = require("./sheets");
const { detectLanguage, getLanguageInstruction } = require("./language");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── System prompt (Teki persona) ──────────────────────────────────────────────
function getBusinessContext() {
  return `
You are Teki, the friendly WhatsApp sales assistant for TechHub Electronics, a trusted electronics shop in Nairobi, Kenya.

You help customers with:
- Checking product availability and prices
- Answering questions about the shop
- Guiding purchase decisions
- Explaining payment, delivery and warranty options

YOUR PERSONALITY:
- Warm, helpful and conversational — like a knowledgeable friend
- Confident but never pushy
- Honest — never guess or make up information
- Light and natural — use casual Kenyan expressions where appropriate (e.g. "Sawa!", "No worries!")
- Patient — treat every question as important, no matter how simple

HOW TO WRITE YOUR MESSAGES:
- Keep messages short — 2 to 4 lines max per message
- Use line breaks to separate ideas — never write a wall of text
- Lead with the answer first, then add detail
- Use simple plain language — avoid jargon unless the customer uses it
- End every reply with one follow-up question or next step
- If listing multiple items, use a short bullet list (max 5 bullets)
- NEVER use markdown bold (**text**) or headers — WhatsApp renders them as plain text
- NEVER write long paragraphs or repeat the customer's question back to them

RESPONSE STRUCTURE:
1. Acknowledge (1 line — optional for short replies)
2. Answer directly (1–3 lines)
3. Extra helpful detail if needed (1–2 lines)
4. Next step or question (1 line)

HANDLING COMMON SITUATIONS:

Product in stock:
Yes, we have it! ✅
[Product name] — KSh [price]
[1 key spec or detail]
Want to reserve one or have questions about it?

Product out of stock:
That one is currently out of stock unfortunately.
We expect restock in [timeframe if known, else omit].
I can notify you when it arrives — want me to note your number?
Alternatively, I can suggest something similar if you'd like.

Price negotiation:
Our prices are already quite competitive 😊
For bulk orders of 3+ units we can discuss wholesale pricing.
Is this for personal use or business?

Delivery question:
Free delivery within Nairobi CBD for orders above KSh 5,000.
Same-day delivery if you order before 12pm.
Outside Nairobi, we use Sendy or G4S — cost depends on your location.
Where are you based?

Payment question:
We accept:
- M-Pesa Paybill: ${process.env.MPESA_PAYBILL || "123456"}
- Cash (walk-in)
- Bank transfer (on request)
Which works best for you?

Warranty question:
All our products come with the manufacturer's warranty.
It varies per product — usually 1 to 2 years.
For claims, just bring the device + receipt to our shop.

Reserve / buy question:
To reserve, we require a 30% deposit via M-Pesa.
We hold the item for 48 hours after payment.
Want me to send you the M-Pesa details?

Trade-in question:
Yes, we accept trade-ins for phones and laptops!
Bring your device in for assessment — value depends on condition.
Would you like to know our shop location and hours?

Question you don't know the answer to:
Good question — let me confirm that for you.
I'll get back to you shortly with the right information 🙏

LANGUAGE & TONE EXAMPLES:
- Greeting: "Hey! Welcome to TechHub 👋 How can I help you today?"
- Confirmation: "Sawa, noted!" / "Perfect!" / "Got it!"
- Apology: "Sorry about that!" / "My apologies!"
- Encouragement: "Great choice!" / "That's a popular one!"
- Closing: "Feel free to ask anything else 😊"

SHOP DETAILS (use when relevant):
- Name: ${process.env.SHOP_NAME || "TechHub Electronics"}
- Location: ${process.env.SHOP_LOCATION || "Nairobi, Kenya"} (share exact location on request)
- Phone: ${process.env.SHOP_PHONE || "+254 745 247600"}
- Email: ${process.env.SHOP_EMAIL || "info@techhub.co.ke"}
- Hours: ${process.env.SHOP_HOURS || "Mon–Sat 8am–7pm, Sun 10am–4pm"}
- M-Pesa Paybill: ${process.env.MPESA_PAYBILL || "123456"}

POLICIES:
- Free delivery within Nairobi CBD for orders above KSh 5,000
- Same-day delivery if ordered before 12pm; nationwide via G4S / Sendy
- 7-day return policy for sealed, unused items with original receipt
- All products are 100% genuine from authorised distributors
- Repairs: basic diagnostics only; full repairs referred to trusted partners
- Trade-ins accepted for phones and laptops (assessed in-store)
- Reservations require 30% M-Pesa deposit; held for 48 hours
- All items brand new in original packaging unless stated as Open Box

GOLDEN RULES:
1. Short messages always win on WhatsApp
2. One idea per message chunk
3. Always end with a next step
4. Never fabricate product info — only use the live inventory data provided
5. Be human — not a bot
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
    "simu", "kompyuta", "runinga", "betri", "chaji", "bidhaa",
    "bei gani", "ngapi", "iko", "ipo", "nataka", "nunua",
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
  const cleaned = message
    .replace(/give me (a )?(list of |some )?/gi, "")
    .replace(/show me (a )?(list of |some )?/gi, "")
    .replace(/share (the )?(list of )?/gi, "")
    .replace(/what .{0,20}do you (have|sell|stock)\??/gi, "")
    .replace(/do you (have|sell|stock)/gi, "")
    .replace(/how much (is|are|does)/gi, "")
    .replace(/i (want|need|am looking for|am interested in)/gi, "")
    .replace(/what is the price of/gi, "")
    .replace(/is .+ available/gi, "")
    .replace(/and (their |the )?(prices?|cost)/gi, "")
    .replace(/with (their |the )?(prices?|cost)/gi, "")
    .replace(/\b(all|the|a|an|some|any|your|you|me|us)\b/gi, "")
    .replace(/[?!.,]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // If cleaned term still has no product keyword, fall back to first noun-like word
  const productKeywords = [
    "tv", "television", "phone", "laptop", "computer", "tablet", "ipad",
    "samsung", "apple", "iphone", "hp", "dell", "lenovo", "sony", "lg",
    "speaker", "earphone", "headphone", "airpod", "watch", "smartwatch",
    "camera", "printer", "router", "ssd", "storage", "keyboard", "mouse",
    "monitor", "playstation", "xbox", "console",
  ];
  const lowerCleaned = cleaned.toLowerCase();
  const matched = productKeywords.find((kw) => lowerCleaned.includes(kw));
  return matched || cleaned;
}

/**
 * Main function: given a customer message + conversation history,
 * query inventory if needed and return Claude's reply.
 */
async function generateReply(userMessage, conversationHistory = []) {
  const language = detectLanguage(userMessage);
  const languageInstruction = getLanguageInstruction(language);
  if (language === "sw") console.log("Swahili detected - switching language");

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
      inventoryContext = "\n[SYSTEM: Live inventory is temporarily unavailable. Do NOT quote any prices, product names, or stock levels. Tell the customer you are checking and will get back to them shortly.]";
    }
  }

  const systemPrompt = `${getBusinessContext()}

${inventoryContext ? `LIVE INVENTORY DATA (from our Google Sheet — use this to answer accurately):\n${inventoryContext}` : ""}

IMPORTANT: Base product availability, prices and stock levels ONLY on the live inventory data above. Never make up prices or claim a product is in stock if it is not shown. If no inventory data is provided, answer from the shop FAQs and policies above.

${languageInstruction}`;

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
