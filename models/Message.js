const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  text: { type: String },
  // Special Attachments (Jo aapne manga)
  attachment: {
    type: { type: String, enum: ['image', 'design_info', 'none'], default: 'none' },
    designImage: String, // Final Design
    productLink: String, // Blank Product
    usedAssets: [String] // Jo elements use huye
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Message', messageSchema);