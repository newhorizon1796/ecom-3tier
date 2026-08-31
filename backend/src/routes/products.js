const express = require('express');
const Product = require('../models/Product');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, description, price, stock } = req.body;
    if (!name || price == null) {
      return res.status(400).json({ error: 'name and price are required' });
    }
    const product = await Product.create({ name, description, price, stock });
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
