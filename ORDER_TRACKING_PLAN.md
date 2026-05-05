# Order Tracking Feature — Implementation Plan

## Overview

Customers can place orders through the bot conversation and later check status
with a simple message. The owner updates order status via WhatsApp commands and
customers get auto-notified on every status change.

---

## Status Flow

```
pending → confirmed → processing → shipped → delivered
                                         ↘ cancelled
```

---

## Data Model — `orders` collection (MongoDB)

```js
{
  orderId:     "ORD-20260504-001",   // auto-generated
  phone:       "254712345678",        // customer WhatsApp number
  name:        "John Kamau",
  items: [
    { name: "Samsung Galaxy A55", qty: 1, price: 42000 }
  ],
  total:       42000,
  status:      "pending",             // see flow above
  location:    "Westlands, Nairobi",  // delivery address
  notes:       "Call before delivery",
  createdAt:   Date,
  updatedAt:   Date,
  history: [                          // status audit trail
    { status: "pending", at: Date }
  ]
}
```

---

## What Needs to Be Built

### 1. `src/orders.js` — new file
Handles all MongoDB order operations:
- `createOrder(phone, name, items, location, notes)` → returns `orderId`
- `getOrdersByPhone(phone)` → returns last 5 orders
- `getOrderById(orderId)` → returns single order
- `updateOrderStatus(orderId, newStatus)` → updates + appends to history
- `getAllOrders(limit)` → for owner view

### 2. `src/index.js` — extend message handler
Add two new command branches before the AI flow:

**Customer commands (any customer):**
- `"track my order"` / `"order status"` / `"ambia order yangu"` → bot
  looks up orders by phone and replies with latest status
- `"my orders"` → lists last 3 orders with statuses

**Owner commands (OWNER_PHONE only):**
- `#order <orderId> <status>` → updates status, notifies customer
  - e.g. `#order ORD-20260504-001 shipped`
- `#orders` → lists all pending/processing orders
- `#order <orderId> cancel` → cancels with optional reason

### 3. `src/claude.js` — system prompt addition
Add order-taking guidance to Teki's prompt so she can:
- Collect: product name, quantity, delivery location, contact confirmation
- Confirm total and summarise before asking customer to confirm
- Trigger order creation when customer says "yes" / "confirm" / "ndio"
- Reply with order ID and next steps (deposit instructions)

### 4. `src/sessions.js` — order-taking state
Add `pendingOrder` field to session so multi-turn order collection works:
```js
pendingOrder: {
  items: [],
  step: "items" | "location" | "confirm" | null
}
```

---

## Customer Experience

**Placing an order:**
```
Customer: I want to buy Samsung Galaxy A55
Teki:     Great choice! ✅ Samsung Galaxy A55 — KSh 42,000
          To place an order, what's your delivery location?
Customer: Westlands
Teki:     Got it! Here's your order summary:
          - Samsung Galaxy A55 x1 — KSh 42,000
          - Delivery: Westlands, Nairobi
          Total: KSh 42,000
          Confirm order? (Yes / No)
Customer: Yes
Teki:     Order placed! 🎉
          Your order ID: ORD-20260504-001
          Next step: Send 30% deposit (KSh 12,600) to
          M-Pesa Paybill 123456 — Account: ORD-20260504-001
          We'll confirm once payment is received!
```

**Tracking an order:**
```
Customer: track my order
Teki:     Here's your latest order:
          ORD-20260504-001 — Samsung Galaxy A55
          Status: Shipped 🚚
          Updated: 4 May 2026, 2:30pm
          Any questions? 😊
```

**Owner updating status:**
```
Owner sends to bot: #order ORD-20260504-001 shipped
Bot to owner:  ✅ ORD-20260504-001 updated to "shipped"
Bot to customer: 📦 Your order ORD-20260504-001 has been shipped!
                 Samsung Galaxy A55 is on its way to Westlands.
                 Expected today or tomorrow. Track via Sendy if shared.
                 Questions? Just reply here 😊
```

---

## New Environment Variable

| Key | Value | Purpose |
|-----|-------|---------|
| `ORDER_NOTIFY` | `true` | Enable/disable customer status notifications |

No new external services — uses existing MongoDB.

---

## Files Summary

| File | Action |
|------|--------|
| `src/orders.js` | Create — order CRUD functions |
| `src/sessions.js` | Edit — add `pendingOrder` field |
| `src/claude.js` | Edit — add order-taking to system prompt |
| `src/index.js` | Edit — add track/order command routing |
| `.env.example` | Edit — add `ORDER_NOTIFY` |

**Estimated effort:** ~4–5 hours of coding across those 5 files.

---

## Out of Scope (for now)

- Payment confirmation via M-Pesa API (complex — separate integration)
- Admin web dashboard
- Multi-item cart with images
- Delivery tracking integration (Sendy/G4S API)
