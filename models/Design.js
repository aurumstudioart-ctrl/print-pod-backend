const mongoose = require('mongoose');

const designSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  baseProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  finalImage: { type: String, required: true },
  sellingPrice: { type: Number, required: true },
  profitMargin: { type: Number },
  title: { type: String, required: true },
  tags: [String],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Design', designSchema);