const SWAHILI_INDICATORS = [
  "habari",
  "mambo",
  "sasa",
  "niaje",
  "hujambo",
  "sijambo",
  "salama",
  "shikamoo",
  "marahaba",
  "karibu",
  "asante",
  "nakushukuru",
  "una",
  "mnauza",
  "mna",
  "bei gani",
  "ngapi",
  "iko",
  "ipo",
  "nataka",
  "niambie",
  "nisaidie",
  "naweza",
  "nunua",
  "uza",
  "tafadhali",
  "sawa",
  "ndiyo",
  "hapana",
  "bado",
  "haraka",
  "bei",
  "pesa",
  "lipa",
  "malipo",
  "huduma",
  "msaada",
  "bidhaa",
  "simu",
  "kompyuta",
  "runinga",
  "redio",
  "betri",
  "chaji",
  "peleka",
  "tuma",
  "pokea",
  "fikia",
  "fika",
  "mpesa",
];

const SWAHILI_THRESHOLD = 1;

function detectLanguage(message) {
  const normalized = ` ${String(message || "").toLowerCase()} `;
  const hits = SWAHILI_INDICATORS.filter((indicator) => {
    const escaped = indicator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\W)${escaped}(?=\\W|$)`, "i").test(normalized);
  });

  return hits.length >= SWAHILI_THRESHOLD ? "sw" : "en";
}

function getLanguageInstruction(language) {
  if (language === "sw") {
    return [
      "LANGUAGE INSTRUCTION:",
      "- Reply in natural Kiswahili.",
      "- Keep the same friendly Kenyan sales tone.",
      "- Use familiar electronics terms naturally; English product names and specs are okay.",
      "- If the customer switches back to English, reply in English on the next message.",
    ].join("\n");
  }

  return [
    "LANGUAGE INSTRUCTION:",
    "- Reply in English.",
    "- If the customer writes in Kiswahili, switch to natural Kiswahili on that message.",
  ].join("\n");
}

module.exports = {
  SWAHILI_INDICATORS,
  SWAHILI_THRESHOLD,
  detectLanguage,
  getLanguageInstruction,
};
