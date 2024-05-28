const mongoose = require("mongoose");

// Define medicine schema
const medicineSchema = new mongoose.Schema({
  brand_name: { type: String, required: true },
  brand_id: { type: Number, required: true },
  form: { type: String, required: true },
  generic_id: { type: String, required: true },
  packsize: { type: String, required: true },
  price: { type: String, required: true },
  strength: { type: String, required: true },
});

// Create indexes
medicineSchema.index({ brand_name: "text" });
medicineSchema.index({ generic_id: 1 }); // Add index for generic_id

module.exports = medicineSchema;
