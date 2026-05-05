const SWAHILI_WORDS = [
  "nataka", "ninataka", "nipe", "niletee", "nitake", "naomba",
  "bei", "pesa", "kununua", "kuorder", "order ya", "niagize",
  "una", "mnauza", "habari", "sasa", "niaje", "mambo", "hujambo",
  "ndio", "ndiyo", "hapana", "sawa", "asante", "tafadhali",
  "karibu", "pole", "samahani", "bidhaa", "duka",
];

/**
 * Detect whether a message is Swahili ("sw") or English ("en").
 */
function detectLanguage(text) {
  const lower = String(text || "").toLowerCase();
  const hasSwahili = SWAHILI_WORDS.some((word) => lower.includes(word));
  return hasSwahili ? "sw" : "en";
}

/**
 * Return a language instruction string for the Claude system prompt.
 */
function getLanguageInstruction(language) {
  if (language === "sw") {
    return "LANGUAGE: The customer is writing in Swahili. Reply in Swahili. Keep it natural and conversational — avoid overly formal Swahili.";
  }
  return "LANGUAGE: Reply in English. Keep it natural and friendly.";
}

module.exports = { detectLanguage, getLanguageInstruction };
