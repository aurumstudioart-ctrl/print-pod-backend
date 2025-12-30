const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const path = require('path');
const multer = require('multer'); 
const fs = require('fs'); 
const sharp = require('sharp'); // Copyright & Image processing
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// --- 1. CONFIGURATION & SECURITY ---
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
    .then(() => console.log("✅ SYSTEM: Master Database Connected"))
    .catch(err => console.error("❌ CRITICAL: DB Connection Error", err));

// --- 2. MODELS LOADING ---
const User = require('./models/User');
const Product = require('./models/Product');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');
const Withdrawal = require('./models/Withdrawal');

// Inline Review Model
const reviewSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    createdAt: { type: Date, default: Date.now }
});
const Review = mongoose.models.Review || mongoose.model('Review', reviewSchema);

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

// --- 4. BASIC ROUTES ---
app.get('/', (req, res) => res.status(200).send('🚀 Master Node Active | v2.1 (Supplier Stats Fixed)'));
app.use('/api/auth', require('./routes/auth'));

// --- 5. PRODUCT ENGINE (Copyright & Upload) ---

app.post('/api/product/add', upload.single('image'), async (req, res) => {
    try {
        const { name, description, basePrice, supplierId, category, tags, variations, source, isPhysical } = req.body;
        if (!req.file) return res.status(400).send("Image required.");

        // Copyright Scan
        const imageBuffer = await sharp(req.file.path).resize(10, 10).grayscale().toBuffer();
        const currentHash = imageBuffer.toString('base64');

        const isDuplicateImage = await Product.findOne({ imageHash: currentHash });
        if (isDuplicateImage) {
            fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: "COPYRIGHT ALERT: Design already exists!" });
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
            status: 'pending',
            salesCount: 0,
            views24h: []
        });

        await newProduct.save();
        res.json({ message: "Product live in 3 hours (Analysis Mode).", productId: newProduct._id });
    } catch (err) { 
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: err.message }); 
    }
});

// --- 6. SMART ALGORITHM & SEARCH ---

app.get('/api/products/search', async (req, res) => {
    const { q, category } = req.query;
    try {
        let query = { status: 'approved' };
        if (q) query.$or = [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }];
        if (category && category !== 'All') query.category = category;

        const products = await Product.find(query).populate('supplier', 'name').lean();
        const now = Date.now();

        const results = products.map(p => {
            const recentViews = (p.views24h || []).filter(v => new Date(v) > (now - 86400000)).length;
            const score = (recentViews * 2) + ((p.salesCount || 0) * 10) + (p.source === 'handmade' ? 50 : 0);
            
            let badge = null;
            if (p.salesCount > 20) badge = { text: "Best Seller", color: "bg-amber-500", icon: "🏆" };
            else if (recentViews > 15) badge = { text: "Hot Choice", color: "bg-orange-600", icon: "🔥" };
            else if (p.source === 'handmade') badge = { text: "Handmade", color: "bg-emerald-600", icon: "🌿" };

            return { ...p, recentViews, score, liveBadge: badge };
        }).sort((a, b) => b.score - a.score);

        if (q && products.length > 0) await Product.findByIdAndUpdate(products[0]._id, { $inc: { searchCount: 1 } });
        res.json(results);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/products/track-visit', async (req, res) => {
    const yesterday = new Date(Date.now() - 86400000);
    await Product.findByIdAndUpdate(req.body.productId, { $push: { views24h: new Date() }, $pull: { views24h: { $lt: yesterday } } });
    res.json({ success: true });
});

app.get('/api/products/suggestions', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    const data = await Product.find({ $or: [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }] })
        .limit(6).select('name category tags');
    res.json(data);
});

// Reviews
app.post('/api/products/review', async (req, res) => {
    try {
        const { productId, userId, rating, comment } = req.body;
        const newReview = new Review({ productId, userId, rating, comment });
        await newReview.save();
        res.json({ message: "Review posted", review: newReview });
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/products/reviews/:id', async (req, res) => {
    const reviews = await Review.find({ productId: req.params.id }).populate('userId', 'name').sort({ createdAt: -1 });
    res.json(reviews);
});

// --- 7. WALLET & FINANCIALS ---

app.get('/api/wallet/:userId', async (req, res) => {
    const user = await User.findById(req.params.userId);
    res.json({ balance: user ? user.walletBalance : 0 });
});

app.post('/api/wallet/withdraw', async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Low Balance" });
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    const newReq = new Withdrawal({ user: userId, amount, status: 'pending' });
    await newReq.save();
    res.json({ message: "Withdrawal Request Sent" });
});

app.post('/api/admin/withdrawals/action', async (req, res) => {
    const { id, action } = req.body;
    const request = await Withdrawal.findById(id);
    if (action === 'rejected') await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } });
    request.status = action;
    await request.save();
    res.json({ message: "Updated" });
});

// --- 8. STATS & ANALYTICS (UPDATED) ---

// 🔥 NEW: ROBUST SUPPLIER STATS (Added Here) 🔥
app.get('/api/supplier/stats/:id', async (req, res) => {
    try {
        const supplierId = req.params.id;

        // Validation Check
        if (!supplierId || supplierId === 'undefined') {
            return res.status(400).json({ error: "Invalid Supplier ID" });
        }

        const prodCount = await Product.countDocuments({ supplier: supplierId });
        const user = await User.findById(supplierId);
        
        const paidOut = await Withdrawal.aggregate([
            { $match: { user: new mongoose.Types.ObjectId(supplierId), status: 'approved' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        
        const pending = await Withdrawal.countDocuments({ user: supplierId, status: 'pending' });

        res.json({ 
            products: prodCount || 0, 
            balance: user ? user.walletBalance : 0, 
            withdrawn: paidOut[0]?.total || 0, 
            pendingRequests: pending || 0 
        });
    } catch (err) { 
        console.error("❌ Supplier Stats Error:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// Admin Stats
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
        res.json({ supplierPerformance, userStats });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 9. ORDER SYSTEM ---

app.post('/api/orders/create', async (req, res) => {
    try {
        const newOrder = new Order(req.body);
        await newOrder.save();
        await Product.findByIdAndUpdate(req.body.productId, { $inc: { salesCount: 1 } });
        res.json({ message: "Order Created", orderId: newOrder._id });
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
    res.json({ message: "Status Synced" });
});

// --- 10. CHAT SYSTEM ---

app.post('/api/chat/upload', chatUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send("File missing");
    res.json({ filePath: `http://print-api.129.80.92.53.nip.io/uploads/${req.file.filename}` });
});

app.get('/api/chat/conversations/:userId', async (req, res) => {
    const data = await Chat.find({ participants: req.params.userId }).populate('participants', 'name email role').sort({ lastMessageTime: -1 });
    res.json(data);
});

app.get('/api/chat/messages/:chatId', async (req, res) => {
    const data = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
    res.json(data);
});

// --- 11. SOCKET.IO ENGINE ---

io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));
  
  socket.on('send_message', async (data) => {
    if (data.text && (PHONE_REGEX.test(data.text) || EMAIL_REGEX.test(data.text))) {
        return io.to(data.senderId).emit('error_message', "⚠️ Security: Contact sharing Blocked.");
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

// --- 12. AUTOMATED WORKER ---
setInterval(async () => {
    const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await Product.updateMany({ status: 'pending', createdAt: { $lte: cutoff } }, { $set: { status: 'approved' } });
}, 600000);

const PORT = 80;
server.listen(PORT, () => console.log(`🚀 Master Server Active on Port ${PORT}`));