# Implementing a Payment Gateway

This is a guide, not a completed integration — nothing in `backend/` or `frontend/`
has been changed to add this yet. It documents the recommended approach and the exact
changes needed so it can be implemented deliberately, with the security tradeoffs
understood up front rather than discovered later.

## Why this is different from every other integration in this project

Every other integration so far (MongoDB, ECR, EKS) fails safely — a bug means a broken
deploy or a 500 error. A payment integration bug can mean **charging the wrong amount,
double-charging, or handling card data in a way that puts you in PCI-DSS scope you
didn't intend to take on.** The design goal below is chosen specifically to avoid that
last one: the backend should **never see, log, or store a raw card number** at any
point. That single decision is what keeps this in the simplest PCI compliance tier
(SAQ-A) instead of the expensive, audited tiers that apply once your own servers
handle card data directly.

## Recommended approach: hosted/tokenized checkout, not a custom card form

Two gateways fit this project well, for different reasons:

| Gateway | Why it fits here |
|---|---|
| **Stripe** | The most widely documented option, excellent test-mode tooling (test cards, a CLI for local webhook testing), and the de-facto reference implementation most engineers expect to see in a portfolio project. Used as the primary example below. |
| **Razorpay** | India-specific: supports UPI, netbanking, and local card rails that Stripe doesn't handle as natively in India; since this project's infrastructure is entirely in `ap-south-1`, it's worth knowing as the regionally-appropriate alternative. The integration shape (hosted checkout → webhook → verify → update order) is nearly identical — swap the SDK and field names. |

Either way, use the gateway's **hosted checkout flow** (Stripe Checkout / Razorpay
Checkout), not their raw card-input APIs (Stripe Elements' lower-level card fields,
Razorpay's custom checkout). The hosted flow means the customer is redirected to a page
*the gateway* serves, enters card details *there*, and your backend only ever sees a
tokenized reference to a completed payment — never the card number itself.

## Architecture

```
1. Customer clicks "Checkout" in the frontend cart
2. Frontend calls backend: POST /api/orders/:id/checkout
3. Backend creates the order first (existing /api/orders route, unchanged),
   then creates a Checkout Session with the gateway, referencing that order's
   total and ID as metadata
4. Backend returns the gateway's hosted checkout URL
5. Frontend redirects the browser to that URL (the gateway's own domain)
6. Customer enters card details on the gateway's page — never touches our servers
7. Gateway redirects back to a success/cancel URL on our frontend
8. Independently, the gateway sends a webhook (server-to-server, not via the
   browser) to our backend confirming the payment actually succeeded
9. Backend verifies the webhook's signature, then updates the Order's
   paymentStatus in MongoDB
10. Frontend's success page polls GET /api/orders/:id until paymentStatus
    shows "paid" (or is told directly, if you pass the order ID through)
```

**The critical detail: step 8, not step 7, is the source of truth.** The redirect
in step 7 tells the *browser* the payment succeeded, but that redirect can be spoofed,
interrupted, or never happen (closed tab, network drop) — it must never be what marks
an order as paid. Only the signed, server-to-server webhook in step 8 is trustworthy.

## Concrete changes needed (Stripe example)

### 1. Data model — `backend/src/models/Order.js`

Add fields to track payment state without touching the existing `items`/`total` shape:

```js
const orderSchema = new Schema({
  items: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
  total: { type: Number, required: true },
  status: { type: String, default: 'pending' }, // existing field
  paymentStatus: {
    type: String,
    enum: ['unpaid', 'paid', 'failed'],
    default: 'unpaid',
  },
  stripeCheckoutSessionId: { type: String },
}, { timestamps: true });
```

### 2. New dependency

```bash
cd backend && npm install stripe
```

### 3. New route — create a Checkout Session

```js
// backend/src/routes/checkout.js
const express = require('express');
const Stripe = require('stripe');
const Order = require('../models/Order');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

router.post('/:orderId', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // amount in the smallest currency unit — paise for INR, not rupees
      line_items: [{
        price_data: {
          currency: 'inr',
          product_data: { name: `Order ${order._id}` },
          unit_amount: Math.round(order.total * 100),
        },
        quantity: 1,
      }],
      metadata: { orderId: order._id.toString() }, // ties the webhook back to this order
      success_url: `${process.env.FRONTEND_URL}/checkout/success?order=${order._id}`,
      cancel_url: `${process.env.FRONTEND_URL}/checkout/cancel?order=${order._id}`,
    });

    order.stripeCheckoutSessionId = session.id;
    await order.save();

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

### 4. New route — the webhook (this is the part that actually confirms payment)

```js
// backend/src/routes/stripeWebhook.js
const express = require('express');
const Stripe = require('stripe');
const Order = require('../models/Order');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

// IMPORTANT: this route needs the RAW request body to verify the signature,
// not the JSON-parsed body express.json() produces — mount it BEFORE
// app.use(express.json()) in server.js, or use express.raw() scoped to
// just this route.
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    // Signature didn't match — reject. This is what stops anyone who
    // isn't Stripe from POSTing a fake "payment succeeded" event.
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Idempotent by design: setting paymentStatus to 'paid' twice for the
    // same order is harmless, so Stripe's automatic webhook retries (it
    // retries on any non-2xx response) can never cause a double-charge.
    await Order.findByIdAndUpdate(session.metadata.orderId, { paymentStatus: 'paid' });
  }

  res.json({ received: true });
});

