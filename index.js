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

// --- 1. MODELS LOADING ---
const User = require('./models/User');
const Product = require('./models/Product');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');
const Withdrawal = require('./models/Withdrawal');

// Inline Config Schema
const configSchema = new mongoose.Schema({
    key: { type: String, default: 'main_config' },
    quarantineEnabled: { type: Boolean, default: true },
    quarantineDuration: { type: Number, default: 180 }, 
});
const SystemConfig = mongoose.models.SystemConfig || mongoose.model('SystemConfig', configSchema);

// Review Schema (For Storefront)
const reviewSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    createdAt: { type: Date, default: Date.now }
});
const Review = mongoose.models.Review || mongoose.model('Review', reviewSchema);

// --- 2. CONFIGURATION & LIMITS ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7 // 50 MB
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ SYSTEM: Master Database Connected & Verified"))
    .catch(err => console.error("❌ DB Error:", err));

// Storage Setup
const uploadDir = '/app/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir), 
  filename: (req, file, cb) => cb(null, `asset-${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
});
const upload = multer({ storage });

const getAppConfig = async () => {
    let config = await SystemConfig.findOne({ key: 'main_config' });
    if (!config) { config = new SystemConfig(); await config.save(); }
    return config;
};

// --- 3. CORE ROUTES ---
app.get('/', (req, res) => res.status(200).send('🚀 Master Node Active | v3.2 Verified ✅'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// --- 4. SMART SEARCH ENGINE ---
app.get('/api/products/search', async (req, res) => {
    const { q, category } = req.query;
    try {
        let query = { status: 'approved' }; 
        if (q) query.$or = [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }];
        if (category && category !== 'All') query.category = category;

        const products = await Product.find(query).populate('supplier', 'name').lean();
        const results = products.map(p => ({
            ...p,
            score: (p.clickCount || 0) + (p.source === 'handmade' ? 100 : 0)
        })).sort((a, b) => b.score - a.score);
        res.json(results);
    } catch (err) { res.status(500).send(err.message); }
});

// --- 5. DASHBOARD & ADMIN ANALYTICS (Fixed) ---

app.get('/api/admin/detailed-stats', async (req, res) => {
    try {
        const suppliers = await User.countDocuments({ role: 'supplier' });
        const sellers = await User.countDocuments({ role: 'seller' });
        const revenueTimeline = await Order.aggregate([
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, dailyRevenue: { $sum: "$totalPrice" }, orderCount: { $sum: 1 } } },
            { $sort: { "_id": -1 } }, { $limit: 15 }
        ]);
        const supplierPerformance = await Order.aggregate([
            { $group: { _id: "$supplierId", totalOrders: { $sum: 1 }, revenue: { $sum: "$totalPrice" } } },
            { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "details" } },
            { $unwind: "$details" }
        ]);
        res.json({ userStats: { sellers, suppliers }, revenueTimeline, supplierPerformance });
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/supplier/stats/:id', async (req, res) => {
    try {
        const supplierId = req.params.id;
        const user = await User.findById(supplierId);
        const productsCount = await Product.countDocuments({ supplier: supplierId });
        const orders = await Order.find({ supplierId: supplierId });
        
        // Payout calculation
        const approvedWithdrawals = await Withdrawal.aggregate([
            { $match: { user: new mongoose.Types.ObjectId(supplierId), status: 'approved' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);

        res.json({ 
            products: productsCount, 
            balance: user?.walletBalance || 0, 
            withdrawn: approvedWithdrawals[0]?.total || 0, 
            pendingOrders: orders.filter(o => o.status === 'pending').length 
        });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 6. SHOP PROFILE & BANNER SLIDER (Array Logic) ---

const profileUpload = upload.fields([
    { name: 'profileImage', maxCount: 1 },
    { name: 'bannerImage', maxCount: 1 }
]);

app.put('/api/shop/update-profile', profileUpload, async (req, res) => {
    try {
        const { userId, storeName, announcement, bannerAnimation, bannerInterval, bio } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).send("User not found");

        let updateData = {
            storeName: storeName || user.storeName,
            announcement: announcement || user.announcement,
            bio: bio || user.bio,
            bannerAnimation: bannerAnimation || user.bannerAnimation || 'fade',
            bannerInterval: bannerInterval || user.bannerInterval || 5000
        };
        
        if (req.files) {
            if (req.files['profileImage']) updateData.profileImage = req.files['profileImage'][0].filename;
            if (req.files['bannerImage']) {
                const newBanner = req.files['bannerImage'][0].filename;
                updateData.bannerImages = user.bannerImages ? [...user.bannerImages, newBanner] : [newBanner];
            }
        }
        await User.findByIdAndUpdate(userId, { $set: updateData });
        res.json({ message: "Sync Successful 🚀" });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/shop/delete-banner', async (req, res) => {
    try {
        const { userId, filename } = req.body;
        await User.findByIdAndUpdate(userId, { $pull: { bannerImages: filename } });
        res.json({ message: "Banner Removed" });
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/shop/:id', async (req, res) => {
    try {
        const supplier = await User.findById(req.params.id)
             .select('name email storeName createdAt profileImage bannerImages bio announcement bannerAnimation bannerInterval'); 
        const products = await Product.find({ supplier: req.params.id, status: 'approved' }).sort({ createdAt: -1 });
        const reviews = await Review.find({ productId: { $in: products.map(p => p._id) } }).populate('userId', 'name');
        
        res.json({ 
            supplier, 
            products, 
            reviews,
            totalSales: products.reduce((acc, p) => acc + (p.salesCount || 0), 0) 
        });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 7. PRODUCT MANAGEMENT & SALES ---

app.get('/api/supplier/products/:id', async (req, res) => {
    try {
        const products = await Product.find({ supplier: req.params.id }).sort({ createdAt: -1 });
        res.json(products);
    } catch (err) { res.status(500).send(err.message); }
});

app.patch('/api/product/set-sale', async (req, res) => {
    const { productId, discountPercentage, onSale } = req.body;
    try {
        const product = await Product.findById(productId);
        const salePrice = onSale ? (product.basePrice * (1 - discountPercentage / 100)).toFixed(2) : product.basePrice;
        await Product.findByIdAndUpdate(productId, { onSale, discountPercentage, salePrice });
        res.json({ message: "Sale updated!" });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 8. WALLET, CHAT & SOCKETS ---

app.get('/api/wallet/:userId', async (req, res) => {
    const user = await User.findById(req.params.userId);
    res.json({ balance: user ? user.walletBalance : 0 });
});

app.get('/api/chat/unread/:userId', async (req, res) => {
    try {
        const chats = await Chat.find({ participants: req.params.userId });
        const unread = await Message.find({ chatId: { $in: chats.map(c=>c._id) }, sender: { $ne: req.params.userId }, status: { $ne: 'seen' } });
        const unreadMap = {};
        unread.forEach(msg => { unreadMap[msg.chatId] = (unreadMap[msg.chatId] || 0) + 1; });
        res.json({ total: unread.length, perChat: unreadMap });
    } catch (err) { res.status(500).send(err.message); }
});

io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));
  socket.on('send_message', async (data) => {
    if (data.text && (PHONE_REGEX.test(data.text) || EMAIL_REGEX.test(data.text))) {
        return io.to(data.senderId).emit('error_message', "⚠️ Security Blocked.");
    }
    let chat = await Chat.findOne({ participants: { $all: [data.senderId, data.receiverId] } });
    if (!chat) { chat = new Chat({ participants: [data.senderId, data.receiverId] }); await chat.save(); }
    const newMessage = new Message({ ...data, chatId: chat._id, status: 'delivered' }); await newMessage.save();
    io.to(data.receiverId).emit('receive_message', newMessage);
    io.to(data.receiverId).emit('notification', { from: data.senderId, chatId: chat._id });
  });
  socket.on('mark_read', async (data) => {
    await Message.updateMany({ chatId: data.chatId, sender: { $ne: data.userId }, status: { $ne: 'seen' } }, { $set: { status: 'seen' } });
  });
});

// --- 9. AUTOMATION & CONFIG ---
setInterval(async () => {
    const config = await getAppConfig();
    if (!config.quarantineEnabled) return;
    const cutoff = new Date(Date.now() - config.quarantineDuration * 60 * 1000);
    await Product.updateMany({ status: 'pending', createdAt: { $lte: cutoff } }, { $set: { status: 'approved' } });
}, 600000);

const PORT = 80;
server.listen(PORT, () => console.log(`🚀 Master operational on Port ${PORT}`));