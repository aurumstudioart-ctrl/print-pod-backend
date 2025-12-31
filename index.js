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

// Inline Schemas for System Stability
const configSchema = new mongoose.Schema({
    key: { type: String, default: 'main_config' },
    quarantineEnabled: { type: Boolean, default: true },
    quarantineDuration: { type: Number, default: 180 }, 
});
const SystemConfig = mongoose.models.SystemConfig || mongoose.model('SystemConfig', configSchema);

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
  maxHttpBufferSize: 5e7 
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ SYSTEM: Master Database Connected & Verified"));

const getAppConfig = async () => {
    let config = await SystemConfig.findOne({ key: 'main_config' });
    if (!config) { config = new SystemConfig(); await config.save(); }
    return config;
};

// --- 3. STORAGE SETUP ---
const uploadDir = '/app/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir), 
  filename: (req, file, cb) => cb(null, `pod-${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
});
const upload = multer({ storage });

// Multi-purpose upload handlers
const productAssets = upload.fields([{ name: 'images', maxCount: 12 }, { name: 'video', maxCount: 1 }]);
const profileUpload = upload.fields([{ name: 'profileImage', maxCount: 1 }, { name: 'bannerImage', maxCount: 1 }]);

// --- 4. CORE APIs & DASHBOARD STATS ---

app.get('/', (req, res) => res.status(200).send('🚀 POD Master Node Operational | v3.1 Secured ✅'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// FIXED SUPPLIER STATS (Prevent Dashboard Crash)
app.get('/api/supplier/stats/:id', async (req, res) => {
    try {
        const supplierId = req.params.id;
        if (!supplierId || supplierId === 'undefined') return res.status(400).send("ID missing");

        const products = await Product.countDocuments({ supplier: supplierId });
        const user = await User.findById(supplierId);
        
        // Approved Payouts Calculation
        const approvedWithdrawals = await Withdrawal.aggregate([
            { $match: { user: new mongoose.Types.ObjectId(supplierId), status: 'approved' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        
        const pendingWithdrawalsCount = await Withdrawal.countDocuments({ user: supplierId, status: 'pending' });

        res.json({ 
            products, 
            balance: user?.walletBalance || 0, 
            withdrawn: approvedWithdrawals[0]?.total || 0, 
            pendingRequests: pendingWithdrawalsCount 
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 5. CHAT ENGINE (With Unread Logic) ---

app.get('/api/chat/unread/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId || userId === 'undefined') return res.json({ total: 0, perChat: {} });

        const chats = await Chat.find({ participants: userId });
        const chatIds = chats.map(c => c._id);
        const unreadMessages = await Message.find({ chatId: { $in: chatIds }, sender: { $ne: userId }, status: { $ne: 'seen' } });

        const unreadMap = {};
        unreadMessages.forEach(msg => {
            const cId = msg.chatId.toString();
            unreadMap[cId] = (unreadMap[cId] || 0) + 1;
        });
        res.json({ total: unreadMessages.length, perChat: unreadMap });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chat/conversations/:userId', async (req, res) => {
    try {
        const data = await Chat.find({ participants: req.params.userId }).populate('participants', 'name email role').sort({ lastMessageTime: -1 });
        res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chat/messages/:chatId', async (req, res) => {
    try {
        const data = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
        res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 6. ADVANCED PRODUCT ENGINE (Neural Scan & Discount) ---

app.post('/api/product/add', productAssets, async (req, res) => {
    try {
        const { name, description, basePrice, supplierId, category, tags, variations, source, isPhysical } = req.body;
        const primaryImg = req.files['images'][0];
        const imageBuffer = await sharp(primaryImg.path).resize(10, 10).grayscale().toBuffer();
        const currentHash = imageBuffer.toString('base64');

        if (await Product.findOne({ imageHash: currentHash })) {
            return res.status(403).json({ error: "Copyright Alert: Duplicate Design Found." });
        }

        const config = await getAppConfig();
        const newProduct = new Product({
            name, description, basePrice, category, supplier: supplierId,
            imagePaths: req.files['images'].map(f => f.filename),
            imageHash: currentHash, status: config.quarantineEnabled ? 'pending' : 'approved'
        });
        await newProduct.save();
        res.json({ message: "Neural Scan Passed!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/product/set-sale', async (req, res) => {
    const { productId, discountPercentage, onSale } = req.body;
    try {
        const product = await Product.findById(productId);
        const salePrice = onSale ? (product.basePrice * (1 - discountPercentage / 100)).toFixed(2) : product.basePrice;
        await Product.findByIdAndUpdate(productId, { onSale, discountPercentage, salePrice });
        res.json({ message: "Sale status synced!" });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 7. SHOP PROFILE & BANNER SLIDER LOGIC ---

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
        const updated = await User.findByIdAndUpdate(userId, { $set: updateData }, { new: true });
        res.json({ message: "Cloud Sync Successful 🚀", user: updated });
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
        const products = await Product.find({ supplier: req.params.id, status: 'approved' });
        res.json({ supplier, products, totalSales: products.reduce((acc, p) => acc + (p.salesCount || 0), 0) });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 8. WALLET & ORDERS ---

app.get('/api/wallet/:userId', async (req, res) => {
    const user = await User.findById(req.params.userId);
    res.json({ balance: user?.walletBalance || 0 });
});

app.get('/api/orders/supplier/:id', async (req, res) => {
    try {
        const data = await Order.find({ supplierId: req.params.id }).populate('sellerId', 'name email').populate('productId', 'name').sort({ createdAt: -1 });
        res.json(data);
    } catch (err) { res.status(500).send(err.message); }
});

// --- 9. SOCKET LOGIC (Security & Notifications) ---
io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));
  socket.on('send_message', async (data) => {
    if (data.text && (PHONE_REGEX.test(data.text) || EMAIL_REGEX.test(data.text))) {
        return io.to(data.senderId).emit('error_message', "⚠️ Security Blocked: Contact sharing forbidden.");
    }
    let chat = await Chat.findOne({ participants: { $all: [data.senderId, data.receiverId] } });
    if (!chat) { chat = new Chat({ participants: [data.senderId, data.receiverId] }); await chat.save(); }
    const newMessage = new Message({ ...data, chatId: chat._id, status: 'delivered' }); await newMessage.save();
    io.to(data.receiverId).emit('receive_message', newMessage);
    io.to(data.receiverId).emit('notification', { from: data.senderId, chatId: chat._id });
  });
});

// --- 10. AUTOMATION & ADMIN ---
setInterval(async () => {
    const config = await getAppConfig();
    if (!config.quarantineEnabled) return;
    const cutoff = new Date(Date.now() - config.quarantineDuration * 60 * 1000);
    await Product.updateMany({ status: 'pending', createdAt: { $lte: cutoff } }, { $set: { status: 'approved' } });
}, 600000);

const PORT = 80;
server.listen(PORT, () => console.log(`🚀 Master Node fully operational on Port ${PORT}`));