module.exports = router;
```

Wire both into `backend/src/server.js`:
```js
const checkoutRouter = require('./routes/checkout');
const stripeWebhookRouter = require('./routes/stripeWebhook');

app.use('/api/checkout', checkoutRouter);
app.use('/api/webhooks/stripe', stripeWebhookRouter); // mount before express.json()
```

### 5. Frontend — redirect to the hosted checkout

```js
// frontend/src/api.js — add alongside the existing getProducts/createOrder
export const startCheckout = (orderId) =>
  api.post(`/api/checkout/${orderId}`).then((r) => r.data);
```
```js
// wherever "Place Order" is handled
const order = await createOrder(cartItems);
const { checkoutUrl } = await startCheckout(order._id);
window.location.href = checkoutUrl; // leaves the app entirely — this is expected
```

### 6. Secrets — same pattern as `mongo-credentials`

Don't put `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` in `k8s/configmap.yaml` (that's
for non-secret config only, per the existing convention in this repo). Add a new
`stripe-credentials` Secret, following the exact same shape `k8s/secret.yaml` already
uses for Mongo, and reference it in `k8s/backend-deployment.yaml`'s `env` block the
same way `MONGO_URI` is referenced there now. In Jenkins, add a matching credential
(Secret text) and bind it in the `Deploy to Kubernetes` stage, same pattern as
`ecr-registry-url`.

## Testing before touching real money

- Stripe's test mode uses a separate set of API keys (prefixed `sk_test_`/`pk_test_`)
  — nothing in test mode ever touches a real card network.
- Test card `4242 4242 4242 4242`, any future expiry, any CVC, always succeeds.
  Stripe documents specific test numbers for simulating declines, insufficient funds,
  and 3D Secure challenges too.
- **Webhooks need a public HTTPS endpoint in production, but for local development use
  the Stripe CLI** (`stripe listen --forward-to localhost:5000/api/webhooks/stripe`) —
  it forwards real webhook events to your local machine without deploying anything,
  and prints a webhook signing secret you can use directly as `STRIPE_WEBHOOK_SECRET`
  for local testing.

## Security checklist specific to payments

- [ ] The backend never receives, logs, or stores a raw card number, CVC, or expiry —
      confirm by checking every log statement near the checkout/webhook routes
- [ ] The **amount charged** is computed server-side from the `Order`'s own stored
      `total` (already true in the sketch above — `unit_amount` reads from `order.total`,
      never from anything the client sends in the checkout request)
- [ ] Webhook signature verification is never skipped, even temporarily "to test
      something" — an unverified webhook route lets anyone on the internet mark any
      order as paid with a single `curl` command
- [ ] The webhook handler is idempotent — Stripe retries webhook delivery on any
      non-2xx response, so it **will** send the same event more than once in normal
      operation, not just as an edge case
- [ ] `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` live only in the Kubernetes
      Secret / Jenkins credential store — never in `k8s/configmap.yaml`, never
      committed to git, never logged
- [ ] Currency and amount units are correct — Stripe (and most gateways) expect the
      **smallest unit** of the currency (paise for INR, cents for USD), not the
      human-readable amount; a missed `× 100` either overcharges by 100x or undercharges
      to nearly zero

## What NOT to do

- **Don't build a custom card-number input form** that posts to your own backend —
  this is the PCI-DSS-heavy path (full SAQ-D scope), and Stripe/Razorpay's own
  hosted/Elements flows exist specifically so you never need to.
- **Don't trust the browser redirect as proof of payment** — see the architecture note
  above; only the signed webhook is trustworthy.
- **Don't skip idempotency "for now"** — webhook retries are normal Stripe behavior,
  not a failure case; a non-idempotent handler will eventually double-process a real
  payment.
- **Don't reuse the same Stripe keys across test and live mode without a clear
  separation** — mixing them up means either testing against real money or,
  worse, accidentally taking real payments while believing you're still in test mode.
