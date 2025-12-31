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

// --- 1. MODELS LOADING ---
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
    quarantineDuration: { type: Number, default: 180 }, 
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
  maxHttpBufferSize: 5e7 
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
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

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

// --- 3. CORE APIs ---
app.get('/', (req, res) => res.status(200).send('🚀 POD Master Node Active | v3.0 Secured ✅'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// --- 4. ADVANCED PRODUCT ENGINE (Neural Scan) ---
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

// --- 5. SALE & DISCOUNT ENGINE ---
app.patch('/api/product/set-sale', async (req, res) => {
    const { productId, discountPercentage, onSale } = req.body;
    try {
        const product = await Product.findById(productId);
        if (!product) return res.status(404).send("Product not found");

        const salePrice = onSale 
            ? (product.basePrice * (1 - discountPercentage / 100)).toFixed(2) 
            : product.basePrice;
        
        await Product.findByIdAndUpdate(productId, { 
            onSale, 
            discountPercentage, 
            salePrice 
        });
        res.json({ message: "Sale status updated!", salePrice });
    } catch (err) { res.status(500).send(err.message); }
});

// --- 6. SMART SEARCH ENGINE ---
app.get('/api/products/search', async (req, res) => {
    const { q, category } = req.query;
    try {
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

// --- 7. WALLET & WITHDRAWAL ---
app.get('/api/wallet/:userId', async (req, res) => {
    const user = await User.findById(req.params.userId);
    res.json({ balance: user ? user.walletBalance : 0 });
});

app.post('/api/wallet/withdraw', async (req, res) => {
    const user = await User.findById(req.body.userId);
    if (!user || user.walletBalance < req.body.amount) return res.status(400).json({ message: "Low Balance" });
    await User.findByIdAndUpdate(req.body.userId, { $inc: { walletBalance: -req.body.amount } }); 
    const newReq = new Withdrawal({ user: req.body.userId, amount: req.body.amount, status: 'pending' });
    await newReq.save();
    res.json({ message: "Request Sent" });
});

// --- 8. ORDER SYSTEM ---
app.post('/api/orders/create', async (req, res) => {
    try {
        const newOrder = new Order(req.body);
        await newOrder.save();
        await Product.findByIdAndUpdate(req.body.productId, { $inc: { salesCount: 1 } });
        res.json({ message: "Order Success", orderId: newOrder._id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 9. CHAT SYSTEM ---
app.get('/api/chat/unread/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const chats = await Chat.find({ participants: userId });
        const unread = await Message.find({ chatId: { $in: chats.map(c => c._id) }, sender: { $ne: userId }, status: { $ne: 'seen' } });
        res.json({ total: unread.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
    const newMessage = new Message({ ...data, chatId: chat._id, status: 'delivered' }); await newMessage.save();
    io.to(data.receiverId).emit('receive_message', newMessage);
  });
});

// --- 11. SUPPLIER STOREFRONT & PROFILE UPDATE ---

// Multer setup specifically for profile/banner images
const profileUpload = upload.fields([
    { name: 'profileImage', maxCount: 1 },
    { name: 'bannerImage', maxCount: 1 }
]);

app.put('/api/shop/update-profile', profileUpload, async (req, res) => {
    try {
        const { userId, storeName, bio, announcement } = req.body;
        const updateData = {};
        
        if (storeName) updateData.storeName = storeName;
        if (bio) updateData.bio = bio;
        if (announcement) updateData.announcement = announcement;
        
        // Handling file uploads for profile and banner
        if (req.files && req.files['profileImage']) {
            updateData.profileImage = req.files['profileImage'][0].filename;
        }
        if (req.files && req.files['bannerImage']) {
            updateData.bannerImage = req.files['bannerImage'][0].filename;
        }

        const updatedUser = await User.findByIdAndUpdate(userId, updateData, { new: true });
        res.json({ message: "Profile Updated! 🚀", user: updatedUser });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/shop/:id', async (req, res) => {
    try {
        const supplierId = req.params.id;
        if (!mongoose.Types.ObjectId.isValid(supplierId)) return res.status(400).send("Invalid ID");
        const supplier = await User.findById(supplierId).select('name email storeName createdAt bio announcement profileImage bannerImage');
        const products = await Product.find({ supplier: supplierId, status: 'approved' }).sort({ createdAt: -1 });
        const reviews = await Review.find({ productId: { $in: products.map(p => p._id) } }).populate('userId', 'name').sort({ createdAt: -1 });
        res.json({ supplier, products, reviews, totalSales: products.reduce((acc, p) => acc + (p.salesCount || 0), 0) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 12. SUPPLIER PRODUCT MANAGEMENT ---
app.get('/api/supplier/products/:id', async (req, res) => {
    try {
        const products = await Product.find({ supplier: req.params.id }).sort({ createdAt: -1 });
        res.json(products);
    } catch (err) { res.status(500).send(err.message); }
});

// --- 13. AUTOMATION & ADMIN ---
setInterval(async () => {
    const config = await getAppConfig();
    if (!config.quarantineEnabled) return;
    const cutoff = new Date(Date.now() - config.quarantineDuration * 60 * 1000);
    await Product.updateMany({ status: 'pending', createdAt: { $lte: cutoff } }, { $set: { status: 'approved' } });
}, 600000);

app.get('/api/admin/config', async (req, res) => res.json(await getAppConfig()));
app.post('/api/admin/config', async (req, res) => {
    await SystemConfig.findOneAndUpdate({ key: 'main_config' }, req.body, { upsert: true });
    res.json({ message: "Synced" });
});

const PORT = 80;
server.listen(PORT, () => console.log(`🚀 Master Node operational on Port ${PORT}`));