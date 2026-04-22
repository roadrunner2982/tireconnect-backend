const express = require('express');
const app = express();

app.use(express.json());

const SHOP = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_API_KEY;
const CLIENT_SECRET = process.env.SHOPIFY_API_SECRET;

async function getShopifyAccessToken() {
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);

  const response = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: params.toString()
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.error('Token error:', data);
    throw new Error('No se pudo obtener access token de Shopify');
  }

  return data.access_token;
}

app.get('/', (req, res) => {
  res.status(200).send('OK - backend is running');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/create-cart', async (req, res) => {
  try {
    const {
      title,
      price,
      qty,
      sku,
      brand,
      size
    } = req.body;

    if (!title || !price) {
      return res.status(400).json({
        error: 'Missing title or price'
      });
    }

    const accessToken = await getShopifyAccessToken();

    const mutation = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            invoiceUrl
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        lineItems: [
          {
            title: title,
            originalUnitPrice: String(price),
            quantity: Number(qty || 1),
            customAttributes: [
              { key: "SKU", value: String(sku || "") },
              { key: "Brand", value: String(brand || "") },
              { key: "Size", value: String(size || "") },
              { key: "Source", value: "TireConnect" }
            ]
          }
        ]
      }
    };

    const response = await fetch(`https://${SHOP}/admin/api/2026-04/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({
        query: mutation,
        variables
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Shopify HTTP error:', data);
      return res.status(500).json({ error: 'Shopify HTTP error', details: data });
    }

    const userErrors = data?.data?.draftOrderCreate?.userErrors || [];
    if (userErrors.length > 0) {
      console.error('Shopify userErrors:', userErrors);
      return res.status(400).json({ error: 'Shopify userErrors', details: userErrors });
    }

    const draftOrder = data?.data?.draftOrderCreate?.draftOrder;
    if (!draftOrder?.invoiceUrl) {
      console.error('No invoiceUrl:', data);
      return res.status(500).json({ error: 'No se recibió invoiceUrl', details: data });
    }

    return res.json({
      ok: true,
      draftOrderId: draftOrder.id,
      draftOrderName: draftOrder.name,
      checkout_url: draftOrder.invoiceUrl
    });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
