const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const path = require('path');
const multer = require('multer'); 
const fs = require('fs'); 
const sharp = require('sharp'); // Copyright & Neural Scan
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// --- 1. MODELS LOADING (Top-level) ---
const User = require('./models/User');
const Product = require('./models/Product');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');
const Withdrawal = require('./models/Withdrawal');

// System Config Schema (Inline)
const configSchema = new mongoose.Schema({
    key: { type: String, default: 'main_config' },
    quarantineEnabled: { type: Boolean, default: true },
    quarantineDuration: { type: Number, default: 180 }, // Minutes
});
const SystemConfig = mongoose.models.SystemConfig || mongoose.model('SystemConfig', configSchema);

// Review Schema (Inline)
const reviewSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    createdAt: { type: Date, default: Date.now }
});
const Review = mongoose.models.Review || mongoose.model('Review', reviewSchema);

// --- 2. CONFIGURATION & ENGINE LIMITS ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7 // 50 MB for high-res designs
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ SYSTEM: Master Database Connected & Verified"))
    .catch(err => console.error("❌ CRITICAL: DB Error ->", err));

// Storage Setup
const uploadDir = '/app/uploads';
const tempDir = 'temp/';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir), 
  filename: (req, file, cb) => cb(null, `pod-${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
});
const upload = multer({ storage });

const getAppConfig = async () => {
    let config = await SystemConfig.findOne({ key: 'main_config' });
    if (!config) { config = new SystemConfig(); await config.save(); }
    return config;
};

// --- 3. CORE APIs & LANDING ---
app.get('/', (req, res) => res.status(200).send('🚀 POD Master Node Active | v3.0 Secured ✅'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// --- 4. ADVANCED PRODUCT ENGINE (Multi-Upload + Security) ---

const productAssets = upload.fields([
    { name: 'images', maxCount: 12 },
    { name: 'video', maxCount: 1 }
]);

app.post('/api/product/add', productAssets, async (req, res) => {
    try {
        const { name, description, basePrice, supplierId, category, tags, variations, source, isPhysical } = req.body;
        if (!req.files || !req.files['images']) return res.status(400).send("Images required.");

        const primaryImg = req.files['images'][0];
        const imageBuffer = await sharp(primaryImg.path).resize(10, 10).grayscale().toBuffer();
        const currentHash = imageBuffer.toString('base64');

        const isDuplicate = await Product.findOne({ imageHash: currentHash });
        if (isDuplicate) {
            Object.values(req.files).flat().forEach(f => fs.unlinkSync(f.path));
            return res.status(403).json({ error: "Copyright Alert", guide: "This design already exists." });
        }

        const config = await getAppConfig();
        const savedImages = req.files['images'].map(f => f.filename);

        const newProduct = new Product({
            name, description, basePrice, category,
            supplier: supplierId,
            imagePaths: savedImages,
            tags: tags ? tags.split(',') : [],
            variations: variations ? JSON.parse(variations) : [],
            source: source || 'handmade',
            isPhysical: isPhysical === 'true',
            imageHash: currentHash,
            status: config.quarantineEnabled ? 'pending' : 'approved'
        });

        await newProduct.save();
        res.json({ message: "Neural Scan Passed!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 5. SMART SEARCH ENGINE (Etsy Logic) ---

app.get('/api/products/search', async (req, res) => {
    const { q, category } = req.query;
    try {
        // 💡 Showing both for testing. Production change to: { status: 'approved' }
        let query = { status: { $in: ['approved', 'pending'] } }; 
        if (q) query.$or = [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }];
        if (category && category !== 'All') query.category = category;

        const products = await Product.find(query).populate('supplier', 'name').lean();
        const results = products.map(p => {
            const now = Date.now();
            const recentViews = (p.views24h || []).filter(v => new Date(v) > (now - 86400000)).length;
            const score = (recentViews * 2) + ((p.salesCount || 0) * 10) + (p.source === 'handmade' ? 100 : 0);
            return { ...p, recentViews, score };
        }).sort((a, b) => b.score - a.score);
        res.json(results);
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/products/suggestions', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    const data = await Product.find({ $or: [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }] })
        .limit(6).select('name category tags');
    res.json(data);
});

// --- 6. WALLET & WITHDRAWAL (Hold Logic) ---

app.get('/api/wallet/:userId', async (req, res) => {
    const user = await User.findById(req.params.userId);
    res.json({ balance: user ? user.walletBalance : 0 });
});

app.post('/api/wallet/pay', async (req, res) => {
    const user = await User.findById(req.body.userId);
    if (!user || user.walletBalance < req.body.amount) return res.status(400).json({ message: "Low funds" });
    await User.findByIdAndUpdate(req.body.userId, { $inc: { walletBalance: -req.body.amount } });
    res.json({ message: "Verified" });
});

app.post('/api/wallet/withdraw', async (req, res) => {
    const user = await User.findById(req.body.userId);
    if (!user || user.walletBalance < req.body.amount) return res.status(400).json({ message: "Low Balance" });
    
    await User.findByIdAndUpdate(req.body.userId, { $inc: { walletBalance: -req.body.amount } }); // HOLD
    const newReq = new Withdrawal({ user: req.body.userId, amount: req.body.amount, status: 'pending' });
    await newReq.save();
    res.json({ message: "Request Sent" });
});

app.post('/api/admin/withdrawals/action', async (req, res) => {
    const request = await Withdrawal.findById(req.body.id);
    if (req.body.action === 'rejected') {
        await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } }); // REFUND
    }
    request.status = req.body.action;
    await request.save();
    res.json({ message: "Status Updated" });
});

app.get('/api/admin/withdrawals', async (req, res) => {
    const data = await Withdrawal.find().populate('user', 'name email role walletBalance').sort({ createdAt: -1 });
    res.json(data);
});

// --- 7. ORDER SYSTEM ---

app.post('/api/orders/create', async (req, res) => {
    try {
        const newOrder = new Order(req.body);
        await newOrder.save();
        await Product.findByIdAndUpdate(req.body.productId, { $inc: { salesCount: 1 } });
        res.json({ message: "Order Success", orderId: newOrder._id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/supplier/:id', async (req, res) => {
    const data = await Order.find({ supplierId: req.params.id }).populate('sellerId', 'name email').populate('productId', 'name').sort({ createdAt: -1 });
    res.json(data);
});

app.get('/api/orders/seller/:id', async (req, res) => {
    const data = await Order.find({ sellerId: req.params.id }).populate('productId', 'name').sort({ createdAt: -1 });
    res.json(data);
});

app.patch('/api/orders/status', async (req, res) => {
    await Order.findByIdAndUpdate(req.body.orderId, { status: req.body.status });
    res.json({ message: "Status Updated" });
});

// --- 8. STATS & ANALYTICS ---

app.get('/api/admin/detailed-stats', async (req, res) => {
    try {
        const supplierPerformance = await Order.aggregate([
            { $group: { _id: "$supplierId", totalOrders: { $sum: 1 }, revenue: { $sum: "$totalPrice" } }},
            { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "details" }},
            { $unwind: "$details" }
        ]);
        const userStats = {
            sellers: await User.countDocuments({ role: 'seller' }),
            suppliers: await User.countDocuments({ role: 'supplier' }),
            pendingPayouts: await Withdrawal.countDocuments({ status: 'pending' })
        };
        res.json({ supplierPerformance, userStats, revenueTimeline: [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/supplier/stats/:id', async (req, res) => {
    try {
        const supplierId = req.params.id;
        if (!supplierId || supplierId === 'undefined') return res.status(400).send("ID missing");
        const prodCount = await Product.countDocuments({ supplier: supplierId });
        const user = await User.findById(supplierId);
        res.json({ products: prodCount, balance: user ? user.walletBalance : 0, withdrawn: 0, pendingRequests: 0 });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 9. CHAT SYSTEM & UNREAD ---

app.get('/api/chat/unread/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId || userId === 'undefined') return res.json({ total: 0, perChat: {} });
        const chats = await Chat.find({ participants: userId });
        const chatIds = chats.map(c => c._id);
        const unread = await Message.find({ chatId: { $in: chatIds }, sender: { $ne: userId }, status: { $ne: 'seen' } });
        const unreadMap = {};
        unread.forEach(msg => { unreadMap[msg.chatId] = (unreadMap[msg.chatId] || 0) + 1; });
        res.json({ total: unread.length, perChat: unreadMap });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chat/conversations/:userId', async (req, res) => {
    if (!req.params.userId || req.params.userId === 'undefined') return res.json([]);
    const data = await Chat.find({ participants: req.params.userId }).populate('participants', 'name email role').sort({ lastMessageTime: -1 });
    res.json(data);
});

app.get('/api/chat/messages/:chatId', async (req, res) => {
    const data = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
    res.json(data);
});

// --- 10. SOCKET.IO ENGINE ---

io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));
  socket.on('send_message', async (data) => {
    if (data.text && (PHONE_REGEX.test(data.text) || EMAIL_REGEX.test(data.text))) {
        return io.to(data.senderId).emit('error_message', "⚠️ Blocked: contact info sharing.");
    }
    let chat = await Chat.findOne({ participants: { $all: [data.senderId, data.receiverId] } });
    if (!chat) { chat = new Chat({ participants: [data.senderId, data.receiverId] }); await chat.save(); }
    chat.lastMessage = data.text || '📷 Attachment'; chat.lastMessageTime = Date.now(); await chat.save();
    const newMessage = new Message({ ...data, chatId: chat._id, status: 'delivered' }); await newMessage.save();
    io.to(data.receiverId).emit('receive_message', newMessage);
    io.to(data.receiverId).emit('notification', { from: data.senderId, chatId: chat._id });
  });
  socket.on('mark_read', async (data) => {
    await Message.updateMany({ chatId: data.chatId, sender: { $ne: data.userId }, status: { $ne: 'seen' } }, { $set: { status: 'seen' } });
  });
});

// --- 11. SUPPLIER STOREFRONT API ---
app.get('/api/shop/:id', async (req, res) => {
    try {
        const supplierId = req.params.id;
        
        // 1. Get Supplier Profile
        const supplier = await User.findById(supplierId).select('name email storeName createdAt');
        
        // 2. Get All Approved Products of this Supplier
        const products = await Product.find({ supplier: supplierId, status: 'approved' })
            .sort({ createdAt: -1 });

        res.json({
            supplier,
            products,
            totalProducts: products.length
        });
    } catch (err) {
        res.status(500).json({ error: "Storefront Offline", details: err.message });
    }
});

// --- 12. AUTOMATION ---

setInterval(async () => {
    const config = await getAppConfig();
    if (!config.quarantineEnabled) return;
    const cutoff = new Date(Date.now() - config.quarantineDuration * 60 * 1000);
    await Product.updateMany({ status: 'pending', createdAt: { $lte: cutoff } }, { $set: { status: 'approved' } });
}, 600000);

// Admin Config
app.get('/api/admin/config', async (req, res) => res.json(await getAppConfig()));
app.post('/api/admin/config', async (req, res) => {
    await SystemConfig.findOneAndUpdate({ key: 'main_config' }, req.body, { upsert: true });
    res.json({ message: "Synced" });
});

const PORT = 80;
server.listen(PORT, () => console.log(`🚀 Master Node operational on Port ${PORT}`));