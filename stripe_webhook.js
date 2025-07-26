require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

router.use(bodyParser.raw({ type: 'application/json' }));

router.post('/', async (request, response) => {
  const sig = request.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object;
      const email = invoice.customer_email;

      try {
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const priceId = subscription.items.data[0].price.id;

        let plan = 'free';
        if (priceId === process.env.PRICE_ID_Print) plan = 'pdf';
        else if (priceId === process.env.PRICE_ID_PRO) plan = 'pro';

        if (email && plan !== 'free') {
          const { data: userList, error: listError } = await supabase.auth.admin.listUsers();
          if (listError) throw listError;

          const matchedUser = userList.users.find((u) => u.email === email);

          if (matchedUser) {
            const { error: updateError } = await supabase.auth.admin.updateUserById(matchedUser.id, {
              user_metadata: { plan }
            });

            if (updateError) {
              console.error('Failed to update user_metadata:', updateError.message);
            } else {
              console.log(`✅ Plan '${plan}' saved in user_metadata for ${email}`);
            }
          } else {
            console.warn(`User with email ${email} not found.`);
          }
        }
      } catch (err) {
        console.error('Error processing invoice.paid:', err.message);
      }

      break;
    }

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  response.send();
});

module.exports = router;
