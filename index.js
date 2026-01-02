const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const path = require('path');
const multer = require('multer'); 
const fs = require('fs'); 
const sharp = require('sharp'); // Neural Scanning & Copyright Protection
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// --- 1. DATABASE MODELS LOADING ---
const User = require('./models/User');
const Product = require('./models/Product');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');
const Withdrawal = require('./models/Withdrawal');

// System Config Model (For Admin Quarantine Controls)
const configSchema = new mongoose.Schema({
    key: { type: String, default: 'main_config' },
    quarantineEnabled: { type: Boolean, default: true },
    quarantineDuration: { type: Number, default: 180 }, // Minutes
});
const SystemConfig = mongoose.models.SystemConfig || mongoose.model('SystemConfig', configSchema);

// Review Model (For Customer Feedback)
const reviewSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    createdAt: { type: Date, default: Date.now }
});
const Review = mongoose.models.Review || mongoose.model('Review', reviewSchema);

// --- 2. ENGINE CONFIGURATION & SECURITY ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7 // 50 MB for High-Res Design Assets
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads')); // 30TB Mount Point

// Database Neural Link
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ SYSTEM: Master Database Operational"))
    .catch(err => console.error("❌ CRITICAL: DB Neural Link Failed ->", err));

// Storage Engine Setup
const uploadDir = '/app/uploads';
const tempDir = 'temp/';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir), 
  filename: (req, file, cb) => {
    const cleanName = file.originalname.replace(/\s+/g, '-');
    cb(null, `pod-${Date.now()}-${cleanName}`);
  }
});
const upload = multer({ storage });

// Helper: Fetch Global Settings
const getAppConfig = async () => {
    let config = await SystemConfig.findOne({ key: 'main_config' });
    if (!config) { config = new SystemConfig(); await config.save(); }
    return config;
};

// Universal Error Guard
const safeQuery = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } 
    catch (e) { console.error("❌ Node Error:", e.message); res.json([]); }
};

