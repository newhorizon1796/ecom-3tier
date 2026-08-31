const express = require('express');
const Product = require('../models/Product');
const Order = require('../models/Order');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const { items } = req.body; // array of product IDs
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items must be a non-empty array of product IDs' });
    }
    const products = await Product.find({ _id: { $in: items } });
    if (products.length !== items.length) {
      return res.status(400).json({ error: 'one or more products not found' });
    }
    const total = products.reduce((sum, p) => sum + p.price, 0);
    const order = await Order.create({ items, total });
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id).populate('items');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
