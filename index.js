import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS
const allowed = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  }
}));

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';

if (!SHOP || !TOKEN) {
  console.warn('⚠️  Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_STOREFRONT_TOKEN in env');
}

const SF_ENDPOINT = `https://${SHOP}/api/${API_VERSION}/graphql.json`;

const sessions = new Map();

function getSessionId(req) {
  const sid = req.headers['x-session-id']?.toString();
  if (sid) return sid;
  return `${req.ip}:${req.headers['user-agent'] || ''}`.slice(0, 128);
}

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
  if (!res.ok || json.errors) {
    throw new Error(JSON.stringify(json.errors || json));
  }
  return json.data;
}

const GQL = {
  SEARCH: `
    query Products($q: String!, $first: Int!) {
      products(first: $first, query: $q) {
        edges {
          node {
            id
            title
            featuredImage { url }
            images(first: 1) { edges { node { url } } }
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

app.post('/search', async (req, res) => {
  try {
    const { query, maxPrice } = req.body || {};
    const qParts = [];
    if (query) qParts.push(String(query));
    if (maxPrice) qParts.push(`price:<${Number(maxPrice)}`);
    const q = qParts.join(' ');

    const data = await shopifyFetch(GQL.SEARCH, { q, first: 10 });
    const items = (data.products.edges || []).map(({ node }) => {
      const imgEdge = node.images?.edges?.[0];
      const vEdges = node.variants?.edges || [];
      return {
        id: node.id,
        title: node.title,
        price: node.priceRange?.minVariantPrice?.amount,
        images: [{ url: (imgEdge?.node?.url || node.featuredImage?.url || '') }],
        variants: vEdges.map(e => ({
          id: e.node.id,
          title: e.node.title,
          price: e.node.price
        }))
      };
    });
    res.json({ result: { items } });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

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
    res.status(500).json({ error: true, message: e.message });
  }
});

app.post('/create-checkout', async (req, res) => {
  try {
    const sid = getSessionId(req);
    const session = await ensureCartForSession(sid);
    res.json({ result: { checkoutUrl: session.checkoutUrl, cartId: session.cartId } });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`MCP backend running on http://localhost:${port}`);
});
