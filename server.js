const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const SHOP = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_API_KEY;
const CLIENT_SECRET = process.env.SHOPIFY_API_SECRET;
const ADMIN_API_VERSION = '2025-10';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const DYNAMIC_TIRE_VARIANT_ID = 50783317524727;
const DYNAMIC_TIRE_PRODUCT_ID = 9977013076215;

const TEST_MODE = true;

const TEST_TIRE_VARIANTS = {
  A: {
    25: 50816801439991,
    30: 50818773582071,
    35: 50816801472759,
    40: 50818774892791,
    45: 50816801505527,
    50: 50818775187703,
    55: 50818775941367,
    60: 50819988193527
  },
  B: {
    25: 50818757296375,
    30: 50818773057783,
    35: 50818763587831,
    40: 50818775023863,
    45: 50818765226231,
    50: 50818775286007,
    55: 50818776170743,
    60: 50818766078199
  }
};

function estimateTireWeightFromSize(size) {
  const s = String(size || '').toUpperCase();

  if (s.includes('35X') || s.includes('35/')) return 60;
  if (s.includes('33X') || s.includes('33/')) return 55;

  if (s.includes('LT')) return 50;

  const rimMatch = s.match(/R(\d{2})/);
  const rim = rimMatch ? parseInt(rimMatch[1], 10) : 0;

  if (rim >= 22) return 55;
  if (rim >= 20) return 45;
  if (rim >= 18) return 35;
  if (rim >= 17) return 30;

  return 25;
}

function pickTireVariantBySize(size, slot = 'A') {
  const estimatedWeight = estimateTireWeightFromSize(size);
  const variants = TEST_TIRE_VARIANTS[slot] || TEST_TIRE_VARIANTS.A;

  if (estimatedWeight <= 25) return variants[25];
  if (estimatedWeight <= 30) return variants[30];
  if (estimatedWeight <= 35) return variants[35];
  if (estimatedWeight <= 40) return variants[40];
  if (estimatedWeight <= 45) return variants[45];
  if (estimatedWeight <= 50) return variants[50];
  if (estimatedWeight <= 55) return variants[55];

  return variants[60];
}
async function supabaseQuery(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase error: ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

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
    throw new Error('No se pudo obtener access token de Shopify');
  }

  return data.access_token;
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

// ── Health & root ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.status(200).send('OK - backend is running');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ── Snap Finance Webhook ──────────────────────────────────────────────────────
app.post('/snap/webhook', async (req, res) => {
  try {
    console.log('Snap webhook received:', req.body);

    return res.status(200).json({
      ok: true,
      received: true
    });

  } catch (error) {
    console.error('snap webhook error:', error);

    return res.status(500).json({
      error: 'Snap webhook error',
      details: String(error.message || error)
    });
  }
});

