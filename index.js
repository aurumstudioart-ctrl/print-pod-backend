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

// SYSTEM CONFIG MODEL
const configSchema = new mongoose.Schema({
    key: { type: String, default: 'main_config' },
    quarantineEnabled: { type: Boolean, default: true },
    quarantineDuration: { type: Number, default: 180 }, // Minutes
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

// --- 2. CONFIGURATION & HELPERS ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const getAppConfig = async () => {
    let config = await SystemConfig.findOne({ key: 'main_config' });
    if (!config) { config = new SystemConfig(); await config.save(); }
    return config;
};

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7 
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ SYSTEM: Master Database Connected"))
    .catch(err => console.error("❌ CRITICAL: DB Connection Error", err));

// --- 3. STORAGE SETUP ---
const uploadDir = '/app/uploads';
const tempDir = 'temp/';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const upload = multer({ dest: tempDir }); 
const chatUpload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => cb(null, `chat-${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
    }) 
});

// --- 4. CORE APIs & CHAT ROUTES ---

app.get('/', (req, res) => res.status(200).send('🚀 POD Master Node Operational'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

app.post('/api/chat/upload', chatUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send("No file uploaded");
    res.json({ filePath: `http://print-api.129.80.92.53.nip.io/uploads/${req.file.filename}` });
});

