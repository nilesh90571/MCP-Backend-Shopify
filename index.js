import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ====== CORS Setup ======
const allowed = (process.env.ALLOWED_ORIGINS || 'https://ptinilesh.myshopify.com')
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    // local requests (no origin)
    if (!origin) return cb(null, true);

    if (allowed.includes('*') || allowed.includes(origin)) {
      return cb(null, true);
    }
    console.warn(`❌ CORS blocked: ${origin}`);
    return cb(new Error('CORS blocked'));
  }
}));
app.options('*', (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://ptinilesh.myshopify.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(200);
})

// ====== Shopify Config ======
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';

if (!SHOP || !TOKEN) {
  console.warn('⚠️ Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_STOREFRONT_TOKEN in env');
}

const SF_ENDPOINT = `https://${SHOP}/api/${API_VERSION}/graphql.json`;

// ====== Session Handling ======
const sessions = new Map();
function getSessionId(req) {
  const sid = req.headers['x-session-id']?.toString();
  if (sid) return sid;
  return `${req.ip}:${req.headers['user-agent'] || ''}`.slice(0, 128);
}

// ====== Shopify Fetch Helper ======
async function shopifyFetch(query, variables = {}) {
  const res = await fetch(SF_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);
  }
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// ====== GraphQL Queries ======
const GQL = {
  SEARCH: `
    query Products($q: String!, $first: Int!) {
      products(first: $first, query: $q) {
        edges {
          node {
            id
            title
            handle
            description
            featuredImage { url }
            priceRange {
              minVariantPrice { amount currencyCode }
            }
            variants(first: 5) {
              edges {
                node {
                  id
                  title
                  price { amount currencyCode }
                }
              }
            }
          }
        }
      }
    }
  `,
  PRODUCT: `
    query ProductByHandle($handle: String!) {
      product(handle: $handle) {
        id
        title
        description
        featuredImage { url }
        images(first: 5) { edges { node { url } } }
        variants(first: 10) {
          edges {
            node {
              id
              title
              price { amount currencyCode }
            }
          }
        }
      }
    }
  `,
  CART_CREATE: `
    mutation CartCreate {
      cartCreate {
        cart { id checkoutUrl }
        userErrors { field message }
      }
    }
  `,
  CART_LINES_ADD: `
    mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) {
        cart { id checkoutUrl totalQuantity }
        userErrors { field message }
      }
    }
  `
};

// ====== Ensure Cart for Session ======
async function ensureCartForSession(sessionId) {
  let s = sessions.get(sessionId);
  if (s?.cartId) return s;

  const data = await shopifyFetch(GQL.CART_CREATE);
  const err = data.cartCreate?.userErrors?.[0];
  if (err) throw new Error(err.message || 'cartCreate error');
  const cart = data.cartCreate.cart;
  s = { cartId: cart.id, checkoutUrl: cart.checkoutUrl };
  sessions.set(sessionId, s);
  return s;
}

// ====== ROUTES ======

// 🔹 Product Search
app.post('/search', async (req, res) => {
  try {
    const { query, maxPrice } = req.body || {};
    const qParts = [];
    if (query) qParts.push(String(query));
    if (maxPrice) qParts.push(`price:<${Number(maxPrice)}`);
    const q = qParts.join(' ');

    const data = await shopifyFetch(GQL.SEARCH, { q, first: 10 });
    const items = (data.products.edges || []).map(({ node }) => {
      const vEdges = node.variants?.edges || [];
      return {
        id: node.id,
        title: node.title,
        handle: node.handle,
        description: node.description,
        price: node.priceRange?.minVariantPrice?.amount,
        images: [{ url: node.featuredImage?.url }],
        variants: vEdges.map(e => ({
          id: e.node.id,
          title: e.node.title,
          price: e.node.price
        }))
      };
    });
    res.json({ result: { items } });
  } catch (e) {
    console.error('❌ /search error:', e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// 🔹 Single Product by Handle
app.get('/product/:handle', async (req, res) => {
  try {
    const { handle } = req.params;
    const data = await shopifyFetch(GQL.PRODUCT, { handle });
    res.json({ result: data.product });
  } catch (e) {
    console.error('❌ /product error:', e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// 🔹 Add to Cart
app.post('/add-to-cart', async (req, res) => {
  try {
    const { variantId, quantity = 1 } = req.body || {};
    if (!variantId) return res.status(400).json({ error: true, message: 'variantId required' });

    const sid = getSessionId(req);
    const session = await ensureCartForSession(sid);

    const variables = {
      cartId: session.cartId,
      lines: [{ merchandiseId: variantId, quantity: Number(quantity) || 1 }]
    };
    const data = await shopifyFetch(GQL.CART_LINES_ADD, variables);
    const err = data.cartLinesAdd?.userErrors?.[0];
    if (err) throw new Error(err.message || 'cartLinesAdd error');

    const cart = data.cartLinesAdd.cart;
    sessions.set(sid, { cartId: cart.id, checkoutUrl: cart.checkoutUrl });

    res.json({ result: { cartId: cart.id, checkoutUrl: cart.checkoutUrl, totalQuantity: cart.totalQuantity } });
  } catch (e) {
    console.error('❌ /add-to-cart error:', e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// 🔹 Checkout Link
app.post('/create-checkout', async (req, res) => {
  try {
    const sid = getSessionId(req);
    const session = await ensureCartForSession(sid);
    res.json({ result: { checkoutUrl: session.checkoutUrl, cartId: session.cartId } });
  } catch (e) {
    console.error('❌ /create-checkout error:', e.message);
    res.status(500).json({ error: true, message: e.message });
  }
});

// ====== Start Server ======
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ MCP backend running on http://localhost:${port}`);
});
 // Updated