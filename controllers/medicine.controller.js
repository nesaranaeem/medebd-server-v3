const Medicine = require("../models/Medicine");
const MedicineCompanyName = require("../models/MedicineCompany");
const MedicineGeneric = require("../models/MedicineGeneric");

const getAllMedicine = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 10;

    // Set maximum limit to 2000 if mode is 'sitemap'
    if (req.query.mode === "sitemap") {
      limit = Math.min(limit, 2000);
    } else if (limit > 20) {
      limit = 10;
    }

    const skip = (page - 1) * limit;
    const medicineName = req.query.medicineName;
    const genericId = req.query.genericId;

    let filter = {};
    const keywordConditions = [];

    if (medicineName) {
      keywordConditions.push({
        $text: { $search: medicineName },
      });
    }

    if (genericId) {
      keywordConditions.push({ generic_id: genericId });
    }

    if (keywordConditions.length > 0) {
      filter = { $and: keywordConditions };
    }

    // Check for exact matches first
    let totalCount = await Medicine.countDocuments(filter);
    let data = [];

    if (totalCount > 0) {
      data = await Medicine.aggregate([
        {
          $match: filter,
        },
        {
          $addFields: {
            matchScore: { $meta: "textScore" },
          },
        },
        {
          $sort: { matchScore: -1 },
        },
        {
          $skip: skip,
        },
        {
          $limit: limit,
        },
      ]).exec();
    } else if (medicineName) {
      // If no exact matches, use regex for partial matches
      const regexFilter = {
        $or: [
          { brand_name: { $regex: `^${medicineName}`, $options: "i" } }, // Prefix match
          { brand_name: { $regex: new RegExp(medicineName, "i") } }, // Anywhere match
        ],
      };
      if (genericId) {
        regexFilter.generic_id = genericId;
      }

      totalCount = await Medicine.countDocuments(regexFilter);
      data = await Medicine.aggregate([
        { $match: regexFilter },
        {
          $addFields: {
            matchScore: {
              $cond: [
                {
                  $regexMatch: {
                    input: "$brand_name",
                    regex: `^${medicineName}`,
                    options: "i",
                  },
                }, // Prefix match
                10,
                {
                  $cond: [
                    {
                      $regexMatch: {
                        input: "$brand_name",
                        regex: new RegExp(medicineName, "i"),
                      },
                    },
                    5,
                    0,
                  ],
                }, // Anywhere match
              ],
            },
          },
        },
        { $sort: { matchScore: -1 } },
        { $skip: skip },
        { $limit: limit },
      ]).exec();
    }

    const dataWithDetails = await Promise.all(
      data.map(async (item) => {
        const { company_id, generic_id } = item;

        const companyDetails = await MedicineCompanyName.findOne({ company_id })
          .lean()
          .exec();

        let genericDetails = null;
        if (generic_id) {
          const intGenericId = parseInt(generic_id, 10);
          genericDetails = await MedicineGeneric.findOne({
            generic_id: intGenericId,
          })
            .lean()
            .exec();

          if (genericDetails) {
            Object.keys(genericDetails).forEach((key) => {
              if (typeof genericDetails[key] === "string") {
                genericDetails[key] = genericDetails[key]
                  .replace(/\s+/g, " ")
                  .trim();
              }
            });
          }
        }

        return {
          ...item,
          company_name: companyDetails?.company_name,
          generic_details: genericDetails ? [genericDetails] : [],
        };
      })
    );

    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      status: true,
      details: dataWithDetails,
      total_count: totalCount,
      total_pages: totalPages,
      current_page: page,
    });
  } catch (error) {
    res.status(500).json({ status: false, message: error.message });
  }
};
const searchMedicine = async (req, res) => {
  /*
  Author: Nesar Ahmed Naeem
  Sample API call:
  GET http://localhost:5000/api/v2/medicine/search?symptom=allergy&page=1&limit=10
  This call will fetch medicines whose "indication" contains "allergy" (case-insensitive)
  It will return 10 results per page, and the first page of results will be shown.
  */

  // Get the page number and limit from query parameters, with default values if not provided
  const page = parseInt(req.query.page) || 1;
  let limit = parseInt(req.query.limit) || 10;
  if (limit > 20) {
    limit = 10;
  }
  // Calculate the number of documents to skip based on the current page and limit
  const skip = (page - 1) * limit;

  // Get the symptom parameter from the query
  const symptom = req.query.symptom;

  // Create a filter object to be used in the MongoDB query
  let filter = {};
  if (symptom) {
    // If symptom is provided, use a regex to match case-insensitive indications containing the symptom
    filter["indication"] = { $regex: new RegExp(symptom, "i") };
  }

  // Count the total number of documents that match the filter
  const totalCount = await MedicineGeneric.countDocuments(filter);

  // Use the MongoDB aggregate pipeline to fetch data and add a matchScore field based on indication
  const data = await MedicineGeneric.aggregate([
    {
      $match: filter,
    },
    {
      $addFields: {
        matchScore: {
          $cond: {
            if: { $isArray: "$indication" },
            then: { $size: "$indication" },
            else: 0,
          },
        },
      },
    },
    {
      $sort: { matchScore: -1 },
    },
    {
      $skip: skip,
    },
    {
      $limit: limit,
    },
  ]).exec();

  // Fetch additional data from "Medicine" and "MedicineCompanyName" collections
  const dataWithDetails = await Promise.all(
    data.map(async (item) => {
      const { generic_id } = item;

      // Find medicine based on generic_id
      const medicineDetails = await Medicine.findOne({ generic_id })
        .lean()
        .exec();

      // Find company details based on company_id
      const companyDetails = await MedicineCompanyName.findOne({
        company_id: medicineDetails.company_id,
      })
        .lean()
        .exec();

      const genericDetails = {
        ...item,
      };

      if (genericDetails) {
        // Format the data inside the genericDetails object
        Object.keys(genericDetails).forEach((key) => {
          if (typeof genericDetails[key] === "string") {
            genericDetails[key] = genericDetails[key]
              .replace(/\s+/g, " ")
              .trim();
          }
        });
      }

      return {
        ...medicineDetails,
        company_name: companyDetails?.company_name,
        generic_details: [genericDetails],
      };
    })
  );

  // Calculate total number of pages for the original data
  const totalPages = Math.ceil(totalCount / limit);

  // Send the JSON response containing the data, total count, and pagination details
  res.json({
    status: true,
    details: dataWithDetails,
    total_count: totalCount,
    total_pages: totalPages,
    current_page: page,
  });
};