// --- 3. IDENTITY & CORE APIs ---
app.get('/', (req, res) => res.status(200).send('🚀 POD Master Node v5.2 Fully Operational ✅'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// --- 4. PRODUCTION ENGINE (Multi-Upload + Neural Scan) 🛡️ ---
const productUpload = upload.fields([{ name: 'images', maxCount: 12 }, { name: 'video', maxCount: 1 }]);

app.post('/api/product/add', productUpload, safeQuery(async (req, res) => {
    const { name, basePrice, supplierId, variations, tags } = req.body;
    if (!req.files || !req.files['images']) return res.status(400).send("Primary asset missing.");

    // A. Neural Copyright Scan
    const primaryImg = req.files['images'][0];
    const buffer = await sharp(primaryImg.path).resize(10, 10).grayscale().toBuffer();
    const hash = buffer.toString('base64');

    if (await Product.findOne({ imageHash: hash })) {
        return res.status(403).json({ error: "Copyright Violation", guide: "This design DNA already exists." });
    }

    const config = await getAppConfig();
    const newProd = new Product({
        ...req.body,
        supplier: supplierId,
        imagePaths: req.files['images'].map(f => f.filename),
        videoPath: req.files['video'] ? req.files['video'][0].filename : null,
        tags: tags ? tags.split(',') : [],
        variations: variations ? JSON.parse(variations) : [],
        imageHash: hash,
        status: config.quarantineEnabled ? 'pending' : 'approved',
        salesCount: 0,
        views24h: []
    });
    await newProd.save();
    res.json({ message: "Security Clearance Passed. Broadcast initiated." });
}));

// --- 5. SEARCH & DISCOVERY ENGINE (Etsy Logic) 🔍 ---
app.get(['/api/products/search', '/api/product/search'], safeQuery(async (req, res) => {
    const { q, category } = req.query;
    let query = { status: { $in: ['approved', 'pending'] } }; 
    if (q) query.$or = [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }];
    if (category && category !== 'All') query.category = category;

    const products = await Product.find(query).populate('supplier', 'name').lean();
    
    const scored = products.map(p => {
        const recentViews = (p.views24h || []).filter(v => new Date(v) > (Date.now() - 86400000)).length;
        const score = (recentViews * 2) + ((p.salesCount || 0) * 10) + (p.source === 'handmade' ? 100 : 0);
        
        let badge = null;
        if (p.salesCount > 20) badge = { text: "Best Seller", color: "bg-amber-500", icon: "🏆" };
        else if (recentViews > 15) badge = { text: "Hot Choice", color: "bg-orange-600", icon: "🔥" };
        else if (p.source === 'handmade') badge = { text: "Handmade", color: "bg-emerald-600", icon: "🌿" };

        return { ...p, score, recentViews, liveBadge: badge };
    }).sort((a, b) => b.score - a.score);

    res.json(scored);
}));

app.post('/api/products/track-visit', safeQuery(async (req, res) => {
    const yesterday = new Date(Date.now() - 86400000);
    await Product.findByIdAndUpdate(req.body.productId, {
        $push: { views24h: new Date() },
        $pull: { views24h: { $lt: yesterday } }
    });
    res.json({ success: true });
}));

app.get('/api/products/suggestions', safeQuery(async (req, res) => {
    const data = await Product.find({ name: { $regex: req.query.q, $options: 'i' } }).limit(6).select('name category');
    res.json(data);
}));

app.patch('/api/product/set-sale', safeQuery(async (req, res) => {
    const { productId, discountPercentage, onSale } = req.body;
    const product = await Product.findById(productId);
    const salePrice = onSale ? (product.basePrice * (1 - discountPercentage / 100)).toFixed(2) : product.basePrice;
    await Product.findByIdAndUpdate(productId, { onSale, discountPercentage, salePrice });
    res.json({ success: true });
}));

// --- 6. FINTECH SYSTEM (Wallet, Hold & Treasury) 💸 ---
app.get('/api/wallet/:userId', safeQuery(async (req, res) => {
    const user = await User.findById(req.params.userId);
    res.json({ balance: user ? user.walletBalance : 0 });
}));

app.post('/api/wallet/pay', safeQuery(async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Insufficient Funds" });
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    res.json({ message: "Funds Deducted" });
}));

app.post('/api/wallet/withdraw', safeQuery(async (req, res) => {
    const { userId, amount } = req.body;
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    await new Withdrawal({ user: userId, amount, status: 'pending' }).save();
    res.json({ message: "Funds placed on hold for verification." });
}));

app.get(['/api/admin/withdrawals', '/api/admin/treasury'], safeQuery(async (req, res) => {
    const data = await Withdrawal.find().populate('user', 'name email role walletBalance').sort({ createdAt: -1 });
    res.json(data);
}));

app.post('/api/admin/withdrawals/action', safeQuery(async (req, res) => {
    const { id, action } = req.body;
    const request = await Withdrawal.findById(id);
    if (action === 'rejected') {
        await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } });
    }
    request.status = action;
    await request.save();
    res.json({ message: `Transaction ${action}` });
}));

// --- 7. LOGISTICS & ORDER SYSTEM 🛒 ---
app.post(['/api/orders/create', '/api/order/create'], safeQuery(async (req, res) => {
    const newOrder = new Order(req.body);
    await newOrder.save();
    await Product.findByIdAndUpdate(req.body.productId, { $inc: { salesCount: 1 } });
    res.json({ message: "Order Logged", orderId: newOrder._id });
}));

app.get(['/api/orders/supplier/:id', '/api/order/supplier/:id'], safeQuery(async (req, res) => {
    const data = await Order.find({ supplierId: req.params.id }).populate('sellerId', 'name email').populate('productId', 'name').sort({ createdAt: -1 });
    res.json(data);
}));

app.get(['/api/orders/seller/:id', '/api/order/seller/:id'], safeQuery(async (req, res) => {
    const data = await Order.find({ sellerId: req.params.id }).populate('productId', 'name').sort({ createdAt: -1 });
    res.json(data);
}));

