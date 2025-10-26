// server/index.js
require('dotenv').config();

console.log('[BOOT] Prices:',
  process.env.PRICE_ID_PRINT_MONTHLY,
  process.env.PRICE_ID_PRINT_YEARLY,
  process.env.PRICE_ID_PRO_MONTHLY,
  process.env.PRICE_ID_PRO_YEARLY
);
console.log('[BOOT] FRONTEND_URL:', process.env.FRONTEND_URL);

const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const app = express();
const port = process.env.PORT || 5001;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Supabase admin (service role)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- Boot logs (safe) ----
console.log('[BOOT] Stripe prices:', {
  PRICE_ID_PRINT_MONTHLY: redact(process.env.PRICE_ID_PRINT_MONTHLY),
  PRICE_ID_PRINT_YEARLY: redact(process.env.PRICE_ID_PRINT_YEARLY),
  PRICE_ID_PRO_MONTHLY: redact(process.env.PRICE_ID_PRO_MONTHLY),
  PRICE_ID_PRO_YEARLY: redact(process.env.PRICE_ID_PRO_YEARLY),
});
console.log('[BOOT] FRONTEND_URL:', process.env.FRONTEND_URL);
console.log(
  '[BOOT] Using test key:',
  process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')
);

// Helper to avoid printing full IDs
function redact(v) {
  if (!v) return v;
  return v.slice(0, 7) + '...' + v.slice(-6);
}

// ⬇️ Mount the webhook FIRST so it receives the raw body

const stripeWebhook = require('./stripe_webhook');
app.use('/stripe-webhook', stripeWebhook);

// =============================
// JSON parser for normal routes
// =============================
app.use(express.json());

// CORS for client -> server calls
const allowed = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    const o = (origin || '').toLowerCase();
    cb(null, !origin || allowed.includes(o));
  },
  methods: ['GET','POST','OPTIONS'],
  credentials: false
}));

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// =========================================
// 2) Create Checkout Session (server derives priceId)
// =========================================
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, billingCycle = 'monthly', userId, email } = req.body;

    console.log('[CHECKOUT] payload:', { plan, billingCycle, userId, email });

    if (!plan || !userId) {
      return res.status(400).json({ error: 'Missing plan or userId' });
    }

    // Map plan + billingCycle → Stripe priceId (TEST IDs in .env)
    const PRICE = {
      print: {
        monthly: process.env.PRICE_ID_PRINT_MONTHLY,
        yearly: process.env.PRICE_ID_PRINT_YEARLY,
      },
      pro: {
        monthly: process.env.PRICE_ID_PRO_MONTHLY,
        yearly: process.env.PRICE_ID_PRO_YEARLY,
      },
    };

    const priceId = PRICE[plan]?.[billingCycle];
    console.log('[CHECKOUT] resolved priceId:', priceId);
    if (!priceId) {
      return res.status(400).json({ error: 'Unknown plan/billingCycle (no priceId configured)' });
    }

    const successUrl = `${process.env.FRONTEND_URL}/profile?payment=success&plan=${encodeURIComponent(plan)}`;
    const cancelUrl  = `${process.env.FRONTEND_URL}/plans?payment=cancelled`;

    // 1) Read existing customer id (OK if row doesn't exist yet)
    const { data: profile, error: profErr } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .maybeSingle(); // ← important

    if (profErr) {
      console.error('[CHECKOUT] Supabase profiles read error:', profErr);
      return res.status(500).json({ error: 'Profile read failed' });
    }

    let customerId = profile?.stripe_customer_id;

    // 2) Create a new Stripe customer if missing
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: email || undefined,
        metadata: { user_id: userId },
      });
      customerId = customer.id;

      const { error: updErr } = await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);

      if (updErr) console.warn('[CHECKOUT] Supabase profiles update error:', updErr);
    }


// --- derive userId from Supabase Auth token (server-side verification) ---
const supaJwt = req.headers.authorization?.replace('Bearer ', '');
let verifiedUserId = userId;

if (supaJwt) {
  try {
    const { data, error } = await supabase.auth.getUser(supaJwt);
    if (!error && data?.user?.id) {
      verifiedUserId = data.user.id;
    }
  } catch (e) {
    console.warn('[CHECKOUT] Supabase auth verify failed:', e.message);
  }
}

// fallback if client provided it directly (already handled above)
if (!verifiedUserId) {
  return res.status(400).json({ error: 'Missing verified userId' });
}

    // 3) Create Checkout session
    const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  customer: customerId,
  line_items: [{ price: priceId, quantity: 1 }],
  success_url: successUrl,
  cancel_url: cancelUrl,
  client_reference_id: verifiedUserId,
  metadata: { user_id: verifiedUserId, plan },
  subscription_data: { metadata: { user_id: verifiedUserId, plan } },
}, {
  idempotencyKey: `${verifiedUserId}:${plan}:${billingCycle}`,
});

    console.log('[CHECKOUT] Session created:', session.id);
    return res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    const msg = err?.raw?.message || err?.message || 'Failed to create checkout session';
    const code = err?.type ? 400 : 500; // Stripe param errors often include type
    console.error('[CHECKOUT] error:', msg);
    return res.status(code).json({ error: msg });
  }
});

// =========================================
// Billing Portal session (Manage Billing)
// =========================================
app.post('/create-portal-session', async (req, res) => {
  try {
    const { userId, email } = req.body; // <-- send both from the client
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    console.log('[PORTAL] request for user:', { userId, email });

    // 1) Read customer id from profiles (best-effort)
    const { data: prof, error: profErr } = await supabase
      .from('profiles')
      .select('stripe_customer_id, email')
      .eq('id', userId)
      .maybeSingle();

    if (profErr) {
      console.error('[PORTAL] profile read error:', profErr);
      return res.status(500).json({ error: 'Profile read failed' });
    }

    let customerId = prof?.stripe_customer_id || null;
    const profileEmail = prof?.email || email || null;

    // 2) If missing, try finding a Stripe customer by email and backfill
    if (!customerId && profileEmail) {
      try {
        const found = await stripe.customers.search({ query: `email:"${profileEmail}"` });
        const customer = found?.data?.[0];
        if (customer?.id) {
          customerId = customer.id;
          // backfill to profiles (non-fatal if it fails)
          const { error: updErr } = await supabase
            .from('profiles')
            .update({ stripe_customer_id: customerId })
            .eq('id', userId);
          if (updErr) console.warn('[PORTAL] backfill update error:', updErr);
          console.log('[PORTAL] backfilled customer id:', customerId);
        }
      } catch (e) {
        console.warn('[PORTAL] email search failed:', e?.message || e);
      }
    }

    if (!customerId) {
      return res.status(400).json({ error: 'No Stripe customer for this user' });
    }

    // 3) Create the portal session
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.FRONTEND_URL}/profile`,
    });

    console.log('[PORTAL] session created:', portal.id);
    return res.json({ url: portal.url });
  } catch (e) {
    const msg = e?.raw?.message || e?.message || 'Unable to open billing portal';
    console.error('[PORTAL] error:', msg);
    return res.status(500).json({ error: msg });
  }
});

// =============================
// Start server
// =============================
app.listen(port, () => {
  console.log(`[BOOT] Server running on port ${port}`);
});
