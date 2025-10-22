// server/stripe_webhook.js
require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Map Stripe price IDs → your internal plan keys
// Fixed: Use 'print' instead of 'pdf' to match your frontend
const PRICE_LOOKUP = {
  [process.env.PRICE_ID_PRINT]: 'print', // Changed from 'pdf' to 'print'
  [process.env.PRICE_ID_PRO]: 'pro',
};

// IMPORTANT: keep raw body for signature verification
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('[WB] signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Helper: update a profile row by id or email
  async function activatePlan({ userId, email, stripeCustomerId, plan, status, periodEnd }) {
    console.log('[WB] Activating plan:', { userId, email, plan, status }); // Add logging
    
    let q = admin.from('profiles').update({
      ...(plan ? { plan } : {}),
      subscription_status: status || 'active',
      stripe_customer_id: stripeCustomerId || null,
      current_period_end: periodEnd || null,
      ...(email ? { email } : {}),
    });

    if (userId) q = q.eq('id', userId);
    else if (email) q = q.eq('email', email);
    else throw new Error('No identifier to update profile');

    const { data, error } = await q.select(); // Add select() to see what was updated
    if (error) {
      console.error('[WB] Database update error:', error);
      throw error;
    }
    console.log('[WB] Successfully updated profile:', data);
  }

  try {
    console.log('[WB] Processing event:', event.type); // Add logging

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('[WB] Checkout session completed:', {
        id: session.id,
        client_reference_id: session.client_reference_id,
        customer_email: session.customer_email,
        metadata: session.metadata
      });

      // expand to get price + subscription info
      const full = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items.data.price', 'subscription'],
      });

      const priceId = full.line_items?.data?.[0]?.price?.id || null;
      console.log('[WB] Price ID from checkout:', priceId);
      
      const plan = PRICE_LOOKUP[priceId];
      if (!plan) {
        console.warn('[WB] Unknown priceId', priceId, 'Available:', Object.keys(PRICE_LOOKUP));
        return res.status(200).json({ received: true });
      }

      const stripeCustomerId = full.customer || full.subscription?.customer || null;
      const periodEnd = full.subscription?.current_period_end
        ? new Date(full.subscription.current_period_end * 1000).toISOString()
        : null;

      const userId = full.metadata?.user_id || full.client_reference_id || null;
      const email = full.customer_details?.email || full.customer_email || null;

      console.log('[WB] Attempting to activate plan:', { userId, email, plan });

      await activatePlan({ userId, email, stripeCustomerId, plan, status: 'active', periodEnd });

      // TODO (optional): send "Plan activated" email here
      return res.status(200).json({ received: true });
    }

    if (event.type === 'invoice.payment_succeeded') {
      const inv = event.data.object;
      const stripeCustomerId = inv.customer;
      const periodEnd = inv.lines?.data?.[0]?.period?.end
        ? new Date(inv.lines.data[0].period.end * 1000).toISOString()
        : null;

      const { data: prof } = await admin
        .from('profiles')
        .select('id,email')
        .eq('stripe_customer_id', stripeCustomerId)
        .maybeSingle();

      if (prof) {
        await activatePlan({
          userId: prof.id,
          email: prof.email,
          stripeCustomerId,
          plan: null, // Keep existing plan
          status: 'active',
          periodEnd,
        });
      }
      return res.status(200).json({ received: true });
    }

    if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
      const obj = event.data.object;
      const stripeCustomerId = obj.customer;
      await admin
        .from('profiles')
        .update({ plan: 'free', subscription_status: 'canceled' })
        .eq('stripe_customer_id', stripeCustomerId);

      // TODO (optional): send "Subscription canceled" email
      return res.status(200).json({ received: true });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[WB] handler error:', err);
    return res.status(500).send('Webhook handler failed');
  }
});

module.exports = router;