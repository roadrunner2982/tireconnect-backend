const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
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
function safeHandle(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getShopifyAccessToken();

  const response = await fetch(`https://${SHOP}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Shopify GraphQL HTTP error:', data);
    throw new Error('Shopify GraphQL HTTP error');
  }

  if (data.errors) {
    console.error('Shopify GraphQL errors:', data.errors);
    throw new Error(JSON.stringify(data.errors));
  }

  return data.data;
}

app.post('/create-tire-variant', async (req, res) => {
  try {
    const {
      title,
      part,
      size,
      qty,
      price,
      brand
    } = req.body || {};

    if (!title || !part || !price) {
      return res.status(400).json({
        error: 'Missing required fields: title, part, price'
      });
    }

    const cleanTitle = String(title).trim();
    const cleanPart = String(part).trim();
    const cleanSize = String(size || '').trim();
    const cleanBrand = String(brand || 'Road Runner Tires & Wheels').trim();
    const cleanPrice = String(price).replace(/[^0-9.]/g, '');
    const cleanQty = parseInt(qty, 10) || 1;

    const productTitle = `${cleanBrand} ${cleanTitle}`.trim();
    const productHandle = safeHandle(`tc-${cleanPart}`);

    const findProductQuery = `
      query FindProductByHandle($handle: String!) {
        productByHandle(handle: $handle) {
          id
          title
          handle
          variants(first: 10) {
            edges {
              node {
                id
                title
                sku
                price
              }
            }
          }
        }
      }
    `;

    const found = await shopifyGraphQL(findProductQuery, { handle: productHandle });
    const existingProduct = found.productByHandle;

    if (existingProduct && existingProduct.variants.edges.length > 0) {
      const existingVariant = existingProduct.variants.edges[0].node;

      return res.json({
        ok: true,
        variant_id: existingVariant.id,
        product_id: existingProduct.id,
        reused: true,
        meta: {
          title: cleanTitle,
          part: cleanPart,
          size: cleanSize,
          qty: cleanQty,
          price: cleanPrice
        }
      });
    }

    const createProductMutation = `
      mutation CreateProduct($input: ProductInput!) {
        productCreate(input: $input) {
          product {
            id
            title
            handle
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  sku
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const createInput = {
      title: productTitle,
      handle: productHandle,
      vendor: 'Road Runner Tires & Wheels',
      productType: 'Tires',
      status: 'ACTIVE',
      tags: ['tireconnect', 'dynamic-tire'],
      variants: [
        {
          price: cleanPrice,
          sku: cleanPart,
          inventoryPolicy: 'CONTINUE'
        }
      ]
    };

    const created = await shopifyGraphQL(createProductMutation, { input: createInput });
    const createResult = created.productCreate;

    if (createResult.userErrors && createResult.userErrors.length > 0) {
      console.error('productCreate userErrors:', createResult.userErrors);
      return res.status(400).json({
        error: 'productCreate failed',
        details: createResult.userErrors
      });
    }

    const product = createResult.product;
    const variant = product?.variants?.edges?.[0]?.node;

    if (!product || !variant) {
      return res.status(500).json({
        error: 'Product created but no variant returned'
      });
    }

    return res.json({
      ok: true,
      variant_id: variant.id,
      product_id: product.id,
      reused: false,
      meta: {
        title: cleanTitle,
        part: cleanPart,
        size: cleanSize,
        qty: cleanQty,
        price: cleanPrice
      }
    });
  } catch (error) {
    console.error('create-tire-variant error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: String(error.message || error)
    });
  }
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
