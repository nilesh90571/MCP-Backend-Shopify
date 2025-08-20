# MCP Backend for Shopify (Search + Cart + Checkout)

This is a minimal Express backend that your frontend widget can call:
- `POST /search` → find products by text & optional max price
- `POST /add-to-cart` → add a variant to a cart (per session)
- `POST /create-checkout` → return the checkout URL for the cart

## 1) Configure
Copy `.env.example` to `.env` and fill:
```
SHOPIFY_STORE_DOMAIN=your-shop-name.myshopify.com
SHOPIFY_STOREFRONT_TOKEN=your_storefront_access_token
SHOPIFY_API_VERSION=2024-07
ALLOWED_ORIGINS=*
PORT=3000
```

Get a **Storefront access token** from:
Shopify Admin → Settings → Apps and sales channels → Develop apps → Create app → Configure Storefront API access → Enable & Install → **Storefront access token**.

## 2) Run locally
```
npm install
npm run dev
```
The server will start at http://localhost:3000

## 3) Deploy
You can deploy to Vercel/Render/Railway/your server. After deploy, set environment variables there.

## 4) Frontend integration (add a stable session id)
To allow the backend to keep your cart between requests, send a stable session id header.

Add these lines near the top of your widget:
```html
<script>
  // create once and persist
  const MCP_SID = localStorage.getItem('mcp_sid') || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  localStorage.setItem('mcp_sid', MCP_SID);
</script>
```

Then add the header to your fetch calls:
```js
const commonHeaders = { 'Content-Type': 'application/json', 'X-Session-Id': MCP_SID };

// example:
fetch(`${MCP_BACKEND_URL}/search`, { method: 'POST', headers: commonHeaders, body: JSON.stringify({...}) });
```

Your widget's functions would look like:
```js
async function callSearch(query, maxPrice){
  const res = await fetch(`${MCP_BACKEND_URL}/search`,{
    method:'POST', headers: { 'Content-Type':'application/json', 'X-Session-Id': MCP_SID },
    body: JSON.stringify({ query, maxPrice })
  });
  return res.json();
}

async function callAddToCart(variantId, quantity=1){
  const res = await fetch(`${MCP_BACKEND_URL}/add-to-cart`,{
    method:'POST', headers: { 'Content-Type':'application/json', 'X-Session-Id': MCP_SID },
    body: JSON.stringify({ variantId, quantity })
  });
  return res.json();
}

async function callCreateCheckout(){
  const res = await fetch(`${MCP_BACKEND_URL}/create-checkout`,{
    method:'POST', headers: { 'Content-Type':'application/json', 'X-Session-Id': MCP_SID }
  });
  return res.json();
}
```

> If you absolutely cannot modify the frontend, you should host the backend under the same origin (e.g., via Shopify App Proxy), and use cookies for session. In that case, set cookies with the shop domain and ensure CORS credentials are handled.

## 5) Notes
- This demo stores sessions **in memory**. For production, use Redis/DB so carts persist across deploys.
- `search` uses the Storefront `products` query (`query:` supports `title`, `tag`, and a `price:<max>` filter fragment).
- Cart API is used (`cartCreate`, `cartLinesAdd`), and we return `checkoutUrl`.
- Make sure your storefront token has **read products, read cart** scopes enabled.

## 6) Test quickly (curl)
```
curl -X POST http://localhost:3000/search -H 'Content-Type: application/json' -H 'X-Session-Id: test' -d '{"query":"red t-shirt","maxPrice":999}'

curl -X POST http://localhost:3000/add-to-cart -H 'Content-Type: application/json' -H 'X-Session-Id: test' -d '{"variantId":"gid://shopify/ProductVariant/1234567890","quantity":1}'

curl -X POST http://localhost:3000/create-checkout -H 'Content-Type: application/json' -H 'X-Session-Id: test'
```
