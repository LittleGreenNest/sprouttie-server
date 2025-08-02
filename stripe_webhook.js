const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const router = express.Router();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Lookup map for price_id → plan name
const PRICE_LOOKUP = {
  'price_1Rp1LZEVoum0YBjsFK6SriTG': 'print',
  'price_1Rp1LuEVoum0YBjsKDoh607Y': 'pro',
};

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Handle checkout success
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // ✅ Retrieve full session with line items
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items'],
    });

    const customerEmail = fullSession.customer_email;
    const priceId = fullSession.line_items?.data?.[0]?.price?.id;
    const plan = PRICE_LOOKUP[priceId];

    if (!plan) {
      console.warn('Unrecognized priceId:', priceId);
      return res.status(400).send('Unrecognized plan.');
    }

    // ✅ Insert or update the user’s plan in Supabase
    const { error } = await supabase
      .from('users')
      .upsert(
        { email: customerEmail, plan, created_at: new Date().toISOString() },
        { onConflict: 'email' }
      );

    if (error) {
      console.error('Supabase upsert error:', error.message);
      return res.status(500).send('Database update failed.');
    }

    console.log(`✅ Plan updated for ${customerEmail}: ${plan}`);
    return res.status(200).json({ received: true });
  }

  res.status(200).json({ received: true });
});

module.exports = router;
