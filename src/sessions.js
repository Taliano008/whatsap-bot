const { MongoClient } = require("mongodb");

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_EXCHANGES = 5; // store last 5 exchanges (10 messages)

let db = null;

// In-memory fallback when MongoDB is unavailable
const memoryStore = new Map();

async function connectMongo() {
  if (!process.env.MONGODB_URI) return null;
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db();
    console.log("✅ MongoDB connected — sessions are persistent");
    return db;
  } catch (err) {
    console.warn("⚠️  MongoDB connection failed — falling back to in-memory sessions:", err.message);
    return null;
  }
}

async function getSession(phoneNumber) {
  if (db) {
    try {
      const doc = await db.collection("sessions").findOne({ phoneNumber });
      if (!doc) return { history: [], handoff: false };
      if (Date.now() - doc.lastActive > SESSION_TTL_MS) {
        await db.collection("sessions").deleteOne({ phoneNumber });
        return { history: [], handoff: false };
      }
      return { history: doc.history || [], handoff: doc.handoff || false };
    } catch {
      // fall through to memory
    }
  }

  const session = memoryStore.get(phoneNumber);
  if (!session) return { history: [], handoff: false };
  if (Date.now() - session.lastActive > SESSION_TTL_MS) {
    memoryStore.delete(phoneNumber);
    return { history: [], handoff: false };
  }
  return session;
}

async function setHandoff(phoneNumber, active) {
  const now = Date.now();
  if (db) {
    try {
      await db.collection("sessions").updateOne(
        { phoneNumber },
        { $set: { handoff: active, lastActive: now } },
        { upsert: true }
      );
      return;
    } catch {
      // fall through to memory
    }
  }
  const session = memoryStore.get(phoneNumber) || { history: [] };
  memoryStore.set(phoneNumber, { ...session, handoff: active, lastActive: now });
}

async function getHandoffSessions() {
  if (db) {
    try {
      const docs = await db.collection("sessions").find({ handoff: true }).toArray();
      return docs.map((d) => d.phoneNumber);
    } catch {
      // fall through to memory
    }
  }
  const result = [];
  for (const [phone, session] of memoryStore.entries()) {
    if (session.handoff) result.push(phone);
  }
  return result;
}

async function updateSession(phoneNumber, userMessage, assistantReply) {
  const session = await getSession(phoneNumber);

  session.history.push(
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantReply }
  );

  // Keep only last MAX_EXCHANGES exchanges
  if (session.history.length > MAX_EXCHANGES * 2) {
    session.history = session.history.slice(-(MAX_EXCHANGES * 2));
  }

  const now = Date.now();

  if (db) {
    try {
      await db.collection("sessions").updateOne(
        { phoneNumber },
        { $set: { history: session.history, lastActive: now } },
        { upsert: true }
      );
      return;
    } catch {
      // fall through to memory
    }
  }

  memoryStore.set(phoneNumber, { history: session.history, lastActive: now });
}

function clearSession(phoneNumber) {
  if (db) {
    db.collection("sessions").deleteOne({ phoneNumber }).catch(() => {});
  }
  memoryStore.delete(phoneNumber);
}

// Cleanup expired in-memory sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of memoryStore.entries()) {
    if (now - session.lastActive > SESSION_TTL_MS) memoryStore.delete(phone);
  }
}, 10 * 60 * 1000);

module.exports = { connectMongo, getSession, updateSession, clearSession, setHandoff, getHandoffSessions };