// ── Update tire price + return variant ID ──────────────────────────────────────
app.post('/create-tire-variant', async (req, res) => {
  try {
    const { title, part, size, qty, price, brand, image, position } = req.body || {};

    if (!title || !price) {
      return res.status(400).json({ error: 'Missing title or price' });
    }

    const cleanPrice = String(price || '').replace(/[^0-9.]/g, '');

    if (!cleanPrice) {
      return res.status(400).json({ error: 'Invalid price' });
    }
const slot = String(position || '').toLowerCase() === 'rear' ? 'B' : 'A';

const selectedVariantId = TEST_MODE
  ? pickTireVariantBySize(size, slot)
  : DYNAMIC_TIRE_VARIANT_ID;
    await shopifyRest(`/variants/${selectedVariantId}.json`, {
      method: 'PUT',
      body: JSON.stringify({
        variant: {
          id: selectedVariantId,
          price: cleanPrice
        }
      })
    });

    console.log(`Tire price updated: ${brand} ${title} ${size} $${cleanPrice}`);

    return res.json({
      ok: true,
      variant_id: selectedVariantId,
      product_id: DYNAMIC_TIRE_PRODUCT_ID,
      reused: true,
      meta: {
        title: String(title || '').trim(),
        part: String(part || '').trim(),
        size: String(size || '').trim(),
        qty: parseInt(qty, 10) || 1,
        price: cleanPrice,
        brand: String(brand || 'Tire').trim(),
        image: String(image || '').trim()
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

// ── Save tire for Google feed ──────────────────────────────────────────────────
app.post('/save-tire-for-feed', async (req, res) => {
  try {
    const tire = req.body || {};

    if (!tire.title || !tire.unit_price) {
      return res.status(400).json({ error: 'Missing title or price' });
    }

    const rawTitle = String(tire.title || '').toUpperCase();

    if (
      rawTitle.includes('REVISE SEARCH') ||
      rawTitle.includes('POWERED BY') ||
      rawTitle === 'TIRE' ||
      rawTitle.length < 3
    ) {
      return res.status(200).json({ ok: true, skipped: true });
    }

    const size = String(tire.size || '').trim();
    const brand = String(tire.brand || 'Tire').trim();
    const title = String(tire.title || '').trim();
    const price = parseFloat(tire.unit_price || 0).toFixed(2);
    const image = String(tire.image || '').trim();
    const part = String(tire.part || '').trim();

    const tireId = part || `${brand}-${size}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const link = `https://roadrunnertiresfl.com/#!tires/results?bp=tire&location_id=62761&search_by=size&type=passenger&season=all&page=1&order_by=best_match&display=full`;

    const record = {
      tire_id: tireId,
      title: `${brand} ${title} ${size}`.trim(),
      description: `${size} tire available at Road Runner Tires & Wheels in Kissimmee, Florida.`,
      link: link,
      image_link: image || 'https://cdn.shopify.com/s/files/1/0929/1700/6583/files/pirelli_pzero_all_season_plus_3_c202a64117f7f4bcfb8b4936bdba306f.png?v=1778705105',
      price: `${price} USD`,
      brand: brand,
      size: size,
      updated_at: new Date().toISOString()
    };

    await supabaseQuery('/tire_feed', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(record)
    });

    return res.json({ ok: true });

  } catch (error) {
    console.error('save-tire-for-feed error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: String(error.message || error)
    });
  }
});

// ── Google Merchant Center feed ────────────────────────────────────────────────
app.get('/google-products.xml', async (req, res) => {
  try {
    const TIRE_IMAGE = 'https://cdn.shopify.com/s/files/1/0929/1700/6583/files/pirelli_pzero_all_season_plus_3_c202a64117f7f4bcfb8b4936bdba306f.png?v=1778705105';
    const TIRE_CATEGORY = 'Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > Motor Vehicle Tires';

    const baseTires = [
      { id: 'RR-TIRE-205-55-R16', title: 'All-Season Tire 205/55R16', size: '205/55R16', vehicle: 'Toyota Corolla', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=205&amp;height%3E=55&amp;rim%3E=16&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' },
      { id: 'RR-TIRE-215-55-R17', title: 'All-Season Tire 215/55R17', size: '215/55R17', vehicle: 'Toyota Camry', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=215&amp;height%3E=55&amp;rim%3E=17&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' },
      { id: 'RR-TIRE-225-65-R17', title: 'All-Season Tire 225/65R17', size: '225/65R17', vehicle: 'Toyota RAV4, Honda CR-V', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=225&amp;height%3E=65&amp;rim%3E=17&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' },
      { id: 'RR-TIRE-265-60-R18', title: 'All-Season Tire 265/60R18', size: '265/60R18', vehicle: 'Ford F-150', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=265&amp;height%3E=60&amp;rim%3E=18&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' },
      { id: 'RR-TIRE-275-65-R18', title: 'All-Season Tire 275/65R18', size: '275/65R18', vehicle: 'Ford F-150', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=275&amp;height%3E=65&amp;rim%3E=18&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' },
      { id: 'RR-TIRE-265-65-R18', title: 'All-Season Tire 265/65R18', size: '265/65R18', vehicle: 'Chevrolet Silverado', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=265&amp;height%3E=65&amp;rim%3E=18&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' },
      { id: 'RR-TIRE-275-60-R20', title: 'All-Season Tire 275/60R20', size: '275/60R20', vehicle: 'RAM 1500', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=275&amp;height%3E=60&amp;rim%3E=20&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' },
      { id: 'RR-TIRE-265-70-R16', title: 'All-Season Tire 265/70R16', size: '265/70R16', vehicle: 'Toyota Tacoma', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=265&amp;height%3E=70&amp;rim%3E=16&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' },
      { id: 'RR-TIRE-265-65-R17', title: 'All-Season Tire 265/65R17', size: '265/65R17', vehicle: 'Toyota Tacoma, Kia Sorento', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=265&amp;height%3E=65&amp;rim%3E=17&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' },
      { id: 'RR-TIRE-235-65-R17', title: 'All-Season Tire 235/65R17', size: '235/65R17', vehicle: 'Kia Sorento', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=235&amp;height%3E=65&amp;rim%3E=17&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' },
      { id: 'RR-TIRE-245-60-R20', title: 'All-Season Tire 245/60R20', size: '245/60R20', vehicle: 'Toyota Highlander', link: 'https://roadrunnertiresfl.com/#!tires/results?bp=tire&amp;location_id=62761&amp;search_by=size&amp;type=passenger&amp;width%3E=245&amp;height%3E=60&amp;rim%3E=20&amp;season=all&amp;page=1&amp;order_by=best_match&amp;display=full' }
    ];

    let dynamicTires = [];

    try {
      dynamicTires = await supabaseQuery('/tire_feed?select=*&order=updated_at.desc&limit=500', {
        method: 'GET',
        headers: { 'Prefer': 'return=representation' }
      }) || [];
    } catch (e) {
      console.error('Supabase fetch error:', e);
    }

    const baseIds = new Set(baseTires.map(t => t.id));

    const allTires = [
      ...baseTires.map(t => ({
        id: t.id,
        title: `${t.title} - Road Runner Tires Kissimmee FL`,
        description: `${t.size} tire available at Road Runner Tires & Wheels in Kissimmee, Florida. ${t.vehicle} and similar vehicles.`,
        link: t.link,
        image_link: TIRE_IMAGE,
        price: '72.18 USD'
      })),
      ...dynamicTires
        .filter(t => !baseIds.has(t.tire_id))
        .map(t => ({
          id: t.tire_id,
          title: `${t.title} - Road Runner Tires Kissimmee FL`,
          description: t.description,
          link: t.link,
          image_link: t.image_link || TIRE_IMAGE,
          price: t.price
        }))
    ];

    const itemsXml = allTires.map(p => `
      <item>
        <g:id>${p.id}</g:id>
        <title><![CDATA[${p.title}]]></title>
        <description><![CDATA[${p.description}]]></description>
        <link>${String(p.link || '').replace(/&(?!amp;)/g, '&amp;')}</link>
        <g:image_link>${p.image_link}</g:image_link>
        <g:availability>in_stock</g:availability>
        <g:price>${p.price}</g:price>
        <g:brand><![CDATA[Road Runner Tires]]></g:brand>
        <g:mpn>${p.id}</g:mpn>
        <g:condition>new</g:condition>
        <g:google_product_category><![CDATA[${TIRE_CATEGORY}]]></g:google_product_category>
      </item>
    `).join('');

    const xmlFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Road Runner Tires Product Feed</title>
    <link>https://roadrunnertiresfl.com</link>
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