app.patch(['/api/orders/status', '/api/order/status'], safeQuery(async (req, res) => {
    await Order.findByIdAndUpdate(req.body.orderId, { status: req.body.status });
    res.json({ message: "Status Synced" });
}));

// --- 8. COMMUNICATION HUB (Real-time Chat) 💬 ---
app.get(['/api/chat/unread/:userId', '/api/chat/unread-count/:userId'], safeQuery(async (req, res) => {
    const chats = await Chat.find({ participants: req.params.userId });
    const chatIds = chats.map(c => c._id);
    const unreadMessages = await Message.find({ chatId: { $in: chatIds }, sender: { $ne: req.params.userId }, status: { $ne: 'seen' } });
    const unreadMap = {};
    unreadMessages.forEach(msg => { unreadMap[msg.chatId] = (unreadMap[msg.chatId] || 0) + 1; });
    res.json({ total: unreadMessages.length, perChat: unreadMap });
}));

app.get('/api/chat/conversations/:userId', safeQuery(async (req, res) => {
    const data = await Chat.find({ participants: req.params.userId }).populate('participants', 'name email role').sort({ lastMessageTime: -1 });
    res.json(data);
}));

app.get('/api/chat/messages/:chatId', safeQuery(async (req, res) => {
    const data = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
    res.json(data);
}));

app.post('/api/chat/upload', upload.single('file'), (req, res) => {
    res.json({ filePath: `http://print-api.129.80.92.53.nip.io/uploads/${req.file.filename}` });
});

// --- 9. MASTER ANALYTICS & SUPPLIER HUB 📊 ---
app.get(['/api/admin/detailed-stats', '/api/admin/analytics'], safeQuery(async (req, res) => {
    const suppliers = await User.countDocuments({ role: 'supplier' });
    const sellers = await User.countDocuments({ role: 'seller' });
    const supplierPerformance = await Order.aggregate([
        { $group: { _id: "$supplierId", totalOrders: { $sum: 1 }, revenue: { $sum: "$totalPrice" } } },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "details" } },
        { $unwind: "$details" }
    ]);
    const revenueTimeline = await Order.aggregate([
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, dailyRevenue: { $sum: "$totalPrice" }, orderCount: { $sum: 1 } } },
        { $sort: { "_id": -1 } }, { $limit: 15 }
    ]);
    res.json({ userStats: { sellers, suppliers }, supplierPerformance, revenueTimeline });
}));

app.get('/api/supplier/stats/:id', safeQuery(async (req, res) => {
    const user = await User.findById(req.params.id);
    const products = await Product.countDocuments({ supplier: req.params.id });
    const orders = await Order.find({ supplierId: req.params.id });
    const withdrawn = await Withdrawal.aggregate([{ $match: { user: new mongoose.Types.ObjectId(req.params.id), status: 'approved' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
    res.json({ products, balance: user?.walletBalance || 0, withdrawn: withdrawn[0]?.total || 0, pendingOrders: orders.filter(o=>o.status==='pending').length });
}));

app.get('/api/supplier/products/:id', safeQuery(async (req, res) => {
    const data = await Product.find({ supplier: req.params.id }).sort({ createdAt: -1 });
    res.json(data);
}));

// --- 10. MASTER ADMIN CONTROLS 👥 ---
app.get('/api/admin/users', safeQuery(async (req, res) => {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    res.json(users);
}));

app.patch('/api/admin/users/status', safeQuery(async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { status: req.body.status });
    res.json({ success: true });
}));

app.post('/api/admin/users/wallet-adjust', safeQuery(async (req, res) => {
    const { userId, amount, action } = req.body;
    const mult = action === 'add' ? 1 : -1;
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: (amount * mult) } });
    res.json({ success: true });
}));