const displayGeneric = async (req, res) => {
  /* 
  Author: Nesar Ahmed Naeem
  Sample API call:
  Endpoint: http://localhost:5000/api/v2/medicine/generic?limit=5&page=2&search=keyword
  */
  // Get the page number, limit, and search keyword from query parameters, with default values if not provided
  const page = parseInt(req.query.page) || 1;
  let limit = parseInt(req.query.limit) || 10;
  if (limit > 20) {
    limit = 10;
  }
  const searchKeyword = req.query.search || ""; // Get the search keyword

  // Calculate the number of documents to skip based on the current page and limit
  const skip = (page - 1) * limit;

  // Build a query to search for the generic_name field with the provided search keyword
  const searchQuery = {
    generic_name: { $regex: searchKeyword, $options: "i" }, // Case-insensitive search
  };

  // Fetch matching objects from MedicineGeneric model based on the search query
  const data = await MedicineGeneric.find(searchQuery)
    .select("_id generic_name generic_name_bangla generic_id")
    .exec();

  // Count the total number of matching documents
  const totalCount = data.length;

  // Calculate the total number of pages for the matching data
  const totalPages = Math.ceil(totalCount / limit);

  // Apply pagination to the matching data
  const paginatedData = data.slice(skip, skip + limit);

  // Format the matching data for the response
  const formattedData = paginatedData.map((item) => ({
    _id: item._id,
    generic_id: item.generic_id,
    generic_name: item.generic_name,
    generic_name_bangla:
      item.generic_name_bangla.trim().length < 2
        ? null
        : item.generic_name_bangla.trim(),
  }));

  // Send the JSON response containing the matching data, total count, and pagination details
  res.json({
    status: true,
    details: formattedData,
    total_count: totalCount,
    total_pages: totalPages,
    current_page: page,
  });
};

