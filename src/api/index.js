// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('src/pages')); // serve index.html and success.html from src/pages
app.use('/assets', express.static('public/assets')); // serve assets from public/assets

// Log all incoming requests
app.use((req, res, next) => {

  next();
});

app.use(bodyParser.json());






// Catch unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    // console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Application specific logging, throwing an error, or other logic here
  });

  // Catch uncaught exceptions
  process.on('uncaughtException', (error) => {
    // console.error('Uncaught Exception:', error);
    // Application specific logging, throwing an error, or other logic here
    process.exit(1); // It's a good practice to exit for uncaught exceptions
  });

  app.listen(PORT, () => {

  }).on('error', (err) => {
    // console.error('Failed to start server:', err);
  });



const payments = {}; // in-memory store: checkoutRequestID -> { status, receipt, registration_id, phone, amount }

let _cachedToken = null;
let _cachedTokenExpiry = 0; // ms epoch

async function getAccessToken() {

  // Use cached token if still valid (5s safety buffer)
  const now = Date.now();
  if (_cachedToken && now + 5000 < _cachedTokenExpiry) {

    return _cachedToken;
  }


  const consumerKey = process.env.CONSUMER_KEY;
  const consumerSecret = process.env.CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    // console.error('Missing CONSUMER_KEY or CONSUMER_SECRET env vars.');
    throw new Error('Missing Daraja consumer credentials.');
  }

  const isProd = String(process.env.DARAJA_ENV).toLowerCase() === 'production';
  const url = isProd
    ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
    : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';



  try {
    // axios auth option will set the Authorization: Basic header correctly
    const resp = await axios.get(url, {
      auth: { username: consumerKey, password: consumerSecret },
      headers: { Accept: 'application/json' },
      timeout: 10000
    });

    if (!resp || !resp.data) {
      // console.error('Empty token response:', resp && resp.status);
      throw new Error('Empty token response from Daraja');
    }

    // resp.data should have: { access_token: '...', expires_in: '3600' }
    const token = resp.data.access_token || resp.data.accessToken || null;
    const expiresIn = Number(resp.data.expires_in || resp.data.expiresIn || 3600);

    if (!token) {
      // console.error('No access_token in response:', resp.data);
      throw new Error('No access_token returned by Daraja.');
    }

    _cachedToken = token;
    _cachedTokenExpiry = Date.now() + (expiresIn * 1000);

    return token;
  } catch (err) {
    // Show any error response body if available (very helpful)
    if (err.response && err.response.data) {
      // console.error('Access token error response data:', err.response.data);
    } else {
      // console.error('Access token error:', err.message || err);
    }
    throw err;
  }
}


// STK Push
app.post('/api/stkpush', async (req, res) => {



  try {
    const { registration_id, phone, referral_code, amount, email } = req.body;

    if(!registration_id || !phone || !email) {
      // console.error('Validation error: registration_id, phone, or email missing.');
      return res.status(400).json({ message:'registration_id, phone, and email required' });
    }

    const token = await getAccessToken();
    if (!token) throw new Error('Access token not available');

    const timestamp = new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
    const shortcode = process.env.BUSINESS_SHORTCODE;      // e.g. 174379 for sandbox
    const passkey = process.env.LNM_PASSKEY;               // sandbox/passkey
    const password = Buffer.from(shortcode + passkey + timestamp).toString('base64');


    const payload = {
      "BusinessShortCode": shortcode,
      "Password": password,
      "Timestamp": timestamp,
      "TransactionType": "CustomerPayBillOnline",
      "Amount": amount,
      "PartyA": formatPhone(phone),
      "PartyB": shortcode,
      "PhoneNumber": formatPhone(phone),
      "CallBackURL": process.env.CALLBACK_URL, // must be publicly accessible
      "AccountReference": registration_id,
      "TransactionDesc": "TriCre8 Bootcamp payment"
    };


    const isProd = String(process.env.DARAJA_ENV).toLowerCase() === 'production';
    const darajaUrl = isProd
      ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
      : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };

    const resp = await axios.post(darajaUrl, payload, { headers, timeout: 15000 });


    const j = resp.data;

    // expected: j.CheckoutRequestID, j.ResponseCode=0 if ok (sandbox)
    if(j.errorCode) {
      // console.error('Daraja error in STK Push response:', j);
      return res.status(500).json(j);
    }
    const checkoutRequestID = j.CheckoutRequestID || j.checkoutRequestID || j.ResponseDescription || ('ck_' + Date.now());
    payments[checkoutRequestID] = { status: 'PENDING', registration_id, phone, referral_code, amount: payload.Amount, email };


    return res.json({ message:'STK Push initiated', CheckoutRequestID: checkoutRequestID, raw: j });
  } catch(err){
    // console.error('Error in /api/stkpush:', err.response ? err.response.data : err.message);
    return res.status(500).json({ message:'STK Push failed', error: err.response ? err.response.data : err.message });
  }
});

