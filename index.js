const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const path = require('path');
const multer = require('multer'); 
const fs = require('fs'); 
const sharp = require('sharp'); 
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// --- 1. MASTER MODELS ---
const User = require('./models/User');
const Product = require('./models/Product');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');
const Withdrawal = require('./models/Withdrawal');

// Inline Config Model (System Settings)
const configSchema = new mongoose.Schema({
    key: { type: String, default: 'main_config' },
    quarantineEnabled: { type: Boolean, default: true },
    quarantineDuration: { type: Number, default: 180 }, 
});
const SystemConfig = mongoose.models.SystemConfig || mongoose.model('SystemConfig', configSchema);

// Inline Review Model
const Review = mongoose.models.Review || mongoose.model('Review', new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    createdAt: { type: Date, default: Date.now }
}));

// --- 2. CONFIGURATION & LIMITS ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7 // 50 MB limit for assets
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ SYSTEM: Master Database Connected & Synced"))
    .catch(err => console.error("❌ DB ERROR:", err));

// Storage Engine Setup
const uploadDir = '/app/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir), 
  filename: (req, file, cb) => {
    const cleanName = file.originalname.replace(/\s+/g, '-');
    cb(null, `pod-${Date.now()}-${cleanName}`);
  }
});
const upload = multer({ storage });

const getAppConfig = async () => {
    let config = await SystemConfig.findOne({ key: 'main_config' });
    if (!config) { config = new SystemConfig(); await config.save(); }
    return config;
};

// --- 3. UNIVERSAL HELPER: ERROR GUARD ---
const safeQuery = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } 
    catch (e) { 
        console.error("❌ Neural Node Error:", e.message); 
        res.status(500).json({ error: "System Error", details: e.message }); 
    }
};

// --- 4. CORE APIs ---
app.get('/', (req, res) => res.status(200).send('🚀 POD Master Node v5.0 | All Systems Operational ✅'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// --- 5. SMART SEARCH & RANKING ALGORITHM 🔍 ---

app.get(['/api/products/search', '/api/product/search'], safeQuery(async (req, res) => {
    const { q, category } = req.query;
    let query = { status: 'approved' }; 
    
    if (q) query.$or = [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }];
    if (category && category !== 'All') query.category = category;

    const products = await Product.find(query).populate('supplier', 'name storeName').lean();
    
    // Etsy-Style Scoring: Views (24h) + Sales + Handmade Boost
    const scoredResults = products.map(p => {
        const recentViews = (p.views24h || []).filter(v => new Date(v) > (Date.now() - 86400000)).length;
        const score = (recentViews * 2) + ((p.salesCount || 0) * 10) + (p.source === 'handmade' ? 100 : 0);
        return { ...p, score, recentViews };
    }).sort((a, b) => b.score - a.score);

    res.json(scoredResults);
}));

app.get('/api/products/suggestions', safeQuery(async (req, res) => {
    const data = await Product.find({ name: { $regex: req.query.q, $options: 'i' }, status: 'approved' })
        .limit(6).select('name category');
    res.json(data);
}));

app.post('/api/products/track-visit', safeQuery(async (req, res) => {
    const { productId } = req.body;
    const yesterday = new Date(Date.now() - 86400000);
    await Product.findByIdAndUpdate(productId, {
        $push: { views24h: new Date() },
        $pull: { views24h: { $lt: yesterday } },
        $inc: { clickCount: 1 }
    });
    res.json({ success: true });
}));

// --- 6. FINTECH (Wallet, Treasury & Withdrawals) ---

app.get('/api/wallet/:userId', safeQuery(async (req, res) => {
    const user = await User.findById(req.params.userId);
    res.json({ balance: user ? user.walletBalance : 0 });
}));

app.post('/api/wallet/pay', safeQuery(async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Low Balance" });
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    res.json({ message: "Payment Successful" });
}));

app.post('/api/wallet/withdraw', safeQuery(async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Insufficient Funds" });
    
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } }); // Immediate Deduct (Escrow)
    await new Withdrawal({ user: userId, amount, status: 'pending' }).save();
    res.json({ message: "Withdrawal Request Submitted" });
}));

app.get('/api/admin/withdrawals', safeQuery(async (req, res) => {
    const data = await Withdrawal.find().populate('user', 'name email role walletBalance').sort({ createdAt: -1 });
    res.json(data);
}));

app.post('/api/admin/withdrawals/action', safeQuery(async (req, res) => {
    const { id, action } = req.body; // action: 'approved' or 'rejected'
    const request = await Withdrawal.findById(id);
    if (!request || request.status !== 'pending') return res.status(400).send("Invalid Request");

    if (action === 'rejected') {
        await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } }); // Refund
    }
    request.status = action;
    await request.save();
    res.json({ message: `Request ${action} successfully` });
}));

// --- 7. ORDER & LOGISTICS ---

app.post('/api/orders/create', safeQuery(async (req, res) => {
    const newOrder = new Order(req.body);
    await newOrder.save();
    await Product.findByIdAndUpdate(req.body.productId, { $inc: { salesCount: 1 } });
    res.json({ message: "Order Placed", orderId: newOrder._id });
}));

app.get(['/api/orders/supplier/:id', '/api/order/supplier/:id'], safeQuery(async (req, res) => {
    const data = await Order.find({ supplierId: req.params.id }).populate('sellerId', 'name email').populate('productId', 'name imagePaths').sort({ createdAt: -1 });
    res.json(data);
}));

app.get(['/api/orders/seller/:id', '/api/order/seller/:id'], safeQuery(async (req, res) => {
    const data = await Order.find({ sellerId: req.params.id }).populate('productId', 'name imagePaths').sort({ createdAt: -1 });
    res.json(data);
}));

