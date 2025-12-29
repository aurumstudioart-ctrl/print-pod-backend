const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  text: { type: String },
  attachment: {
    type: { type: String, enum: ['image', 'design_info', 'chat_image', 'none'], default: 'none' },
    designImage: String, 
    productLink: String,
    usedAssets: [String],
    orderDetails: String
  },
  // --- NEW FIELD FOR TICKS ---
  status: { 
    type: String, 
    enum: ['sent', 'delivered', 'seen'], 
    default: 'sent' 
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Message', messageSchema);