const { Schema, model } = require('mongoose');

const orderSchema = new Schema({
  items: [{ type: Schema.Types.ObjectId, ref: 'Product', required: true }],
  total: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'confirmed'], default: 'confirmed' },
}, { timestamps: true });

module.exports = model('Order', orderSchema);
