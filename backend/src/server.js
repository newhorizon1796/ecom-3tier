require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { connectDB, mongoose } = require('./db');
const { register, metricsMiddleware } = require('./metrics');
const productsRouter = require('./routes/products');
const ordersRouter = require('./routes/orders');

const app = express();
app.use(cors());
app.use(express.json());
app.use(metricsMiddleware);

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', (req, res) => {
  res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
    status: mongoose.connection.readyState === 1 ? 'ready' : 'not-ready',
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ecom';

if (require.main === module) {
  connectDB(MONGO_URI)
    .then(() => {
      app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
    })
    .catch((err) => {
      console.error('Failed to connect to MongoDB', err);
      process.exit(1);
    });
}

module.exports = app;
