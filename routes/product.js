const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const Product = require('../models/Product');
const fs = require('fs');

// --- STORAGE ENGINE (30TB DISK SETUP) ---
// Hum files ko '/app/uploads' mein save karenge jo CapRover ke zariye 30TB disk se juda hoga
const uploadDir = '/app/uploads'; 

// Agar folder nahi hai to bana lo (Safety check)
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir); // File yahan jayegi
    },
    filename: function (req, file, cb) {
        // File ka naam unique banayenge: product-TIMESTAMP.png
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'product-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// --- API 1: ADD PRODUCT (Supplier Only) ---
// Note: 'image' wo field name hai jo frontend se aayega
router.post('/add', upload.single('image'), async (req, res) => {
    try {
        console.log("📦 Product Upload Request Received");
        console.log("File:", req.file);
        console.log("Body:", req.body);

        if (!req.file) {
            return res.status(400).json({ message: "Please upload an image" });
        }

        const { name, description, basePrice, supplierId } = req.body;

        // Database mein entry
        const newProduct = new Product({
            name,
            description,
            basePrice,
            imagePath: req.file.filename, // Sirf naam save karenge, poora path nahi
            supplier: supplierId
        });

        await newProduct.save();
        res.status(201).json({ message: "Product uploaded successfully!", product: newProduct });

    } catch (err) {
        console.error("❌ Product Upload Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- API 2: GET ALL PRODUCTS (Sellers ke liye) ---
router.get('/all', async (req, res) => {
    try {
        const products = await Product.find();
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;