/**
 * Bitrix24 Product and Inventory Operations
 * Handles product creation and inventory synchronization
 */

import { callBitrix } from './client.js';
import { updateSkuMapping } from './mappingUtils.js';

/**
 * Create product in Bitrix catalog
 * @param {Object} productData - Product data
 * @param {string} productData.name - Product name
 * @param {number} productData.price - Product price
 * @param {string} productData.sku - SKU (CODE and XML_ID)
 * @param {number} catalogId - Catalog ID (default: 14)
 * @param {number} sectionId - Section ID (default: 32)
 * @returns {Promise<number>} Created product ID
 */
export async function createBitrixProduct(productData, catalogId = 14, sectionId = 32) {
  const { name, price, sku } = productData;

  if (!name || !sku) {
    throw new Error('Product name and SKU are required');
  }

  const fields = {
    NAME: name,
    CURRENCY_ID: 'EUR',
    PRICE: price || 0,
    CATALOG_ID: catalogId,
    SECTION_ID: sectionId,
    CODE: sku,
    XML_ID: sku, // Use SKU as external ID
    ACTIVE: 'Y',
    VAT_INCLUDED: 'N',
    MEASURE: 1, // Pieces
  };

  try {
    const response = await callBitrix('crm.product.add', { fields });

    if (response.result) {
      const productId = parseInt(response.result);
      console.log(`[BITRIX PRODUCTS] ✅ Product created: ${name} (SKU: ${sku}) → ID: ${productId}`);
      return productId;
    } else {
      throw new Error(`Failed to create product: ${response.error_description || 'Unknown error'}`);
    }
  } catch (error) {
    console.error(`[BITRIX PRODUCTS] ❌ Error creating product ${name}:`, error);
    throw error;
  }
}

/**
 * Check if product exists in Bitrix by SKU
 * @param {string} sku - Product SKU
 * @returns {Promise<number|null>} Product ID if exists, null otherwise
 */
export async function findProductBySku(sku) {
  try {
    const response = await callBitrix('crm.product.list', {
      filter: { XML_ID: sku },
      select: ['ID', 'NAME', 'CODE', 'XML_ID']
    });

    if (response.result && response.result.length > 0) {
      return parseInt(response.result[0].ID);
    }

    return null;
  } catch (error) {
    console.error(`[BITRIX PRODUCTS] Error finding product by SKU ${sku}:`, error);
    return null;
  }
}

/**
 * Get current stock quantity for a product in Bitrix
 * @param {number} productId - Product ID
 * @param {number} storeId - Store ID (default: 2)
 * @returns {Promise<number>} Current stock quantity
 */
export async function getCurrentStock(productId, storeId = 2) {
  try {
    const response = await callBitrix('catalog.storeproduct.list', {
      filter: {
        productId: productId,
        storeId: storeId
      },
      select: ['amount']
    });

    if (response.result?.storeProducts && response.result.storeProducts.length > 0) {
      const amount = parseFloat(response.result.storeProducts[0].amount || 0);
      console.log(`[BITRIX PRODUCTS] Current stock for Product ID ${productId}: ${amount}`);
      return amount;
    }

    console.log(`[BITRIX PRODUCTS] No stock found for Product ID ${productId}, returning 0`);
    return 0;
  } catch (error) {
    console.error(`[BITRIX PRODUCTS] Error getting current stock:`, error);
    return 0;
  }
}

/**
 * Create incoming document (Store Adjustment) in Bitrix
 * @param {Object} documentData - Document data
 * @param {string} documentData.title - Document title
 * @param {number} documentData.productId - Product ID
 * @param {number} documentData.amount - Quantity to add
 * @param {number} documentData.price - Purchase price (default: 0)
 * @param {number} documentData.storeId - Store ID (default: 2)
 * @returns {Promise<number>} Created document ID
 */
