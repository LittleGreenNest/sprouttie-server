// /server/stripe-webhook.js
require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const app = express();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post('/stripe-webhook', bodyParser.raw({ type: 'application/json' }), async (request, response) => {
  const sig = request.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed.', err.message);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_email;
      const plan = session.metadata?.plan || 'basic';

      if (email) {
        const { data: user, error } = await supabase
          .from('profiles')
          .update({ plan })
          .eq('email', email)
          .select();

        if (error) {
          console.error('❌ Supabase update error:', error.message);
        } else {
          console.log(`✅ Plan '${plan}' saved for ${email}`);
        }
      }
      break;
    }
    case 'invoice.payment_succeeded': {
      console.log('✅ Payment succeeded');
      break;
    }
    case 'customer.subscription.deleted': {
      console.log('❌ Subscription cancelled');
      break;
    }
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  response.send();
});

module.exports = app;

