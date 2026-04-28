const { google } = require("googleapis");
const path = require("path");

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ||
        "./config/google-service-account.json"
    ),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

/**
 * Fetch all inventory rows from the Google Sheet.
 * Returns an array of product objects.
 */
async function getInventory() {
  const sheets = await getSheetsClient();
  const sheetId = process.env.GOOGLE_SHEET_ID;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Inventory!A2:L1000", // Skip header row
  });

  const rows = response.data.values || [];

  return rows
    .filter((row) => row[0]) // skip empty rows
    .map((row) => ({
      id: row[0] || "",
      name: row[1] || "",
      brand: row[2] || "",
      category: row[3] || "",
      model: row[4] || "",
      price: row[5] || "",
      originalPrice: row[6] || "",
      quantity: parseInt(row[7]) || 0,
      status: row[8] || "Unknown",
      warranty: row[9] || "",
      description: row[10] || "",
      notes: row[11] || "",
    }));
}

/**
 * Search inventory by keyword — matches name, brand, category, model.
 * Returns up to 5 most relevant products.
 */
async function searchInventory(query) {
  const inventory = await getInventory();
  const q = query.toLowerCase();

  const results = inventory.filter((p) => {
    return (
      p.name.toLowerCase().includes(q) ||
      p.brand.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.model.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q)
    );
  });

  return results.slice(0, 5);
}

/**
 * Format inventory data as a readable text block for the AI prompt.
 */
function formatInventoryForPrompt(products) {
  if (!products.length) return "No matching products found in inventory.";

  return products
    .map((p) => {
      const inStock = p.quantity > 0;
      const stockLabel = inStock
        ? `In Stock (${p.quantity} units)`
        : "Out of Stock";
      const discount =
        p.originalPrice && p.originalPrice !== p.price
          ? ` (was KSh ${p.originalPrice})`
          : "";

      return [
        `• ${p.brand} ${p.name} ${p.model}`.trim(),
        `  Category: ${p.category}`,
        `  Price: KSh ${p.price}${discount}`,
        `  Stock: ${stockLabel}`,
        `  Warranty: ${p.warranty}`,
        p.description ? `  Details: ${p.description}` : "",
        p.notes ? `  Note: ${p.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/**
 * Get a summary of all categories + stock counts (for "what do you sell?" queries).
 */
async function getCategorySummary() {
  const inventory = await getInventory();
  const summary = {};

  inventory.forEach((p) => {
    if (!summary[p.category]) {
      summary[p.category] = { total: 0, inStock: 0 };
    }
    summary[p.category].total++;
    if (p.quantity > 0) summary[p.category].inStock++;
  });

  return Object.entries(summary)
    .map(([cat, s]) => `• ${cat}: ${s.inStock}/${s.total} items in stock`)
    .join("\n");
}

module.exports = { getInventory, searchInventory, formatInventoryForPrompt, getCategorySummary };
