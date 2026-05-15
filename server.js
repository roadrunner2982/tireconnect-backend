const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const SHOP = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_API_KEY;
const CLIENT_SECRET = process.env.SHOPIFY_API_SECRET;
const ADMIN_API_VERSION = '2025-10';

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

function safeHandle(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function shopifyRest(path, options = {}) {
  const accessToken = await getShopifyAccessToken();

  const response = await fetch(`https://${SHOP}/admin/api/${ADMIN_API_VERSION}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Shopify-Access-Token': accessToken,
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    data = { raw: text };
  }

  if (!response.ok) {
    console.error('Shopify REST error:', response.status, data);
    throw new Error(`Shopify REST error ${response.status}`);
  }

  return data;
}

async function hideProductFromStorefront(productId) {
  await shopifyRest(`/products/${productId}/metafields.json`, {
    method: 'POST',
    body: JSON.stringify({
      metafield: {
        namespace: 'seo',
        key: 'hidden',
        type: 'number_integer',
        value: '1'
      }
    })
  });
}

// ── Health & root ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.status(200).send('OK - backend is running');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ── Shopify: create tire variant ───────────────────────────────────────────────
app.post('/create-tire-variant', async (req, res) => {
  try {
    const { title, part, size, qty, price, brand, image } = req.body || {};

    if (!title || !price) {
      return res.status(400).json({ error: 'Missing title or price' });
    }

    const cleanTitle = String(title || '').trim();
    const cleanPart = String(part || `TC-${Date.now()}`).trim();
    const cleanSize = String(size || '').trim();
    const cleanBrand = String(brand || 'Tire').trim();
    const cleanPrice = String(price || '').replace(/[^0-9.]/g, '');
    const cleanQty = parseInt(qty, 10) || 1;
    const cleanImage = String(image || '').trim();

    if (!cleanPrice) {
      return res.status(400).json({ error: 'Invalid price' });
    }

    const productTitle = `${cleanBrand} ${cleanTitle}`.trim();
    const baseKey = cleanPart || `${cleanBrand}-${cleanTitle}`;
    const productHandle = safeHandle(`tc-${baseKey}`);

    const found = await shopifyRest(`/products.json?handle=${productHandle}`);
    const existingProduct = found?.products?.[0];

    if (existingProduct && existingProduct.variants?.length > 0) {
      const variant = existingProduct.variants[0];

      if (cleanImage && (!existingProduct.images || existingProduct.images.length === 0)) {
        await shopifyRest(`/products/${existingProduct.id}.json`, {
          method: 'PUT',
          body: JSON.stringify({
            product: {
              id: existingProduct.id,
              images: [{ src: cleanImage }]
            }
          })
        });
      }

      return res.json({
        ok: true,
        variant_id: variant.id,
        product_id: existingProduct.id,
        reused: true,
        meta: {
          title: cleanTitle,
          part: cleanPart,
          size: cleanSize,
          qty: cleanQty,
          price: cleanPrice,
          brand: cleanBrand,
          image: cleanImage
        }
      });
    }

    const created = await shopifyRest('/products.json', {
      method: 'POST',
      body: JSON.stringify({
        product: {
          title: productTitle,
          handle: productHandle,
          vendor: cleanBrand,
          product_type: 'TireConnect Dynamic',
          status: 'active',
          tags: 'hidden,tireconnect,dynamic-tire,tc-hidden,do-not-display',
          images: cleanImage ? [{ src: cleanImage }] : [],
          variants: [
            {
              option1: 'Default Title',
              price: cleanPrice,
              sku: cleanPart,
              inventory_policy: 'continue',
              requires_shipping: false,
              taxable: true
            }
          ]
        }
      })
    });

    const product = created?.product;
    const variant = product?.variants?.[0];

    if (product?.id) {
      await hideProductFromStorefront(product.id);
    }

    if (!variant?.id) {
      return res.status(500).json({
        error: 'Variant not created',
        details: created
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
        price: cleanPrice,
        brand: cleanBrand,
        image: cleanImage
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

// ── Google Merchant Center feed ────────────────────────────────────────────────
app.get('/google-products.xml', async (req, res) => {
  try {
    const products = [
      {
        id: 'TC-254018',
        title: 'Road Runner Tires 245/40R18 Tire',
        description: '245/40R18 tire available at Road Runner Tires & Wheels in Kissimmee, Florida.',
        link: 'https://YOURDOMAIN.com/pages/shop-tires-new',
        image_link: 'https://YOUR-IMAGE-URL.jpg',
        availability: 'in_stock',
        price: '125.00 USD',
        brand: 'Road Runner Tires',
        mpn: '254018',
        condition: 'new',
        google_product_category: 'Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > Motor Vehicle Tires'
      }
    ];

    const itemsXml = products.map(p => `
      <item>
        <g:id>${p.id}</g:id>
        <title><![CDATA[${p.title}]]></title>
        <description><![CDATA[${p.description}]]></description>
        <link>${p.link}</link>
        <g:image_link>${p.image_link}</g:image_link>
        <g:availability>${p.availability}</g:availability>
        <g:price>${p.price}</g:price>
        <g:brand><![CDATA[${p.brand}]]></g:brand>
        <g:mpn>${p.mpn}</g:mpn>
        <g:condition>${p.condition}</g:condition>
        <g:google_product_category><![CDATA[${p.google_product_category}]]></g:google_product_category>
      </item>
    `).join('');

    const xmlFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Road Runner Tires Product Feed</title>
    <link>https://YOURDOMAIN.com</link>
    <description>Road Runner Tires inventory feed for Google Merchant Center</description>
    ${itemsXml}
  </channel>
</rss>`;

    res.set('Content-Type', 'application/xml');
    res.status(200).send(xmlFeed);

  } catch (error) {
    console.error('google-products.xml error:', error);
    res.status(500).send('Feed error');
  }
});

// ── Start server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
