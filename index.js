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

// --- 1. DATABASE MODELS ---

// PRODUCT MODEL (Updated for Multiple Images)
const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    basePrice: Number,
    imagePaths: [String], // Array for multiple images
    videoPath: String,    // Single video path
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    category: String,
    tags: [String],
    variations: [{ type: Object }], 
    source: { type: String, default: 'handmade' },
    isPhysical: { type: Boolean, default: false },
    imageHash: { type: String, unique: true }, 
    salesCount: { type: Number, default: 0 },
    views24h: [{ type: Date }],
    status: { type: String, default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
const Product = mongoose.models.Product || mongoose.model('Product', productSchema);

// SYSTEM CONFIG MODEL
const configSchema = new mongoose.Schema({
    key: { type: String, default: 'main_config' },
    quarantineEnabled: { type: Boolean, default: true },
    quarantineDuration: { type: Number, default: 180 }, // In minutes
});
const SystemConfig = mongoose.models.SystemConfig || mongoose.model('SystemConfig', configSchema);

// Models for other features
const User = require('./models/User');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');

// --- 2. CONFIGURATION & MULTER SETUP ---

const uploadDir = '/app/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

const productAssets = upload.fields([
    { name: 'images', maxCount: 12 },
    { name: 'video', maxCount: 1 }
]);

const getAppConfig = async () => {
    let config = await SystemConfig.findOne({ key: 'main_config' });
    if (!config) { config = new SystemConfig(); await config.save(); }
    return config;
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(uploadDir));

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// DB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ SYSTEM: Master Database Connected"))
    .catch(err => console.error("❌ CRITICAL: DB Connection Error", err));

// --- 3. PRODUCT ENGINE (UPLOAD & SECURITY) ---

app.post('/api/product/add', productAssets, async (req, res) => {
    try {
        const { name, description, basePrice, supplierId, category, tags, variations, source, isPhysical } = req.body;

        if (!req.files || !req.files['images']) {
            return res.status(400).json({ error: "Media Missing", guide: "Upload at least 1 image." });
        }

        // 🛡️ COPYRIGHT NEURAL SCAN (Using First Image)
        const primaryImg = req.files['images'][0];
        const imageBuffer = await sharp(primaryImg.path).resize(10, 10).grayscale().toBuffer();
        const currentHash = imageBuffer.toString('base64');

        const duplicate = await Product.findOne({ imageHash: currentHash });
        if (duplicate) {
            // Delete all uploaded files if duplicate found
            Object.values(req.files).flat().forEach(f => fs.unlinkSync(f.path));
            return res.status(403).json({ error: "Security Alert", guide: "Design already exists in Master Node." });
        }

        // Map paths for database
        const savedImages = req.files['images'].map(f => f.filename);
        const savedVideo = req.files['video'] ? req.files['video'][0].filename : null;

        const config = await getAppConfig();

        const newProduct = new Product({
            name, 
            description, 
            basePrice, 
            category,
            supplier: supplierId,
            imagePaths: savedImages,
            videoPath: savedVideo,
            tags: tags ? tags.split(',').map(t => t.trim()) : [],
            variations: variations ? JSON.parse(variations) : [],
            source: source || 'handmade',
            isPhysical: isPhysical === 'true',
            imageHash: currentHash,
            status: config.quarantineEnabled ? 'pending' : 'approved'
        });

        await newProduct.save();
        res.json({ 
            message: config.quarantineEnabled ? "Neural Scan Passed. Quarantine active (3h)." : "Product Live! 🚀",
            productId: newProduct._id 
        });

    } catch (err) { 
        // Cleanup on error
        if (req.files) {
            Object.values(req.files).flat().forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path) });
        }
        res.status(500).json({ error: "Internal Error", details: err.message }); 
    }
});

// Smart Search (Updated for imagePaths array)
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
            const score = (recentViews * 2) + ((p.salesCount || 0) * 10) + (p.source === 'handmade' ? 100 : 0);
            return { 
                ...p, 
                recentViews, 
                score, 
                thumbnail: p.imagePaths && p.imagePaths.length > 0 ? p.imagePaths[0] : null 
            };
        }).sort((a, b) => b.score - a.score);
        res.json(results);
    } catch (err) { res.status(500).send(err.message); }
});

// --- 4. ORDER & ADMIN MODULES ---

app.get('/api/orders/supplier/:id', async (req, res) => {
    try {
        const orders = await Order.find({ supplierId: req.params.id })
            .populate('sellerId', 'name email')
            .populate('productId', 'name')
            .sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders/create', async (req, res) => {
    try {
        const newOrder = new Order(req.body);
        await newOrder.save();
        await Product.findByIdAndUpdate(req.body.productId, { $inc: { salesCount: 1 } });
        res.json({ message: "Order Created", orderId: newOrder._id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin Stats
app.get('/api/admin/detailed-stats', async (req, res) => {
    try {
        const supplierPerformance = await Order.aggregate([
            { $group: { _id: "$supplierId", totalOrders: { $sum: 1 }, revenue: { $sum: "$totalPrice" } } },
            { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "details" } }, 
            { $unwind: "$details" }
        ]);
        res.json({ supplierPerformance });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 5. CHAT & SOCKET.IO ---

const chatUpload = multer({ storage: storage });
app.post('/api/chat/upload', chatUpload.single('file'), (req, res) => {
    res.json({ filePath: `http://${req.headers.host}/uploads/${req.file.filename}` });
});

io.on('connection', (socket) => {
    socket.on('join_room', (userId) => socket.join(userId));
    socket.on('send_message', async (data) => {
        // Simple filter for contact info
        const filter = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        if (data.text && filter.test(data.text)) {
            return io.to(data.senderId).emit('error_message', "⚠️ Security: Info sharing blocked.");
        }

        let chat = await Chat.findOne({ participants: { $all: [data.senderId, data.receiverId] } });
        if (!chat) { chat = new Chat({ participants: [data.senderId, data.receiverId] }); await chat.save(); }
        
        const newMessage = new Message({ ...data, chatId: chat._id });
        await newMessage.save();

        io.to(data.receiverId).emit('receive_message', newMessage);
    });
});

// --- 6. AUTOMATION ---

setInterval(async () => {
    const config = await getAppConfig();
    if (!config.quarantineEnabled) return;
    const cutoff = new Date(Date.now() - config.quarantineDuration * 60 * 1000);
    await Product.updateMany(
        { status: 'pending', createdAt: { $lte: cutoff } }, 
        { $set: { status: 'approved' } }
    );
}, 600000); // 10 minutes check

const PORT = process.env.PORT || 80;
server.listen(PORT, () => console.log(`🚀 POD Master Node operational on Port ${PORT}`));