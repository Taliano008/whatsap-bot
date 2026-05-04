const { MongoClient } = require("mongodb");
const Redis = require("ioredis");

const SESSION_TTL = 30 * 60; // 30 minutes in seconds
const MAX_EXCHANGES = 5;

let db = null;
let redis = null;

// In-memory fallback when neither Redis nor MongoDB is available
const memoryStore = new Map();

// ── MongoDB (used by orders module) ───────────────────────────────────────────
async function connectMongo() {
  if (!process.env.MONGODB_URI) return null;
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db();
    console.log("✅ MongoDB connected — orders are persistent");
    return db;
  } catch (err) {
    console.warn("⚠️  MongoDB connection failed:", err.message);
    return null;
  }
}

// ── Redis (used for sessions) ─────────────────────────────────────────────────
async function connectRedis() {
  if (!process.env.REDIS_URL) return null;
  try {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
    await redis.ping();
    console.log("✅ Redis connected — sessions are persistent");
    return redis;
  } catch (err) {
    console.warn("⚠️  Redis connection failed — using in-memory sessions:", err.message);
    redis = null;
    return null;
  }
}

function getDb() {
  return db;
}

// ── Session helpers ───────────────────────────────────────────────────────────
async function getSession(phoneNumber) {
  if (redis) {
    try {
      const raw = await redis.get(`session:${phoneNumber}`);
      if (!raw) return { history: [], handoff: false, pendingOrder: null };
      return JSON.parse(raw);
    } catch {
      // fall through to memory
    }
  }

  const session = memoryStore.get(phoneNumber);
  if (!session) return { history: [], handoff: false, pendingOrder: null };
  if (Date.now() - session.lastActive > SESSION_TTL * 1000) {
    memoryStore.delete(phoneNumber);
    return { history: [], handoff: false, pendingOrder: null };
  }
  return session;
}

async function _saveSession(phoneNumber, session) {
  session.lastActive = Date.now();
  if (redis) {
    try {
      await redis.setex(`session:${phoneNumber}`, SESSION_TTL, JSON.stringify(session));
      return;
    } catch {
      // fall through to memory
    }
  }
  memoryStore.set(phoneNumber, session);
}

async function updateSession(phoneNumber, userMessage, assistantReply) {
  const session = await getSession(phoneNumber);

  session.history.push(
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantReply }
  );

  if (session.history.length > MAX_EXCHANGES * 2) {
    session.history = session.history.slice(-(MAX_EXCHANGES * 2));
  }

  await _saveSession(phoneNumber, session);
}

async function clearSession(phoneNumber) {
  if (redis) {
    try {
      await redis.del(`session:${phoneNumber}`);
      await redis.srem("handoff:active", phoneNumber);
    } catch {}
  }
  memoryStore.delete(phoneNumber);
}

// ── Handoff ───────────────────────────────────────────────────────────────────
async function setHandoff(phoneNumber, active) {
  const session = await getSession(phoneNumber);
  session.handoff = active;
  await _saveSession(phoneNumber, session);

  if (redis) {
    try {
      if (active) {
        await redis.sadd("handoff:active", phoneNumber);
      } else {
        await redis.srem("handoff:active", phoneNumber);
      }
    } catch {}
  }
}

async function getHandoffSessions() {
  if (redis) {
    try {
      return await redis.smembers("handoff:active");
    } catch {}
  }
  const result = [];
  for (const [phone, session] of memoryStore.entries()) {
    if (session.handoff) result.push(phone);
  }
  return result;
}

// ── Pending order ─────────────────────────────────────────────────────────────
async function setPendingOrder(phoneNumber, pendingOrder) {
  const session = await getSession(phoneNumber);
  session.pendingOrder = pendingOrder;
  await _saveSession(phoneNumber, session);
}

// ── Cleanup expired in-memory sessions every 10 minutes (Redis uses TTL) ─────
setInterval(() => {
  if (redis) return;
  const now = Date.now();
  for (const [phone, session] of memoryStore.entries()) {
    if (now - session.lastActive > SESSION_TTL * 1000) memoryStore.delete(phone);
  }
}, 10 * 60 * 1000);

module.exports = {
  connectMongo,
  connectRedis,
  getSession,
  updateSession,
  clearSession,
  setHandoff,
  getHandoffSessions,
  setPendingOrder,
  getDb,
};
