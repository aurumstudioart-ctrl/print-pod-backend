const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Seller & Supplier
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, // Kis product ki baat ho rahi hai
  lastMessage: { type: String },
  lastMessageTime: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Chat', chatSchema);