app.patch('/api/orders/status', safeQuery(async (req, res) => {
    await Order.findByIdAndUpdate(req.body.orderId, { status: req.body.status });
    res.json({ message: "Status Updated" });
}));

// --- 8. STATS & ANALYTICS ---

app.get(['/api/admin/detailed-stats', '/api/admin/stats'], safeQuery(async (req, res) => {
    const suppliers = await User.countDocuments({ role: 'supplier' });
    const sellers = await User.countDocuments({ role: 'seller' });
    const revenue = await Order.aggregate([{ $group: { _id: null, total: { $sum: "$totalPrice" } } }]);
    const supplierPerformance = await Order.aggregate([
        { $group: { _id: "$supplierId", totalOrders: { $sum: 1 }, revenue: { $sum: "$totalPrice" } } },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "details" } },
        { $unwind: "$details" }
    ]);
    res.json({ userStats: { sellers, suppliers }, totalRevenue: revenue[0]?.total || 0, supplierPerformance });
}));

app.get('/api/supplier/stats/:id', safeQuery(async (req, res) => {
    const user = await User.findById(req.params.id);
    const products = await Product.countDocuments({ supplier: req.params.id });
    const orders = await Order.find({ supplierId: req.params.id });
    const withdrawn = await Withdrawal.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(req.params.id), status: 'approved' } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    res.json({ 
        products, 
        balance: user?.walletBalance || 0, 
        withdrawn: withdrawn[0]?.total || 0, 
        pendingOrders: orders.filter(o => o.status === 'pending').length 
    });
}));

// --- 9. CHAT ENGINE & SOCKETS ---

app.get('/api/chat/conversations/:userId', safeQuery(async (req, res) => {
    const data = await Chat.find({ participants: req.params.userId }).populate('participants', 'name email role profileImage').sort({ lastMessageTime: -1 });
    res.json(data);
}));

app.get('/api/chat/messages/:chatId', safeQuery(async (req, res) => {
    const data = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
    res.json(data);
}));

app.get('/api/chat/unread/:userId', safeQuery(async (req, res) => {
    const chats = await Chat.find({ participants: req.params.userId });
    const unread = await Message.find({ chatId: { $in: chats.map(c=>c._id) }, sender: { $ne: req.params.userId }, status: { $ne: 'seen' } });
    const unreadMap = {};
    unread.forEach(msg => { unreadMap[msg.chatId] = (unreadMap[msg.chatId] || 0) + 1; });
    res.json({ total: unread.length, perChat: unreadMap });
}));

io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));
  
  socket.on('send_message', async (data) => {
    // Security Block: Contact Info Sharing
    if (data.text && (PHONE_REGEX.test(data.text) || EMAIL_REGEX.test(data.text))) {
        return io.to(data.senderId).emit('error_message', "⚠️ Security: Sharing contact details is restricted.");
    }
    
    let chat = await Chat.findOne({ participants: { $all: [data.senderId, data.receiverId] } });
    if (!chat) { chat = new Chat({ participants: [data.senderId, data.receiverId] }); await chat.save(); }
    
    chat.lastMessage = data.text || '📷 Attachment'; 
    chat.lastMessageTime = Date.now(); 
    await chat.save();
    
    const newMessage = new Message({ ...data, chatId: chat._id, status: 'delivered' }); 
    await newMessage.save();
    
    io.to(data.receiverId).emit('receive_message', newMessage);
    io.to(data.receiverId).emit('notification', { from: data.senderId, chatId: chat._id });
  });

  socket.on('mark_read', async (data) => {
    await Message.updateMany({ chatId: data.chatId, sender: { $ne: data.userId }, status: { $ne: 'seen' } }, { $set: { status: 'seen' } });
  });
});

// --- 10. PRODUCT ENGINE (Neural Scan + Management) ---

app.post('/api/product/add', upload.fields([{ name: 'images', maxCount: 12 }, { name: 'video', maxCount: 1 }]), safeQuery(async (req, res) => {
    if (!req.files || !req.files['images']) return res.status(400).send("Images required.");

    // Neural Scan: Copyright Check (Using Image Hashing)
    const primaryImg = req.files['images'][0];
    const buffer = await sharp(primaryImg.path).resize(10, 10).grayscale().toBuffer();
    const currentHash = buffer.toString('base64');

    if (await Product.findOne({ imageHash: currentHash })) {
        return res.status(403).json({ error: "Copyright Detected", message: "This design already exists." });
    }

    const config = await getAppConfig();
    const newProduct = new Product({
        ...req.body,
        supplier: req.body.supplierId,
        imagePaths: req.files['images'].map(f => f.filename),
        imageHash: currentHash,
        status: config.quarantineEnabled ? 'pending' : 'approved',
        tags: req.body.tags ? req.body.tags.split(',') : []
    });
    await newProduct.save();
    res.json({ message: "Neural Scan Passed. Product Live." });
}));

// --- 11. AUTOMATION & ADMIN CONFIG ---

app.get('/api/admin/config', async (req, res) => res.json(await getAppConfig()));
app.post('/api/admin/config', safeQuery(async (req, res) => {
    await SystemConfig.findOneAndUpdate({ key: 'main_config' }, req.body, { upsert: true });
    res.json({ message: "Configuration Updated" });
}));

// Quarantine Auto-Approval (Every 10 Minutes)
setInterval(async () => {
    const config = await getAppConfig();
    if (!config.quarantineEnabled) return;
    const cutoff = new Date(Date.now() - config.quarantineDuration * 60 * 1000);
    await Product.updateMany({ status: 'pending', createdAt: { $lte: cutoff } }, { $set: { status: 'approved' } });
}, 600000);

const PORT = process.env.PORT || 80;
server.listen(PORT, () => console.log(`🚀 MASTER NODE v5.0 operational on Port ${PORT}`));