const searchByGeneric = async (req, res) => {
  // Get the page number and limit from query parameters, with default values if not provided
  const page = parseInt(req.query.page) || 1;
  let limit = parseInt(req.query.limit) || 10;
  if (limit > 20) {
    limit = 10;
  }
  // Calculate the number of documents to skip based on the current page and limit
  const skip = (page - 1) * limit;

  // Get the generic_id parameter from the query
  const genericId = req.query.id;

  try {
    // Create a filter object to find medicines based on the generic_id (treated as string)
    const filter = { generic_id: genericId };

    // Count the total number of documents that match the filter
    const totalCount = await Medicine.countDocuments(filter).exec();

    // Log the filter and pagination parameters
    console.log("Filter:", filter);
    console.log("Skip:", skip);
    console.log("Limit:", limit);
    console.log("Total count:", totalCount);

    // Use the MongoDB aggregate pipeline to fetch data
    const data = await Medicine.aggregate([
      {
        $match: filter,
      },
      {
        $skip: skip,
      },
      {
        $limit: limit,
      },
    ]).exec();

    // Log the fetched data
    console.log("Fetched data:", data);

    // Fetch additional data from "MedicineCompanyName" and "MedicineGeneric"
    const dataWithDetails = await Promise.all(
      data.map(async (item) => {
        const { company_id, generic_id } = item;

        // Get company details based on company_id
        const companyDetails = await MedicineCompanyName.findOne({ company_id })
          .lean()
          .exec();

        // Get generic details based on generic_id (treated as string)
        const genericDetails = await MedicineGeneric.findOne({
          generic_id: parseInt(generic_id),
        })
          .lean()
          .exec();

        return {
          ...item,
          company_name: companyDetails?.company_name,
          generic_details: genericDetails ? [genericDetails] : [],
        };
      })
    );

    // Log the data with additional details
    console.log("Data with details:", dataWithDetails);

    // Calculate total number of pages for the original data
    const totalPages = Math.ceil(totalCount / limit);

    // Send the JSON response containing the data, total count, and pagination details
    res.json({
      status: true,
      details: dataWithDetails,
      total_count: totalCount,
      total_pages: totalPages,
      current_page: page,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ status: false, message: error.message });
  }
};

const displayCompany = async (req, res) => {
  /* 
 Author: Nesar Ahmed Naeem
 Sample API call:
Endpoint: http://localhost:5000/api/v2/medicine/company?limit=5&page=2
*/
  // Get the page number and limit from query parameters, with default values if not provided
  const page = parseInt(req.query.page) || 1;
  let limit = parseInt(req.query.limit) || 10;
  if (limit > 20) {
    limit = 10;
  }
  // Calculate the number of documents to skip based on the current page and limit
  const skip = (page - 1) * limit;

  // Fetch all objects from MedicineGeneric model
  const data = await MedicineCompanyName.find({})
    .select("_id company_name company_id")
    .exec();

  // Count the total number of documents
  const totalCount = data.length;

  // Calculate the total number of pages for the original data
  const totalPages = Math.ceil(totalCount / limit);

  // Apply pagination to the data
  const paginatedData = data.slice(skip, skip + limit);

  // Format the data for the response
  const formattedData = paginatedData.map((item) => ({
    _id: item._id,
    company_name: item.company_name,
    company_id: item.company_id,
  }));

  // Send the JSON response containing the data, total count, and pagination details
  res.json({
    status: true,
    details: formattedData,
    total_count: totalCount,
    total_pages: totalPages,
    current_page: page,
  });
};