// --- 11. SHOP PROFILE & STOREFRONT 🏬 ---
const profileUpload = upload.fields([{ name: 'profileImage', maxCount: 1 }, { name: 'bannerImage', maxCount: 1 }]);
app.put('/api/shop/update-profile', profileUpload, safeQuery(async (req, res) => {
    const { userId } = req.body;
    const updateData = { ...req.body };
    if (req.files['profileImage']) updateData.profileImage = req.files['profileImage'][0].filename;
    if (req.files['bannerImage']) {
        const user = await User.findById(userId);
        updateData.bannerImages = user.bannerImages ? [...user.bannerImages, req.files['bannerImage'][0].filename] : [req.files['bannerImage'][0].filename];
    }
    await User.findByIdAndUpdate(userId, { $set: updateData });
    res.json({ success: true });
}));

app.get('/api/shop/:id', safeQuery(async (req, res) => {
    const supplier = await User.findById(req.params.id).select('name email storeName createdAt profileImage bannerImages bio announcement'); 
    const products = await Product.find({ supplier: req.params.id, status: 'approved' }).sort({ createdAt: -1 });
    const reviews = await Review.find({ productId: { $in: products.map(p => p._id) } }).populate('userId', 'name');
    res.json({ supplier, products, reviews, totalSales: products.reduce((acc, p) => acc + (p.salesCount || 0), 0) });
}));

// --- 12. SOCKET.IO ENGINE ---
io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));
  
  socket.on('send_message', async (data) => {
    if (data.text && (PHONE_REGEX.test(data.text) || EMAIL_REGEX.test(data.text))) {
        return io.to(data.senderId).emit('error_message', "⚠️ Blocked: Contact sharing forbidden.");
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
    const currentChat = await Chat.findById(data.chatId);
    if(currentChat) {
        const otherUser = currentChat.participants.find(p => p.toString() !== data.userId);
        if(otherUser) io.to(otherUser.toString()).emit('messages_seen', { chatId: data.chatId });
    }
  });
});

// --- 13. SUPPLIER PRODUCT PLUGIN APIs (NEW) 🛠️ ---

app.put('/api/product/update/:id', safeQuery(async (req, res) => {
    const { id } = req.params;
    const updateData = req.body;
    if (updateData.basePrice && updateData.discountPercentage) {
        updateData.salePrice = (updateData.basePrice * (1 - updateData.discountPercentage / 100)).toFixed(2);
    }
    const updatedProduct = await Product.findByIdAndUpdate(id, updateData, { new: true });
    res.json({ message: "Product Optimized!", product: updatedProduct });
}));

app.delete('/api/product/delete/:id', safeQuery(async (req, res) => {
    const { id } = req.params;
    const product = await Product.findById(id);
    if (!product) return res.status(404).send("Asset not found");

    if (product.imagePaths && product.imagePaths.length > 0) {
        product.imagePaths.forEach(imgName => {
            const fullPath = path.join('/app/uploads', imgName);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        });
    }
    if (product.videoPath) {
        const videoPath = path.join('/app/uploads', product.videoPath);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    }
    await Product.findByIdAndDelete(id);
    res.json({ message: "Asset purged from Master Node and 30TB Disk." });
}));

// --- 14. MASTER AUTOMATION ---
app.get('/api/admin/config', async (req, res) => res.json(await getAppConfig()));
app.post('/api/admin/config', async (req, res) => {
    await SystemConfig.findOneAndUpdate({ key: 'main_config' }, req.body, { upsert: true });
    res.json({ success: true });
});

setInterval(async () => {
    const config = await getAppConfig();
    if (!config.quarantineEnabled) return;
    const cutoff = new Date(Date.now() - config.quarantineDuration * 60 * 1000);
    await Product.updateMany({ status: 'pending', createdAt: { $lte: cutoff } }, { $set: { status: 'approved' } });
}, 600000);

const PORT = 80;
server.listen(PORT, () => console.log(`🚀 MASTER NODE v5.2 FULLY OPERATIONAL ON PORT ${PORT}`));