// Daraja callback endpoint — Daraja posts payment result here
app.post('/api/callback', async (req, res) => {
  // Daraja will send JSON; log it and update payments store
  const body = req.body;

  try {
    // The exact shape differs; for sandbox it's body.Body.stkCallback
    const callback = body.Body && body.Body.stkCallback ? body.Body.stkCallback : body;

    const checkoutRequestID = callback.CheckoutRequestID || (callback.checkoutRequestID);
    const resultCode = callback.ResultCode != null ? callback.ResultCode : (callback.resultCode || -1);


    if(checkoutRequestID && payments[checkoutRequestID]){
      if(resultCode === 0){

        // success: extract receipt, amount, phone
        const metadata = callback.CallbackMetadata && callback.CallbackMetadata.Item ? callback.CallbackMetadata.Item : [];

        const mpesaReceipt = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value || null;
        const amount = metadata.find(i => i.Name === 'Amount')?.Value || payments[checkoutRequestID].amount;
        const phone = metadata.find(i => i.Name === 'PhoneNumber')?.Value || payments[checkoutRequestID].phone;


        payments[checkoutRequestID].status = 'SUCCESS';
        payments[checkoutRequestID].receipt = mpesaReceipt;
        payments[checkoutRequestID].amount = amount;
        payments[checkoutRequestID].phone = phone;

        // Function to generate a random alphanumeric string
        function generateRandomAlphanumeric(length) {
          let result = '';
          const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          const charactersLength = characters.length;
          for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
          }
          return result;
        }

        // Generate a random referral code
        const generatedReferralCode = 'GD2025-' + generateRandomAlphanumeric(4);


        // Send transaction details to Make webhook
        if (process.env.MAKE_WEBHOOK_URL) {

          const transactionDetails = {
            email: payments[checkoutRequestID].email,
            registration_id: payments[checkoutRequestID].registration_id,
            phone_number: payments[checkoutRequestID].phone,
            amount_paid: payments[checkoutRequestID].amount,
            mpesa_code: mpesaReceipt,
            transaction_timestamp: new Date().toISOString(),
            referral_code: generatedReferralCode
          };

          try {
            await axios.post(process.env.MAKE_WEBHOOK_URL, transactionDetails);

          } catch (webhookError) {
            // console.error('Error sending transaction details to Make webhook:', webhookError);
          }
        }

        // TODO: persist to DB, send confirmation email, add to Supabase, add to WhatsApp group etc.
      } else {

        payments[checkoutRequestID].status = 'FAILED';
        payments[checkoutRequestID].raw = callback;
      }
    }
    else {
      // unknown checkoutRequestID - optionally log
      // console.warn('Unknown CheckoutRequestID in callback', checkoutRequestID);
    }
  } catch(e){
    // console.error('Error processing callback:', e);
  }
  // respond quickly
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// status polling endpoint
app.get('/api/status', (req,res) => {

  const id = req.query.checkoutRequestID;
  if(!id) {
    // console.error('Validation error: checkoutRequestID missing in status request.');
    return res.status(400).json({ message:'checkoutRequestID required' });
  }
  const entry = payments[id];

  if(!entry) {
    // console.error('Status request - Entry not found for CheckoutRequestID:', id);
    return res.status(404).json({ message:'not found' });
  }
  return res.json({ status: entry.status, receipt: entry.receipt || null, raw: entry.raw || null });
});

function formatPhone(phone){

  let p = String(phone).trim();
  // Remove any leading '+'
  if (p.startsWith('+')) {
    p = p.slice(1);
  }
  // If it starts with '0', replace with '254'
  if (p.startsWith('0')) {
    p = '254' + p.slice(1);
  }
  // If it's 9 digits long (e.g., 7xxxxxxxxx), prepend '254'
  // This covers cases like 712345678 -> 254712345678
  if (p.length === 9 && !p.startsWith('254')) {
    p = '254' + p;
  }

  return p;
}

// Global error handler - MUST be after all routes
app.use((err, req, res, next) => {
    // console.error('Global error handler caught an error:', err.stack);
    res.status(500).send('Something broke!');
});