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
const Review = mongoose.models.Review || mongoose.model('Review', new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    createdAt: { type: Date, default: Date.now }
}));

// --- 2. CONFIGURATION & UTILS ---
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

// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ SYSTEM: Master Node Fully Synced & Secured"))
    .catch(err => console.error("❌ DB ERROR:", err));

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

// Helper: Error Guard
const safeQuery = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } 
    catch (e) { 
        console.error("❌ Neural Node Error:", e.message); 
        res.status(500).json({ error: "System Error", details: e.message }); 
    }
};

const getAppConfig = async () => {
    let config = await SystemConfig.findOne({ key: 'main_config' });
    if (!config) { config = new SystemConfig(); await config.save(); }
    return config;
};

// --- 3. CORE ROUTES ---
app.get('/', (req, res) => res.status(200).send('🚀 POD Super Master Node v5.0 | All Systems Operational ✅'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// --- 4. PRODUCT ENGINE (Neural Scan & Management) ---
const productAssets = upload.fields([{ name: 'images', maxCount: 12 }, { name: 'video', maxCount: 1 }]);

app.post('/api/product/add', productAssets, safeQuery(async (req, res) => {
    if (!req.files || !req.files['images']) return res.status(400).send("Images required.");

    const primaryImg = req.files['images'][0];
    const imageBuffer = await sharp(primaryImg.path).resize(10, 10).grayscale().toBuffer();
    const currentHash = imageBuffer.toString('base64');

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
        isPhysical: req.body.isPhysical === 'true',
        tags: req.body.tags ? req.body.tags.split(',') : []
    });
    await newProduct.save();
    res.json({ message: "Neural Scan Passed. Product Live." });
}));

app.get('/api/supplier/products/:id', safeQuery(async (req, res) => {
    const { id } = req.params;
    if (!id || id === 'undefined') return res.json([]);
    const products = await Product.find({ supplier: id }).sort({ createdAt: -1 });
    res.json(products);
}));

app.patch('/api/product/set-sale', safeQuery(async (req, res) => {
    const { productId, discountPercentage, onSale } = req.body;
    const product = await Product.findById(productId);
    const salePrice = onSale ? (product.basePrice * (1 - discountPercentage / 100)).toFixed(2) : product.basePrice;
    await Product.findByIdAndUpdate(productId, { onSale, discountPercentage, salePrice });
    res.json({ message: "Sale status updated!" });
}));

// --- 5. SEARCH & ANALYTICS ---

app.get(['/api/products/search', '/api/product/search'], safeQuery(async (req, res) => {
    const { q, category } = req.query;
    let query = { status: 'approved' }; 
    
    if (q) query.$or = [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }];
    if (category && category !== 'All') query.category = category;

    const products = await Product.find(query).populate('supplier', 'name storeName').lean();
    
    // Advanced Scoring: Views (24h) + Sales + Handmade Boost
    const scoredResults = products.map(p => {
        const recentViews = (p.views24h || []).filter(v => new Date(v) > (Date.now() - 86400000)).length;
        const score = (recentViews * 2) + ((p.salesCount || 0) * 10) + (p.source === 'handmade' ? 100 : 0) + (p.clickCount || 0);
        return { ...p, score, recentViews };
    }).sort((a, b) => b.score - a.score);

    res.json(scoredResults);
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

// --- 6. SHOP PROFILE & BANNER SYSTEM ---

const profileUpload = upload.fields([{ name: 'profileImage', maxCount: 1 }, { name: 'bannerImage', maxCount: 1 }]);

app.put('/api/shop/update-profile', profileUpload, safeQuery(async (req, res) => {
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
    res.json({ message: "Shop updated successfully!" });
}));

app.get('/api/shop/:id', safeQuery(async (req, res) => {
    const supplier = await User.findById(req.params.id)
         .select('name email storeName createdAt profileImage bannerImages bio announcement bannerAnimation bannerInterval'); 
    const products = await Product.find({ supplier: req.params.id, status: 'approved' }).sort({ createdAt: -1 });
    const reviews = await Review.find({ productId: { $in: products.map(p => p._id) } }).populate('userId', 'name');
    res.json({ supplier, products, reviews, totalSales: products.reduce((acc, p) => acc + (p.salesCount || 0), 0) });
}));

// --- 7. FINTECH & ORDERS ---

app.get('/api/wallet/:userId', safeQuery(async (req, res) => {
    const user = await User.findById(req.params.userId);
    res.json({ balance: user ? user.walletBalance : 0 });
}));

app.post('/api/wallet/withdraw', safeQuery(async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Insufficient Funds" });
    
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    await new Withdrawal({ user: userId, amount, status: 'pending' }).save();
    res.json({ message: "Withdrawal Request Submitted" });
}));

app.get('/api/admin/withdrawals', safeQuery(async (req, res) => {
    const data = await Withdrawal.find().populate('user', 'name email role walletBalance').sort({ createdAt: -1 });
    res.json(data);
}));

app.post('/api/admin/withdrawals/action', safeQuery(async (req, res) => {
    const { id, action } = req.body;
    const request = await Withdrawal.findById(id);
    if (!request || request.status !== 'pending') return res.status(400).send("Invalid Request");

    if (action === 'rejected') {
        await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } });
    }
    request.status = action;
    await request.save();
    res.json({ message: `Request ${action} successfully` });
}));

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