const searchByCompanyId = async (req, res) => {
  /* 
 Author: Nesar Ahmed Naeem
 Sample API call:
Endpoint: http://localhost:5000/api/v2/medicine/searchByCompanyId?id=37&page=2&limit=10
Explanation:
- 'id': The 'company_id' you want to search for (in this example, it is set to '123').
- 'page': The page number of the results you want to retrieve (in this example, it is set to '1').
*/

  // Get the page number and limit from query parameters, with default values if not provided
  const page = parseInt(req.query.page) || 1;
  let limit = parseInt(req.query.limit) || 10;
  if (limit > 20) {
    limit = 10;
  }
  // Calculate the number of documents to skip based on the current page and limit
  const skip = (page - 1) * limit;

  // Get the generic_id parameter from the query
  const companyId = req.query.id;

  // Create a filter object to be used in the MongoDB query
  const filter = {
    company_id: companyId,
  };

  // Count the total number of documents that match the filter
  const totalCount = await Medicine.countDocuments(filter);

  // Use the MongoDB aggregate pipeline to fetch data and add a matchScore field based on brand_name
  const data = await Medicine.aggregate([
    {
      $match: filter,
    },
    {
      $addFields: {
        matchScore: {
          $cond: {
            if: { $eq: [{ $type: "$brand_name" }, "string"] },
            then: { $size: { $split: ["$brand_name", " "] } },
            else: 0,
          },
        },
      },
    },
    {
      $sort: { matchScore: -1 },
    },
    {
      $skip: skip,
    },
    {
      $limit: limit,
    },
  ]).exec();

  // Fetch additional data from "MedicineCompanyName" and "MedicineGeneric" collections
  const dataWithDetails = await Promise.all(
    data.map(async (item) => {
      const { company_id, generic_id } = item;

      // Get company details based on company_id
      const companyDetails = await MedicineCompanyName.findOne({ company_id })
        .lean()
        .exec();

      let genericDetails = null;
      if (generic_id) {
        genericDetails = await MedicineGeneric.findOne({
          generic_id: generic_id,
        })
          .lean()
          .exec();

        if (genericDetails) {
          // Format the data inside the genericDetails object
          Object.keys(genericDetails).forEach((key) => {
            if (typeof genericDetails[key] === "string") {
              genericDetails[key] = genericDetails[key]
                .replace(/\s+/g, " ")
                .trim();
            }
          });
        }
      }

      return {
        ...item,
        company_name: companyDetails?.company_name,
        generic_details: genericDetails ? [genericDetails] : [],
      };
    })
  );

  // Calculate total number of pages for the original data
  const totalPages = Math.ceil(totalCount / limit);

  // Send the JSON response containing the data, total count, and pagination details
  res.json({
    status: true,
    details: dataWithDetails,
    total_count: totalCount,
    total_pages: totalPages,
    current_page: page,
  });
};

const getMedicineDetails = async (req, res) => {
  // Get the brand_id from the URL parameter
  const brandId = parseInt(req.params.ID, 10); // Convert the ID to an integer
  // Create a filter object to be used in the MongoDB query
  const filter = { brand_id: brandId };

  // Fetch the medicine details from the "Medicine" collection
  const medicineDetails = await Medicine.findOne(filter).lean().exec();
  if (!medicineDetails) {
    // If no medicine found with the provided brand_id, return an error response
    return res.status(404).json({
      status: false,
      message: "Medicine not found",
    });
  }

  // Fetch additional data from "MedicineCompanyName" and "MedicineGeneric" collections
  const { company_id, generic_id } = medicineDetails;

  // Get company details based on company_id
  const companyDetails = await MedicineCompanyName.findOne({ company_id })
    .lean()
    .exec();

  let genericDetails = null;
  if (generic_id) {
    // Convert the string to an integer before querying the "MedicineGeneric" collection
    const intGenericId = parseInt(generic_id, 10);
    genericDetails = await MedicineGeneric.findOne({
      generic_id: intGenericId,
    })
      .lean()
      .exec();

    if (genericDetails) {
      // Format the data inside the genericDetails object
      Object.keys(genericDetails).forEach((key) => {
        if (typeof genericDetails[key] === "string") {
          genericDetails[key] = genericDetails[key].replace(/\s+/g, " ").trim();
        }
      });
    }
  }

  // Create the final response object with medicine details, company details, and generic details
  const response = {
    ...medicineDetails,
    company_name: companyDetails?.company_name,
    generic_details: genericDetails ? [genericDetails] : [],
  };

  // Send the JSON response containing the medicine details
  res.json({
    status: true,
    details: response,
  });
};

module.exports = {
  getAllMedicine,
  searchMedicine,
  displayGeneric,
  searchByGeneric,
  displayCompany,
  searchByCompanyId,
  getMedicineDetails,
};
