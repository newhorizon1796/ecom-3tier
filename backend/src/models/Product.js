const { Schema, model } = require('mongoose');

const productSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  price: { type: Number, required: true, min: 0 },
  stock: { type: Number, default: 100 },
}, { timestamps: true });

module.exports = model('Product', productSchema);
