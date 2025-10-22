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

// =============================
// 1) Stripe WEBHOOK (raw body)
// =============================
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[WB] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Idempotency
  try {
    const { error: insertErr } = await supabase
      .from('stripe_events')
      .insert({ id: event.id });
    if (insertErr && (insertErr.code === '23505' || insertErr.message?.includes('duplicate'))) {
      console.log(`[WB] Duplicate event ${event.id}, skipping`);
      return res.json({ received: true });
    }
  } catch (e) {
    console.error('[WB] Idempotency insert failed:', e);
    return res.status(500).send('Guard error');
  }

  const setPlan = async (user_id, plan, status, extra = {}) => {
  if (!user_id) return;
  const update = { id: user_id, plan, subscription_status: status, ...extra };
  const { error } = await supabase
    .from('profiles')
    .upsert(update, { onConflict: 'id' });
  if (error) console.error('[WB] Supabase upsert error:', error);
  else console.log('[WB] Profile upserted →', { user_id, plan, status });
};

  const mapPriceToPlan = (priceId) => {
    const P = {
      print: [process.env.PRICE_ID_PRINT_MONTHLY, process.env.PRICE_ID_PRINT_YEARLY],
      pro:   [process.env.PRICE_ID_PRO_MONTHLY,   process.env.PRICE_ID_PRO_YEARLY],
    };
    if (P.print.includes(priceId)) return 'print';
    if (P.pro.includes(priceId))   return 'pro';
    return null;
  };

  try {
    console.log('[WB] Event:', event.type);

    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const user_id = s.client_reference_id || s.metadata?.user_id;
        const sub_id  = s.subscription;
console.log('[WB] checkout.session.completed →', {
  user_id, sub_id, email: s.customer_details?.email || s.customer_email
});

        // derive plan from subscription price if metadata missing
        let plan = s.metadata?.plan || null;
        if (!plan && sub_id) {
          const sub = await stripe.subscriptions.retrieve(sub_id, { expand: ['items.data.price'] });
          const priceId = sub.items?.data?.[0]?.price?.id || null;
          plan = mapPriceToPlan(priceId) || 'print';
        }

        await setPlan(user_id, plan, 'active', {
          stripe_customer_id: s.customer,
          stripe_subscription_id: sub_id
        });

        // best-effort welcome email
        try {
          if (resend) {
            await resend.emails.send({
              from: 'Sprouttie <hello@sprouttie.com>',
              to: s.customer_details?.email || s.customer_email,
              subject: plan === 'pro' ? 'Welcome to Sprouttie Pro 🌱' : 'Welcome to Sprouttie Print 🌱',
              html: '<p>Thanks for subscribing! 🎉</p>'
            });
          } else {
            console.log('[EMAIL] RESEND_API_KEY not set — skipping');
          }
        } catch (e) {
          console.warn('[WB] Resend failed (non-fatal):', e.message);
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user_id = sub.metadata?.user_id;
        const priceId = sub.items?.data?.[0]?.price?.id || null;
        const plan = mapPriceToPlan(priceId) || sub.metadata?.plan || 'print';
        const periodEndIso = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

        await setPlan(user_id, plan, sub.status, {
          stripe_subscription_id: sub.id,
          current_period_end: periodEndIso
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user_id = sub.metadata?.user_id;
        await setPlan(user_id, 'free', 'canceled', { stripe_subscription_id: sub.id });
        break;
      }

      default:
        // accept but ignore others
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('[WB] handler error:', err);
    return res.status(500).send('Webhook handler error');
  }
});


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

    // 3) Create Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: userId,
      metadata: { user_id: userId, plan },
      subscription_data: { metadata: { user_id: userId, plan } },
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
