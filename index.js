import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();

// ✅ CORS: Allow only your Shopify domain
app.use(cors({
  origin: "https://ptinilesh.myshopify.com",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

const { SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN } = process.env;

// 🔎 Function to search products
async function searchProducts(query) {
  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/api/2024-07/graphql.json`;

  const graphqlQuery = {
    query: `
      query($query: String!) {
        products(first: 10, query: $query) {
          edges {
            node {
              id
              title
              handle
              description
              images(first: 1) {
                edges {
                  node {
                    url
                  }
                }
              }
              variants(first: 1) {
                edges {
                  node {
                    price {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    variables: { query }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN
    },
    body: JSON.stringify(graphqlQuery)
  });

  const result = await response.json();

  if (!result.data?.products) return [];
  return result.data.products.edges.map(edge => edge.node);
}

// 🤖 API route for chatbot product search
app.post("/chatbot/search", async (req, res) => {
  try {
    const { message } = req.body; // User message from chatbot
    const products = await searchProducts(message);

    if (products.length === 0) {
      return res.json({ reply: `No products found for "${message}".` });
    }

    // Format chatbot reply
    const reply = products.map(p => ({
      title: p.title,
      url: `https://${SHOPIFY_STORE_DOMAIN}/products/${p.handle}`,
      image: p.images.edges[0]?.node?.url,
      price: `${p.variants.edges[0].node.price.amount} ${p.variants.edges[0].node.price.currencyCode}`
    }));

    res.json({ reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ✅ For Vercel: Export app instead of app.listen
export default app;