// --- 8. CHAT & SOCKETS ---

app.get('/api/chat/conversations/:userId', safeQuery(async (req, res) => {
    const { userId } = req.params;
    if (!userId || userId === 'undefined') return res.json([]);
    const data = await Chat.find({ participants: userId }).populate('participants', 'name email role profileImage').sort({ lastMessageTime: -1 });
    res.json(data);
}));

app.get('/api/chat/messages/:chatId', safeQuery(async (req, res) => {
    const { chatId } = req.params;
    if (!chatId || chatId === 'undefined') return res.json([]);
    const messages = await Message.find({ chatId }).sort({ createdAt: 1 });
    res.json(messages);
}));

io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));
  
  socket.on('send_message', async (data) => {
    if (data.text && (PHONE_REGEX.test(data.text) || EMAIL_REGEX.test(data.text))) {
        return io.to(data.senderId).emit('error_message', "⚠️ Security: Contact sharing restricted.");
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

// --- 9. ADMIN & STATS ---

app.get('/api/admin/detailed-stats', safeQuery(async (req, res) => {
    const suppliers = await User.countDocuments({ role: 'supplier' });
    const sellers = await User.countDocuments({ role: 'seller' });
    const revenue = await Order.aggregate([{ $group: { _id: null, total: { $sum: "$totalPrice" } } }]);
    const revenueTimeline = await Order.aggregate([
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, dailyRevenue: { $sum: "$totalPrice" } } },
        { $sort: { "_id": -1 } }, { $limit: 15 }
    ]);
    const supplierPerformance = await Order.aggregate([
        { $group: { _id: "$supplierId", totalOrders: { $sum: 1 }, revenue: { $sum: "$totalPrice" } } },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "details" } },
        { $unwind: "$details" }
    ]);
    res.json({ userStats: { sellers, suppliers }, totalRevenue: revenue[0]?.total || 0, revenueTimeline, supplierPerformance });
}));

app.get('/api/admin/config', safeQuery(async (req, res) => res.json(await getAppConfig())));
app.post('/api/admin/config', safeQuery(async (req, res) => {
    const config = await SystemConfig.findOneAndUpdate({ key: 'main_config' }, req.body, { upsert: true, new: true });
    res.json(config);
}));

// Quarantine Auto-Approval Logic
setInterval(async () => {
    const config = await getAppConfig();
    if (!config.quarantineEnabled) return;
    const cutoff = new Date(Date.now() - config.quarantineDuration * 60 * 1000);
    await Product.updateMany({ status: 'pending', createdAt: { $lte: cutoff } }, { $set: { status: 'approved' } });
}, 600000);

const PORT = process.env.PORT || 80;
server.listen(PORT, () => console.log(`🚀 MASTER NODE v5.0 operational on Port ${PORT}`));