app.get('/api/chat/conversations/:userId', async (req, res) => {
    try {
        const chats = await Chat.find({ participants: req.params.userId })
            .populate('participants', 'name email role')
            .sort({ lastMessageTime: -1 });
        res.json(chats);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chat/messages/:chatId', async (req, res) => {
    try {
        const messages = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chat/unread/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId || userId === 'undefined') return res.json({ total: 0, perChat: {} });
        const chats = await Chat.find({ participants: userId });
        const chatIds = chats.map(c => c._id);
        const unreadMessages = await Message.find({ chatId: { $in: chatIds }, sender: { $ne: userId }, status: { $ne: 'seen' } });
        const unreadMap = {};
        unreadMessages.forEach(msg => { unreadMap[msg.chatId] = (unreadMap[msg.chatId] || 0) + 1; });
        res.json({ total: unreadMessages.length, perChat: unreadMap });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 5. PRODUCT & SEARCH ENGINE ---

app.post('/api/product/add', upload.single('image'), async (req, res) => {
    try {
        const { name, description, basePrice, supplierId, category, tags, variations, source, isPhysical } = req.body;
        if (!req.file) return res.status(400).send("Image required.");

        const imageBuffer = await sharp(req.file.path).resize(10, 10).grayscale().toBuffer();
        const currentHash = imageBuffer.toString('base64');

        const isDuplicate = await Product.findOne({ imageHash: currentHash });
        if (isDuplicate) {
            fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: "Copyright Alert: design already exists" });
        }

        const finalFileName = `prod-${Date.now()}.png`;
        fs.renameSync(req.file.path, path.join(uploadDir, finalFileName));

        const newProduct = new Product({
            name, description, basePrice, category,
            supplier: supplierId,
            imagePath: finalFileName,
            tags: tags ? tags.split(',').map(t => t.trim()) : [],
            variations: variations ? JSON.parse(variations) : [],
            source: source || 'handmade',
            isPhysical: isPhysical === 'true',
            imageHash: currentHash,
            status: 'pending'
        });

        await newProduct.save();
        res.json({ message: "Scan initiated." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products/search', async (req, res) => {
    const { q, category } = req.query;
    try {
        let query = { status: 'approved' };
        if (q) query.$or = [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }];
        if (category && category !== 'All') query.category = category;

        const products = await Product.find(query).populate('supplier', 'name').lean();
        const results = products.map(p => {
            const now = Date.now();
            const recentViews = (p.views24h || []).filter(v => new Date(v) > (now - 86400000)).length;
            const score = (recentViews * 2) + ((p.salesCount || 0) * 10) + (p.source === 'handmade' ? 50 : 0);
            let badge = null;
            if (p.salesCount > 20) badge = { text: "Best Seller", color: "bg-amber-500" };
            else if (recentViews > 15) badge = { text: "Hot Choice", color: "bg-orange-600" };
            else if (p.source === 'handmade') badge = { text: "Handmade", color: "bg-emerald-600" };
            return { ...p, recentViews, score, liveBadge: badge };
        }).sort((a, b) => b.score - a.score);
        res.json(results);
    } catch (err) { res.status(500).send(err.message); }
});

// --- 6. WALLET & WITHDRAWAL ---

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
    await User.findByIdAndUpdate(req.body.userId, { $inc: { walletBalance: -req.body.amount } });
    const newReq = new Withdrawal({ user: req.body.userId, amount: req.body.amount, status: 'pending' });
    await newReq.save();
    res.json({ message: "Request Sent" });
});

app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const data = await Withdrawal.find().populate('user', 'name email role walletBalance').sort({ createdAt: -1 });
        res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 7. ORDERS & ANALYTICS ---

app.post('/api/orders/create', async (req, res) => {
    try {
        const newOrder = new Order(req.body);
        await newOrder.save();
        await Product.findByIdAndUpdate(req.body.productId, { $inc: { salesCount: 1 } });
        res.json({ message: "Order Created", orderId: newOrder._id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🛡️ ADMIN DETAILED STATS (Revenue Timeline + Supplier Performance)
app.get('/api/admin/detailed-stats', async (req, res) => {
    try {
        // 1. Supplier Performance
        const supplierPerformance = await Order.aggregate([
            {
                $group: {
                    _id: "$supplierId",
                    totalOrders: { $sum: 1 },
                    revenue: { $sum: "$totalPrice" },
                    pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
                    shipped: { $sum: { $cond: [{ $eq: ["$status", "shipped"] }, 1, 0] } }
                }
            },
            {
                $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "details" }
            },
            { $unwind: "$details" }
        ]);

        // 2. Revenue Timeline (Last 30 Days)
        const revenueTimeline = await Order.aggregate([
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                    dailyRevenue: { $sum: "$totalPrice" },
                    orderCount: { $sum: 1 }
                }
            },
            { $sort: { "_id": 1 } },
            { $limit: 30 }
        ]);

        // 3. Simple User Counts
        const userStats = {
            sellers: await User.countDocuments({ role: 'seller' }),
            suppliers: await User.countDocuments({ role: 'supplier' })
        };

        res.json({ supplierPerformance, revenueTimeline, userStats });
    } catch (err) {
        console.error("❌ Detailed Stats API Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    const sellers = await User.countDocuments({ role: 'seller' });
    const suppliers = await User.countDocuments({ role: 'supplier' });
    const pending = await Withdrawal.countDocuments({ status: 'pending' });
    const payouts = await Withdrawal.aggregate([{ $match: { status: 'approved' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
    res.json({ sellers, suppliers, pending, payouts: payouts[0]?.total || 0 });
});

// --- 8. MASTER ADMIN CONTROLS ---

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}).select('-password').sort({ createdAt: -1 });
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/users/status', async (req, res) => {
    try {
        const { userId, status } = req.body;
        await User.findByIdAndUpdate(userId, { status });
        res.json({ message: `User status updated to ${status}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/wallet-adjust', async (req, res) => {
    try {
        const { userId, amount, action } = req.body;
        const multiplier = action === 'add' ? 1 : -1;
        await User.findByIdAndUpdate(userId, { $inc: { walletBalance: (amount * multiplier) } });
        res.json({ message: "Wallet adjusted successfully" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/orders-all', async (req, res) => {
    try {
        const orders = await Order.find({})
            .populate('sellerId', 'name')
            .populate('supplierId', 'name')
            .populate('productId', 'name')
            .sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 9. SYSTEM SETTINGS ---

app.get('/api/admin/config', async (req, res) => {
    try {
        const config = await getAppConfig();
        res.json(config);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/config', async (req, res) => {
    try {
        const { quarantineEnabled, quarantineDuration } = req.body;
        const config = await SystemConfig.findOneAndUpdate(
            { key: 'main_config' }, 
            { quarantineEnabled, quarantineDuration },
            { new: true, upsert: true }
        );
        res.json({ message: "System configuration updated!", config });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 10. SOCKET.IO & AUTOMATION ---

io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));
  socket.on('send_message', async (data) => {
    if (data.text && (PHONE_REGEX.test(data.text) || EMAIL_REGEX.test(data.text))) return io.to(data.senderId).emit('error_message', "⚠️ Security: contact info sharing blocked.");
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

setInterval(async () => {
    const config = await getAppConfig();
    if (!config.quarantineEnabled) return;
    const cutoff = new Date(Date.now() - config.quarantineDuration * 60 * 1000);
    await Product.updateMany({ status: 'pending', createdAt: { $lte: cutoff } }, { $set: { status: 'approved' } });
}, 600000);

const PORT = 80;
server.listen(PORT, () => console.log(`🚀 Node operational on Port ${PORT}`));