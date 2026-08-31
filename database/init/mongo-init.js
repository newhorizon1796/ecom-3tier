// Executed automatically by the official mongo image on first container start
// (mounted into /docker-entrypoint-initdb.d/). Seeds a starter product catalog.
db = db.getSiblingDB('ecom');

db.products.insertMany([
  { name: 'Wireless Headphones', description: 'Over-ear, noise cancelling', price: 79.99, stock: 50 },
  { name: 'Mechanical Keyboard', description: '75% layout, hot-swappable switches', price: 109.5, stock: 30 },
  { name: 'USB-C Hub', description: '7-in-1, HDMI + PD passthrough', price: 34.0, stock: 100 },
  { name: 'Standing Desk Mat', description: 'Anti-fatigue, 30x20 in', price: 45.25, stock: 20 },
]);
