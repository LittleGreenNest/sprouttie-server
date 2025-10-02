require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// Simple CORS
app.use(cors());
app.use(express.json());

// Test route
app.get('/debug/config', (req, res) => {
  res.json({
    stripe_secret_key_set: !!process.env.STRIPE_SECRET_KEY,
    message: 'Server working'
  });
});

app.get('/', (req, res) => {
  res.send('Simple server running');
});

app.listen(PORT, () => {
  console.log(`[BOOT] Simple server listening on port ${PORT}`);
});