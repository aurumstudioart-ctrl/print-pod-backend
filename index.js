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

// --- 1. MASTER MODELS LOADING ---
const User = require('./models/User');
const Product = require('./models/Product');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');
const Withdrawal = require('./models/Withdrawal');

// Dynamic Config Model (Inline)
const configSchema = new mongoose.Schema({
    key: { type: String, default: 'main_config' },
    quarantineEnabled: { type: Boolean, default: true },
    quarantineDuration: { type: Number, default: 180 }, 
});
const SystemConfig = mongoose.models.SystemConfig || mongoose.model('SystemConfig', configSchema);

// Review Model (Inline)
const Review = mongoose.models.Review || mongoose.model('Review', new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    createdAt: { type: Date, default: Date.now }
}));

// --- 2. CONFIGURATION & ENGINE LIMITS ---
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7 // 50 MB
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// Database Connection with Auto-Healing
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ SYSTEM: Master Intelligence Database Connected"))
    .catch(err => console.error("❌ CRITICAL: Neural Link Failure (DB) ->", err));

// Storage Engine Setup
const uploadDir = '/app/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir), 
  filename: (req, file, cb) => cb(null, `file-${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
});
const upload = multer({ storage });

const getAppConfig = async () => {
    let config = await SystemConfig.findOne({ key: 'main_config' });
    if (!config) { config = new SystemConfig(); await config.save(); }
    return config;
};

// --- 3. UNIVERSAL HELPER: ERROR GUARD ---
// Yeh function 404 ko rokta hai aur data missing hone par empty array bhejta hai
const safeQuery = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } 
    catch (e) { console.error("❌ Neural Error:", e.message); res.json([]); }
};

// --- 4. CORE APIs: AUTH & SEARCH ---

app.get('/', (req, res) => res.status(200).send('🚀 POD Master Node Operational | v4.0 Universal Active'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// Search Algorithm (Etsy Logic)
app.get('/api/products/search', safeQuery(async (req, res) => {
    const { q, category } = req.query;
    let query = { status: { $in: ['approved', 'pending'] } }; // Testing mode
    if (q) query.$or = [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }];
    if (category && category !== 'All') query.category = category;

    const data = await Product.find(query).populate('supplier', 'name').lean();
    res.json(data.sort((a, b) => (b.salesCount || 0) - (a.salesCount || 0)));
}));

app.get('/api/products/suggestions', safeQuery(async (req, res) => {
    const data = await Product.find({ name: { $regex: req.query.q, $options: 'i' } }).limit(6).select('name');
    res.json(data);
}));

// --- 5. FINTECH NODE (Wallet & Treasury) ---

app.get('/api/wallet/:userId', safeQuery(async (req, res) => {
    const user = await User.findById(req.params.userId);
    res.json({ balance: user ? user.walletBalance : 0 });
}));

app.post('/api/wallet/pay', safeQuery(async (req, res) => {
    const user = await User.findById(req.body.userId);
    if (!user || user.walletBalance < req.body.amount) return res.status(400).json({ message: "Funds required" });
    await User.findByIdAndUpdate(req.body.userId, { $inc: { walletBalance: -req.body.amount } });
    res.json({ message: "Paid" });
}));

app.post('/api/wallet/withdraw', safeQuery(async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { $inc: { walletBalance: -req.body.amount } }); // Hold
    await new Withdrawal({ user: req.body.userId, amount: req.body.amount, status: 'pending' }).save();
    res.json({ message: "Processing" });
}));

// Admin Treasury List
app.get(['/api/admin/withdrawals', '/api/admin/treasury'], safeQuery(async (req, res) => {
    const data = await Withdrawal.find().populate('user', 'name email role walletBalance').sort({ createdAt: -1 });
    res.json(data);
}));

app.post('/api/admin/withdrawals/action', safeQuery(async (req, res) => {
    const request = await Withdrawal.findById(req.body.id);
    if (req.body.action === 'rejected') await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } }); // Refund
    request.status = req.body.action;
    await request.save();
    res.json({ message: "Settled" });
}));

// --- 6. LOGISTICS NODE (Order Management) ---

app.post('/api/orders/create', safeQuery(async (req, res) => {
    const newOrder = new Order(req.body);
    await newOrder.save();
    await Product.findByIdAndUpdate(req.body.productId, { $inc: { salesCount: 1 } });
    res.json({ message: "Confirmed", orderId: newOrder._id });
}));

// Multi-path Supplier Queue (Handles both singular and plural)
app.get(['/api/orders/supplier/:id', '/api/order/supplier/:id'], safeQuery(async (req, res) => {
    const data = await Order.find({ supplierId: req.params.id }).populate('sellerId', 'name email').populate('productId', 'name').sort({ createdAt: -1 });
    res.json(data);
}));

app.get(['/api/orders/seller/:id', '/api/order/seller/:id'], safeQuery(async (req, res) => {
    const data = await Order.find({ sellerId: req.params.id }).populate('productId', 'name').sort({ createdAt: -1 });
    res.json(data);
}));

app.patch('/api/orders/status', safeQuery(async (req, res) => {
    await Order.findByIdAndUpdate(req.body.orderId, { status: req.body.status });
    res.json({ message: "Synced" });
}));

// --- 7. COMMUNICATION HUB (Chat & Seen Ticks) ---

app.get(['/api/chat/unread/:userId', '/api/chat/unread-count/:userId'], safeQuery(async (req, res) => {
    const chats = await Chat.find({ participants: req.params.userId });
    const chatIds = chats.map(c => c._id);
    const unread = await Message.find({ chatId: { $in: chatIds }, sender: { $ne: req.params.userId }, status: { $ne: 'seen' } });
    const unreadMap = {};
    unread.forEach(msg => { unreadMap[msg.chatId] = (unreadMap[msg.chatId] || 0) + 1; });
    res.json({ total: unread.length, perChat: unreadMap });
}));

app.get('/api/chat/conversations/:userId', safeQuery(async (req, res) => {
    const data = await Chat.find({ participants: req.params.userId }).populate('participants', 'name email role').sort({ lastMessageTime: -1 });
    res.json(data);
}));

app.get('/api/chat/messages/:chatId', safeQuery(async (req, res) => {
    const data = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
    res.json(data);
}));

// --- 8. INTELLIGENCE HUD (Dashboard Stats) ---

app.get(['/api/admin/detailed-stats', '/api/admin/analytics'], safeQuery(async (req, res) => {
    const suppliers = await User.countDocuments({ role: 'supplier' });
    const sellers = await User.countDocuments({ role: 'seller' });
    const supplierPerformance = await Order.aggregate([
        { $group: { _id: "$supplierId", totalOrders: { $sum: 1 }, revenue: { $sum: "$totalPrice" } } },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "details" } },
        { $unwind: "$details" }
    ]);
    res.json({ userStats: { sellers, suppliers }, supplierPerformance, revenueTimeline: [] });
}));

app.get('/api/supplier/stats/:id', safeQuery(async (req, res) => {
    const user = await User.findById(req.params.id);
    const products = await Product.countDocuments({ supplier: req.params.id });
    const orders = await Order.find({ supplierId: req.params.id });
    res.json({ products, balance: user?.walletBalance || 0, withdrawn: 0, pendingOrders: orders.filter(o=>o.status==='pending').length });
}));

// --- 9. PRODUCTION ENGINE (Multimedia Upload) ---

const productUpload = upload.fields([{ name: 'images', maxCount: 12 }, { name: 'video', maxCount: 1 }]);

app.post('/api/product/add', productUpload, safeQuery(async (req, res) => {
    const { name, basePrice, supplierId } = req.body;
    const primaryImg = req.files['images'][0];
    const buffer = await sharp(primaryImg.path).resize(10, 10).grayscale().toBuffer();
    const hash = buffer.toString('base64');

    if (await Product.findOne({ imageHash: hash })) return res.status(403).json({ error: "Copyright" });

    const newProd = new Product({
        ...req.body,
        supplier: supplierId,
        imagePaths: req.files['images'].map(f => f.filename),
        imageHash: hash,
        status: 'approved' // Set to 'pending' if you want 3h scan
    });
    await newProd.save();
    res.json({ message: "Deployed" });
}));

// --- 10. SOCKET.IO MASTER LOGIC ---

io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));
  socket.on('send_message', async (data) => {
    const securityRegex = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    if (data.text && securityRegex.test(data.text)) return io.to(data.senderId).emit('error_message', "⚠️ Blocked");

    let chat = await Chat.findOne({ participants: { $all: [data.senderId, data.receiverId] } });
    if (!chat) { chat = new Chat({ participants: [data.senderId, data.receiverId] }); await chat.save(); }
    chat.lastMessage = data.text || '📷 Media'; chat.lastMessageTime = Date.now(); await chat.save();

    const newMessage = new Message({ ...data, chatId: chat._id, status: 'delivered' }); await newMessage.save();
    io.to(data.receiverId).emit('receive_message', newMessage);
    io.to(data.receiverId).emit('notification', { from: data.senderId, chatId: chat._id });
  });
  socket.on('mark_read', async (data) => {
    await Message.updateMany({ chatId: data.chatId, sender: { $ne: data.userId }, status: { $ne: 'seen' } }, { $set: { status: 'seen' } });
  });
});

// Admin System Config
app.get('/api/admin/config', async (req, res) => res.json(await getAppConfig()));
app.post('/api/admin/config', async (req, res) => {
    await SystemConfig.findOneAndUpdate({ key: 'main_config' }, req.body, { upsert: true });
    res.json({ message: "Synced" });
});

const PORT = 80;
server.listen(PORT, () => console.log(`🚀 MASTER NODE operational on Port ${PORT}`));