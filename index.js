// server/index.js
require('dotenv').config();

const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

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
  PRICE_ID_PRINT: redact(process.env.PRICE_ID_PRINT),
  PRICE_ID_PRO: redact(process.env.PRICE_ID_PRO),
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
//    MUST be before express.json()
// =============================
app.post(
  '/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('[WB] Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Helper to persist plan/status to Supabase
    const setPlan = async (user_id, plan, status, extra = {}) => {
      if (!user_id || !plan) {
        console.warn('[WB] Missing user_id/plan; skip update');
        return;
      }
      const { error } = await supabase
        .from('profiles')
        .update({
          plan,
          subscription_status: status,
          plan_status: status,
          ...extra,
        })
        .eq('id', user_id);
      if (error) throw error;
      console.log('[WB] Profile updated →', { user_id, plan, status });
    };

    try {
      console.log('[WB] Event:', event.type);
      switch (event.type) {
        case 'checkout.session.completed': {
          const s = event.data.object;
          const user_id = s.metadata?.user_id;
          const plan = s.metadata?.plan;
          await setPlan(user_id, plan, 'active', {
            stripe_customer_id: s.customer,
            stripe_subscription_id: s.subscription,
          });

          // Send welcome email (best-effort; don't fail webhook if it errors)
          try {
            await resend.emails.send({
              from: 'Sprouttie <hello@sprouttie.com>',
              to: s.customer_details?.email || s.customer_email,
              subject:
                plan === 'pro'
                  ? 'Welcome to Sprouttie Pro 🌱'
                  : 'Welcome to Sprouttie Print 🌱',
              html: `
                <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto;line-height:1.6">
                  <h2>You're in — ${plan?.toUpperCase()} activated!</h2>
                  <p>Thanks for supporting Sprouttie. Your ${plan} plan is now active.</p>
                  <ul>
                    <li>Open the app and head to <strong>Print Flashcards</strong> to try your new features.</li>
                    <li>Need help? Just reply to this email.</li>
                  </ul>
                  <p>— The Sprouttie Team</p>
                </div>
              `,
            });
          } catch (mailErr) {
            console.error('[WB] Resend welcome email failed:', mailErr);
          }
          break;
        }

        case 'customer.subscription.updated': {
          const sub = event.data.object;
          const plan =
            sub.metadata?.plan ||
            (sub.items?.data?.[0]?.price?.id === process.env.PRICE_ID_PRO
              ? 'pro'
              : 'print');
          const user_id = sub.metadata?.user_id;
          await setPlan(user_id, plan, sub.status, {
            stripe_subscription_id: sub.id,
          });
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const user_id = sub.metadata?.user_id;
          await setPlan(user_id, 'free', 'canceled');
          break;
        }

        case 'invoice.paid':
        case 'invoice.payment_succeeded': {
          const inv = event.data.object;
          const subId = inv.subscription;
          const customerId = inv.customer;

          const sub = await stripe.subscriptions.retrieve(subId, {
            expand: ['items.data.price'],
          });

          const user_id = sub.metadata?.user_id;
          const plan =
            sub.metadata?.plan ||
            (sub.items?.data?.[0]?.price?.id === process.env.PRICE_ID_PRO
              ? 'pro'
              : 'print');

          await setPlan(user_id, plan, sub.status, {
            stripe_customer_id: customerId,
            stripe_subscription_id: subId,
          });
          break;
        }

        default:
          // ignore others
          break;
      }

      res.json({ received: true });
    } catch (e) {
      console.error('[WB] Handler error:', e);
      res.status(500).send('Webhook handler error');
    }
  }
);

// =============================
// JSON parser for normal routes
// =============================
app.use(express.json());

// CORS for client -> server calls
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST', 'OPTIONS'],
  })
);

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// =========================================
// 2) Create Checkout Session (with metadata)
// =========================================
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, userId, email } = req.body;
    console.log('[CHECKOUT] Incoming:', { plan, userId, email });

    // map plan -> price
    let priceId;
    if (plan === 'pro') priceId = process.env.PRICE_ID_PRO;
    else if (plan === 'print') priceId = process.env.PRICE_ID_PRINT;
    else return res.status(400).json({ error: 'Invalid plan' });

    const successUrl = `${process.env.FRONTEND_URL}/profile?payment=success&plan=${plan}`;
    const cancelUrl = `${process.env.FRONTEND_URL}/plans`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: userId,
      metadata: { user_id: userId, plan },
      subscription_data: { metadata: { user_id: userId, plan } },
    });

    console.log('[CHECKOUT] Session created successfully:', session.id);

    res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('[CHECKOUT] Stripe session creation failed:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// =============================
// Start server
// =============================
app.listen(port, () => {
  console.log(`[BOOT] Server running on port ${port}`);
});
