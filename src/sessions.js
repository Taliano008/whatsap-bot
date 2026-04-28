/**
 * Simple in-memory session store.
 * Stores conversation history per WhatsApp phone number.
 * Sessions expire after 30 minutes of inactivity.
 *
 * For production, replace with Redis or a database.
 */

const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getSession(phoneNumber) {
  const session = sessions.get(phoneNumber);
  if (!session) return { history: [] };

  // Check expiry
  if (Date.now() - session.lastActive > SESSION_TTL_MS) {
    sessions.delete(phoneNumber);
    return { history: [] };
  }

  return session;
}

function updateSession(phoneNumber, userMessage, assistantReply) {
  const session = getSession(phoneNumber);

  session.history.push(
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantReply }
  );

  // Keep only last 10 turns (20 messages) to avoid token bloat
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }

  session.lastActive = Date.now();
  sessions.set(phoneNumber, session);
}

function clearSession(phoneNumber) {
  sessions.delete(phoneNumber);
}

// Cleanup expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessions.delete(phone);
    }
  }
}, 10 * 60 * 1000);

module.exports = { getSession, updateSession, clearSession };