export async function createIncomingDocument(documentData) {
  const {
    title,
    productId,
    amount,
    price = 0,
    storeId = 2
  } = documentData;

  if (!title || !productId || amount <= 0) {
    throw new Error('Document title, product ID, and positive amount are required');
  }

  const docNumber = `CERT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    // 1. Create document
    const docResponse = await callBitrix('catalog.document.add', {
      fields: {
        docType: 'S', // Store Adjustment
        title: title,
        docNumber: docNumber,
        currency: 'EUR',
        status: 'N', // Draft
        responsibleId: 52
      }
    });

    let docId;
    if (docResponse.result?.document?.id) {
      docId = docResponse.result.document.id;
    } else if (docResponse.result) {
      docId = docResponse.result;
    } else {
      throw new Error('Failed to create document: no ID returned');
    }

    console.log(`[BITRIX PRODUCTS] ✅ Document created: ${docNumber} (ID: ${docId})`);

    // Wait a bit for document to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. Add product to document
    const elementPayload = {
      fields: {
        docId: docId,
        DOC_ID: docId,
        productId: productId,
        elementId: productId,
        ELEMENT_ID: productId,
        amount: amount,
        AMOUNT: amount,
        purchasingPrice: price,
        PURCHASING_PRICE: price,
        storeId: storeId,
        storeTo: storeId,
        STORE_TO: storeId
      }
    };

    const elementResponse = await callBitrix('catalog.document.element.add', elementPayload);

    if (!elementResponse.result) {
      throw new Error(`Failed to add product to document: ${JSON.stringify(elementResponse)}`);
    }

    console.log(`[BITRIX PRODUCTS] ✅ Product added to document: Product ID ${productId}, Amount: ${amount}`);

    // Wait a bit before conducting
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 3. Conduct document
    const conductResponse = await callBitrix('catalog.document.conduct', { id: docId });

    if (conductResponse.result === true) {
      console.log(`[BITRIX PRODUCTS] ✅ Document conducted: ${docNumber}`);
      return docId;
    } else {
      throw new Error(`Failed to conduct document: ${JSON.stringify(conductResponse)}`);
    }
  } catch (error) {
    console.error(`[BITRIX PRODUCTS] ❌ Error creating incoming document:`, error);
    throw error;
  }
}

/**
 * Sync certificate from Shopify to Bitrix
 * Creates product if not exists, then creates incoming document
 * @param {Object} variantData - Variant data from Shopify
 * @param {string} handle - Product handle (for mapping)
 * @param {Object} handleToProductId - Mapping handle -> base Product ID (for fallback, not used currently)
 * @returns {Promise<Object>} Sync result
 */
export async function syncCertificateVariant(variantData, handle, handleToProductId = {}) {
  const { variant_title, price, inventory_quantity } = variantData;

  // Generate SKU: {handle}-{variant_title} (e.g., "e-certificate-30")
  // Remove € symbol and spaces, convert to lowercase
  const variantTitleClean = variant_title.replace(/[€\s,]/g, '').toLowerCase();
  const sku = `${handle}-${variantTitleClean}`;

  // Product name: "{Product Title} - {Variant Title}" (e.g., "E-Certificate - €30")
  const productName = `${variantData.product_title} - ${variant_title}`;

  try {
    // 1. Check if product exists
    let productId = await findProductBySku(sku);

    // 2. Create product if not exists (only if createNew=true)
    if (!productId) {
      if (createNew) {
        console.log(`[BITRIX PRODUCTS] Creating product: ${productName} (SKU: ${sku})`);
        productId = await createBitrixProduct({
          name: productName,
          price: parseFloat(price) || 0,
          sku: sku
        });
        
        // ✅ CRITICAL: Update mapping cache after creating product
        updateSkuMapping(sku, productId);
        console.log(`[BITRIX PRODUCTS] ✅ Updated mapping cache: ${sku} -> ${productId}`);
      } else {
        console.warn(`[BITRIX PRODUCTS] ⚠️ Product not found: ${productName} (SKU: ${sku}), but createNew=false. Skipping.`);
        return {
          success: false,
          sku: sku,
          error: 'Product not found and createNew=false'
        };
      }
    } else {
      console.log(`[BITRIX PRODUCTS] Product exists: ${productName} (SKU: ${sku}, ID: ${productId})`);
      
      // ✅ Ensure mapping is in cache (might have been found via API)
      updateSkuMapping(sku, productId);
    }

    // 3. Sync inventory: compare Shopify quantity with Bitrix stock
    let documentId = null;
    const shopifyQty = inventory_quantity || 0;
    
    // Get current stock from Bitrix
    const currentStock = await getCurrentStock(productId);
    const difference = shopifyQty - currentStock;

    if (difference > 0) {
      // Need to add (incoming document)
      console.log(`[BITRIX PRODUCTS] 📈 Adding ${difference} items (Shopify: ${shopifyQty}, Bitrix: ${currentStock})`);
      documentId = await createIncomingDocument({
        title: `Синхронизация сертификата ${sku} из Shopify (добавление)`,
        productId: productId,
        amount: difference,
        price: 0 // Certificates have 0 purchase price
      });
    } else if (difference < 0) {
      // Need to deduct (outgoing document)
      const deductAmount = Math.abs(difference);
      console.log(`[BITRIX PRODUCTS] 📉 Deducting ${deductAmount} items (Shopify: ${shopifyQty}, Bitrix: ${currentStock})`);
      documentId = await createOutgoingDocument({
        title: `Синхронизация сертификата ${sku} из Shopify (списание)`,
        productId: productId,
        amount: deductAmount
      });
    } else {
      console.log(`[BITRIX PRODUCTS] ✅ Quantities match (Shopify: ${shopifyQty}, Bitrix: ${currentStock}) - no sync needed`);
    }

    return {
      success: true,
      sku: sku,
      productId: productId,
      productName: productName,
      quantity: shopifyQty,
      currentStock: currentStock,
      difference: difference,
      documentId: documentId,
      documentType: difference > 0 ? 'incoming' : (difference < 0 ? 'outgoing' : null)
    };
  } catch (error) {
    console.error(`[BITRIX PRODUCTS] ❌ Error syncing variant ${sku}:`, error);
    return {
      success: false,
      sku: sku,
      error: error.message
    };
  }
}

