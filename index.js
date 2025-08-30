// /server/index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL;

// CORS: allow prod app + local dev
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // allow curl/Postman/no-origin
      return allowedOrigins.includes(origin)
        ? cb(null, true)
        : cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// Ensure OPTIONS preflight succeeds
app.options(
  '*',
  cors({
    origin: allowedOrigins,
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);


/**
 * IMPORTANT: Mount Stripe webhook BEFORE express.json()
 * Your stripe_webhook module should use express.raw({ type: 'application/json' })
 * for the webhook route.
 */
const stripeWebhook = require('./stripe_webhook');
app.use('/stripe-webhook', stripeWebhook);

// JSON parser for the rest
app.use(express.json());

// ---------- Prices via ENV ----------
const PRICES = {
  free: null,
  print: process.env.PRICE_ID_Print,
  pro: process.env.PRICE_ID_PRO,
};

// Fail fast if missing required env vars
['STRIPE_SECRET_KEY', 'PRICE_ID_Print', 'PRICE_ID_PRO', 'FRONTEND_URL'].forEach((k) => {
  if (!process.env[k]) {
    console.warn(`[BOOT] Missing env var ${k}`);
  }
});

// Masking helper for safe logs
const mask = (v) =>
  typeof v === 'string' && v.startsWith('price_')
    ? v.slice(0, 8) + '...' + v.slice(-6)
    : v;

// Log what the server booted with (masked)
console.log('[BOOT] Stripe prices:', {
  PRICE_ID_Print: mask(process.env.PRICE_ID_Print),
  PRICE_ID_PRO: mask(process.env.PRICE_ID_PRO),
});
console.log('[BOOT] FRONTEND_URL:', FRONTEND_URL);

// ---------- Routes ----------
app.post('/create-checkout-session', async (req, res) => {
  const { plan, userId, email } = req.body; // <-- add these

  console.log('[CHECKOUT] Incoming:', { plan, userId, email });

  const successUrl = `${FRONTEND_URL}/pdf-success`;
  const cancelUrl = `${FRONTEND_URL}/plans`;

  const priceId = PRICES[plan];
  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan selected' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,

      // ✅ identifiers for the webhook
      client_reference_id: userId,
      customer_email: email,
      metadata: { user_id: userId, plan },
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error('[CHECKOUT] Stripe session creation failed:', error);
    return res.status(500).json({ error: 'Unable to create checkout session' });
  }
});


app.get('/', (req, res) => {
  res.send('Sprouttie server running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// (Optional) Quick probe to verify envs on the deployed server
// Remove after testing.
// app.get('/debug/prices', (req, res) => {
//   res.json({
//     print: mask(process.env.PRICE_ID_Print),
//     pro: mask(process.env.PRICE_ID_PRO),
//     frontend: FRONTEND_URL,
//     server: 'ok',
//   });
// });

app.listen(PORT, () => {
  console.log(`[BOOT] Server listening on port ${PORT}`);
});
