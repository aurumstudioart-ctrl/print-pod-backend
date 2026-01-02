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

// Inline System Config Model
const configSchema = new mongoose.Schema({
    key: { type: String, default: 'main_config' },
    quarantineEnabled: { type: Boolean, default: true },
    quarantineDuration: { type: Number, default: 180 }, 
});
const SystemConfig = mongoose.models.SystemConfig || mongoose.model('SystemConfig', configSchema);

// Inline Review Model
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
  maxHttpBufferSize: 5e7 // 50 MB limit for sockets
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Master Database Linked & Verified"))
    .catch(err => console.error("❌ DB Connection Error", err));

// Storage Setup
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

// --- 3. BASIC ROUTES ---
app.get('/', (req, res) => res.status(200).send('🚀 POD Master Node v4.0 Operational ✅'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// --- 4. PRODUCT ENGINE (Neural Scan + Sale System) ---
const productAssets = upload.fields([{ name: 'images', maxCount: 12 }, { name: 'video', maxCount: 1 }]);

app.post('/api/product/add', productAssets, async (req, res) => {
    try {
        const { name, description, basePrice, supplierId, category, tags, source, isPhysical } = req.body;
        if (!req.files || !req.files['images']) return res.status(400).send("Images required.");

        // Neural Scan for Copyright (Sharp)
        const primaryImg = req.files['images'][0];
        const imageBuffer = await sharp(primaryImg.path).resize(10, 10).grayscale().toBuffer();
        const currentHash = imageBuffer.toString('base64');

        const existing = await Product.findOne({ imageHash: currentHash });
        if (existing) return res.status(403).json({ error: "Copyright Block", guide: "Design already exists." });

        const config = await getAppConfig();
        const newProduct = new Product({
            name, description, basePrice, category, supplier: supplierId,
            imagePaths: req.files['images'].map(f => f.filename),
            imageHash: currentHash, 
            status: config.quarantineEnabled ? 'pending' : 'approved',
            source, isPhysical: isPhysical === 'true', tags: tags ? tags.split(',') : []
        });
        await newProduct.save();
        res.json({ message: "Neural Scan Passed! Product Uploaded." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/product/set-sale', async (req, res) => {
    const { productId, discountPercentage, onSale } = req.body;
    try {
        const product = await Product.findById(productId);
        const salePrice = onSale ? (product.basePrice * (1 - discountPercentage / 100)).toFixed(2) : product.basePrice;
        await Product.findByIdAndUpdate(productId, { onSale, discountPercentage, salePrice });
        res.json({ message: "Sale status updated!" });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 5. SMART SEARCH & ANALYTICS ---

app.get('/api/products/search', async (req, res) => {
    const { q, category } = req.query;
    try {
        let query = { status: 'approved' }; 
        if (q) query.$or = [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }];
        if (category && category !== 'All') query.category = category;

        const products = await Product.find(query).populate('supplier', 'name').lean();
        // Smart Ranking logic
        const results = products.map(p => ({
            ...p,
            score: (p.clickCount || 0) + (p.source === 'handmade' ? 100 : 0)
        })).sort((a, b) => b.score - a.score);
        res.json(results);
    } catch (err) { res.status(500).send(err.message); }
});

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

// --- 6. SHOP PROFILE & BANNER SYSTEM ---

const profileUpload = upload.fields([{ name: 'profileImage', maxCount: 1 }, { name: 'bannerImage', maxCount: 1 }]);

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

app.get('/api/shop/:id', async (req, res) => {
    try {
        const supplier = await User.findById(req.params.id)
             .select('name email storeName createdAt profileImage bannerImages bio announcement bannerAnimation bannerInterval'); 
        const products = await Product.find({ supplier: req.params.id, status: 'approved' }).sort({ createdAt: -1 });
        const reviews = await Review.find({ productId: { $in: products.map(p => p._id) } }).populate('userId', 'name');
        res.json({ supplier, products, reviews, totalSales: products.reduce((acc, p) => acc + (p.salesCount || 0), 0) });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 7. WITHDRAWAL & WALLET ---

app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const data = await Withdrawal.find().populate('user', 'name email role walletBalance').sort({ createdAt: -1 });
        res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/withdrawals/action', async (req, res) => {
    try {
        const { id, action } = req.body;
        const request = await Withdrawal.findById(id);
        if (!request || request.status !== 'pending') return res.status(400).send("Invalid");
        if (action === 'rejected') await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } });
        request.status = action;
        await request.save();
        res.json({ message: "Action Successful" });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/wallet/withdraw', async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).send("Low Funds");
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    const newReq = new Withdrawal({ user: userId, amount, status: 'pending' });
    await newReq.save();
    res.json({ message: "Request Submitted" });
});

// --- 8. ORDERS SYSTEM ---

app.get('/api/orders/supplier/:id', async (req, res) => {
    try {
        const data = await Order.find({ supplierId: req.params.id }).populate('sellerId', 'name email').populate('productId', 'name').sort({ createdAt: -1 });
        res.json(data);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/orders/create', async (req, res) => {
    try {
        const newOrder = new Order(req.body);
        await newOrder.save();
        res.json({ message: "Order Success", orderId: newOrder._id });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 9. CHAT ENGINE & SOCKETS ---

app.get('/api/chat/conversations/:userId', async (req, res) => {
    try {
        const data = await Chat.find({ participants: req.params.userId }).populate('participants', 'name email role').sort({ lastMessageTime: -1 });
        res.json(data);
    } catch (err) { res.status(500).send(err.message); }
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
    // Security Block for Phone/Email
    if (data.text && (PHONE_REGEX.test(data.text) || EMAIL_REGEX.test(data.text))) {
        return io.to(data.senderId).emit('error_message', "⚠️ Security Blocked: Contact sharing not allowed.");
    }
    
    let chat = await Chat.findOne({ participants: { $all: [data.senderId, data.receiverId] } });
    if (!chat) { chat = new Chat({ participants: [data.senderId, data.receiverId] }); await chat.save(); }
    
    const newMessage = new Message({ ...data, chatId: chat._id, status: 'delivered' }); 
    await newMessage.save();
    
    io.to(data.receiverId).emit('receive_message', newMessage);
    io.to(data.receiverId).emit('notification', { from: data.senderId, chatId: chat._id });
  });

  socket.on('mark_read', async (data) => {
    await Message.updateMany({ chatId: data.chatId, sender: { $ne: data.userId }, status: { $ne: 'seen' } }, { $set: { status: 'seen' } });
  });
});

// --- 10. AUTOMATION & CONFIG ---

app.get('/api/admin/config', async (req, res) => {
    const config = await getAppConfig();
    res.json(config);
});

app.post('/api/admin/config', async (req, res) => {
    const config = await SystemConfig.findOneAndUpdate({ key: 'main_config' }, req.body, { upsert: true, new: true });
    res.json(config);
});

setInterval(async () => {
    const config = await getAppConfig();
    if (!config.quarantineEnabled) return;
    const cutoff = new Date(Date.now() - config.quarantineDuration * 60 * 1000);
    await Product.updateMany({ status: 'pending', createdAt: { $lte: cutoff } }, { $set: { status: 'approved' } });
}, 600000); // Har 10 min mein check karega

const PORT = 80;
server.listen(PORT, () => console.log(`🚀 Master Node Operational on Port ${PORT}`));