// /server/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: 'https://sprouttie.onrender.com',
  credentials: true,
}));


// ✅ Mount Stripe webhook first — before express.json()
const stripeWebhook = require('./stripe_webhook');
app.use('/stripe-webhook', stripeWebhook);

// ✅ Now apply JSON body parser for everything else
app.use(express.json());

const PRICE_LOOKUP = {
  free: null,
  print: 'price_1RjxmFEVoum0YBjs6744HVGF',
  pro: 'price_1Rjxn9EVoum0YBjsQmCTopO6'
};

app.post('/create-checkout-session', async (req, res) => {
  const { plan } = req.body;
  console.log("Incoming plan:", plan);
const successUrl = `${process.env.FRONTEND_URL}/pdf-success`;
const cancelUrl = `${process.env.FRONTEND_URL}/plans`;

console.log("Redirect URLs:", {
  successUrl,
  cancelUrl
});


  if (!PRICE_LOOKUP[plan]) {
    return res.status(400).json({ error: 'Invalid plan selected' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
  payment_method_types: ['card'],
  line_items: [
    {
      price: PRICE_LOOKUP[plan],
      quantity: 1
    }
  ],
  mode: 'subscription',
  success_url: successUrl,
  cancel_url: cancelUrl,
});

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe session creation failed:', error);
    res.status(500).json({ error: 'Unable to create checkout session' });
  }
});

app.get('/', (req, res) => {
  res.send('Sprouttie server running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
