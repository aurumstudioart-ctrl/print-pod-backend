const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const Product = require('../models/Product');
const Design = require('../models/Design'); // Naya Model Import
const fs = require('fs');

const uploadDir = '/app/uploads'; 

if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'product-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// API 1: Khali Product add karna (Supplier)
router.post('/add', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "Please upload an image" });
        const { name, description, basePrice, supplierId } = req.body;
        const newProduct = new Product({
            name, description, basePrice,
            imagePath: req.file.filename,
            supplier: supplierId
        });
        await newProduct.save();
        res.status(201).json({ message: "Product uploaded!", product: newProduct });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API 2: Saare Products dikhana
router.get('/all', async (req, res) => {
    try {
        const products = await Product.find();
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API 3: FINAL DESIGN SAVE KARNA (Seller)
router.post('/save-design', async (req, res) => {
    try {
        const { sellerId, baseProductId, title, sellingPrice, designData, previewImage } = req.body;

        // Base64 image ko file mein save karna (30TB Disk)
        const base64Data = previewImage.replace(/^data:image\/png;base64,/, "");
        const fileName = `final-design-${Date.now()}.png`;
        const filePath = path.join(uploadDir, fileName);

        fs.writeFileSync(filePath, base64Data, 'base64');

        const newDesign = new Design({
            seller: sellerId,
            baseProduct: baseProductId,
            title: title,
            sellingPrice: sellingPrice,
            finalImage: fileName, // File ka naam
            designJSON: designData  // Canvas ka data
        });

        await newDesign.save();
        res.status(201).json({ message: "Design Saved Successfully! 🚀" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;