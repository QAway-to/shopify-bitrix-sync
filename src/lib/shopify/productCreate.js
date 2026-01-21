/**
 * Shopify Product Creation Module
 * Creates products/variants in Shopify from Bitrix deal data
 */

import { callShopifyAdmin } from './adminClient.js';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';

/**
 * Search for existing Shopify product by title and vendor
 * @param {string} title - Product title to search
 * @param {string} vendor - Product vendor/brand
 * @returns {Promise<Object|null>} Product object or null if not found
 */
export async function findShopifyProductByTitle(title, vendor) {
    try {
        // Search products by title (Shopify search is case-insensitive)
        const searchQuery = encodeURIComponent(title);
        const response = await callShopifyAdmin(`/products.json?title=${searchQuery}&limit=50`);

        if (!response.products || response.products.length === 0) {
            console.log(`[PRODUCT CREATE] No products found with title: "${title}"`);
            return null;
        }

        // Filter by exact title and vendor match
        const exactMatch = response.products.find(p =>
            p.title.toLowerCase() === title.toLowerCase() &&
            p.vendor.toLowerCase() === vendor.toLowerCase()
        );

        if (exactMatch) {
            console.log(`[PRODUCT CREATE] Found exact match: Product ID ${exactMatch.id}, Title: "${exactMatch.title}", Vendor: "${exactMatch.vendor}"`);
            return exactMatch;
        }

        // Fallback: match by title only
        const titleMatch = response.products.find(p =>
            p.title.toLowerCase() === title.toLowerCase()
        );

        if (titleMatch) {
            console.log(`[PRODUCT CREATE] Found title match: Product ID ${titleMatch.id}, Title: "${titleMatch.title}"`);
            return titleMatch;
        }

        console.log(`[PRODUCT CREATE] No exact match found for title: "${title}", vendor: "${vendor}"`);
        return null;
    } catch (error) {
        console.error(`[PRODUCT CREATE] Error searching for product: ${error.message}`);
        return null;
    }
}

/**
 * Check if a variant with the given size already exists on the product
 * @param {Object} product - Shopify product object
 * @param {string} size - Size to check
 * @returns {Object|null} Variant object if found, null otherwise
 */
export function findVariantBySize(product, size) {
    if (!product.variants || !Array.isArray(product.variants)) {
        return null;
    }

    const sizeStr = String(size).trim();
    return product.variants.find(v =>
        String(v.option1).trim() === sizeStr ||
        String(v.option2).trim() === sizeStr ||
        String(v.option3).trim() === sizeStr
    );
}

/**
 * Add a new variant (size) to an existing product
 * @param {string} productId - Shopify product ID
 * @param {string} size - Size value for the variant
 * @param {number} price - Price for the variant
 * @param {string} sku - SKU for the variant (optional)
 * @returns {Promise<Object>} Result with variant_id
 */
export async function addVariantToProduct(productId, size, price, sku = null) {
    try {
        const variantData = {
            variant: {
                option1: String(size),
                price: String(price),
                inventory_management: 'shopify',
                inventory_policy: 'continue'  // Allow preorders (selling at 0 stock)
            }
        };

        if (sku) {
            variantData.variant.sku = sku;
        }

        console.log(`[PRODUCT CREATE] Adding variant to product ${productId}: size=${size}, price=${price}`);

        const response = await callShopifyAdmin(`/products/${productId}/variants.json`, {
            method: 'POST',
            body: JSON.stringify(variantData)
        });

        if (response.variant && response.variant.id) {
            console.log(`[PRODUCT CREATE] ✅ Variant created: ID ${response.variant.id}`);
            return {
                success: true,
                variantId: String(response.variant.id),
                productId: String(productId),
                action: 'variant_added'
            };
        }

        return {
            success: false,
            error: 'No variant in response',
            response
        };
    } catch (error) {
        console.error(`[PRODUCT CREATE] Error adding variant: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Create a new product with one variant in Shopify
 * @param {Object} params - Product parameters
 * @param {string} params.title - Product title
 * @param {string} params.vendor - Product vendor/brand
 * @param {string} params.size - Size value for first variant
 * @param {number} params.price - Price for the variant
 * @param {string} params.sku - SKU for the variant (optional)
 * @param {string} params.description - Product description (optional)
 * @param {string} params.productType - Product type (optional, default: "Shoes")
 * @param {string} params.imageUrl - Image URL (optional)
 * @returns {Promise<Object>} Result with variant_id and product_id
 */
export async function createShopifyProduct({
    title,
    vendor,
    size,
    price,
    sku = null,
    description = '',
    productType = 'Shoes',
    imageUrl = null
}) {
    try {
        const productData = {
            product: {
                title,
                body_html: description || `${title} - ${vendor}`,
                vendor,
                product_type: productType,
                status: 'active',
                options: [
                    {
                        name: 'Size',
                        values: [String(size)]
                    }
                ],
                variants: [
                    {
                        option1: String(size),
                        price: String(price),
                        inventory_management: 'shopify',
                        inventory_policy: 'continue'  // Allow preorders (selling at 0 stock)
                    }
                ]
            }
        };

        // Add SKU if provided
        if (sku) {
            productData.product.variants[0].sku = sku;
        }

        // Add image if provided
        if (imageUrl) {
            productData.product.images = [{ src: imageUrl }];
        }

        console.log(`[PRODUCT CREATE] Creating new product: "${title}" by ${vendor}, size=${size}, price=${price}`);

        const response = await callShopifyAdmin('/products.json', {
            method: 'POST',
            body: JSON.stringify(productData)
        });

        if (response.product && response.product.id) {
            const product = response.product;
            const variant = product.variants[0];

            console.log(`[PRODUCT CREATE] ✅ Product created: ID ${product.id}, Variant ID ${variant.id}`);

            return {
                success: true,
                productId: String(product.id),
                variantId: String(variant.id),
                action: 'product_created'
            };
        }

        return {
            success: false,
            error: 'No product in response',
            response
        };
    } catch (error) {
        console.error(`[PRODUCT CREATE] Error creating product: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Main function: Find or create product/variant in Shopify
 * @param {Object} params - Product parameters
 * @returns {Promise<Object>} Result with variant_id
 */
export async function findOrCreateShopifyProduct({
    title,
    vendor,
    size,
    price,
    sku = null,
    description = '',
    productType = 'Shoes',
    imageUrl = null
}) {
    console.log(`[PRODUCT CREATE] === Find or Create: "${title}" by ${vendor}, size=${size} ===`);

    // Step 1: Search for existing product
    const existingProduct = await findShopifyProductByTitle(title, vendor);

    if (existingProduct) {
        // Step 2a: Check if variant with this size exists
        const existingVariant = findVariantBySize(existingProduct, size);

        if (existingVariant) {
            console.log(`[PRODUCT CREATE] ✅ Found existing variant: ID ${existingVariant.id}`);
            return {
                success: true,
                variantId: String(existingVariant.id),
                productId: String(existingProduct.id),
                action: 'existing_variant_found'
            };
        }

        // Step 2b: Add new variant to existing product
        console.log(`[PRODUCT CREATE] Product exists but size ${size} not found, adding variant...`);
        return await addVariantToProduct(existingProduct.id, size, price, sku);
    }

    // Step 3: Create new product with variant
    console.log(`[PRODUCT CREATE] Product not found, creating new...`);
    const createResult = await createShopifyProduct({
        title,
        vendor,
        size,
        price,
        sku,
        description,
        productType,
        imageUrl
    });

    // ✅ POS-Only Visibility Logic
    if (createResult.success && createResult.productId) {
        try {
            await manageProductPublications(createResult.productId);
        } catch (pubError) {
            console.warn(`[PRODUCT CREATE] ⚠️ Failed to set POS-only visibility: ${pubError.message}`);
        }
    }

    return createResult;
}

/**
 * Manage product publications: Unpublish from "Online Store", Publish to "Point of Sale"
 * @param {string} productId - Shopify Product ID (numeric string)
 */
async function manageProductPublications(productId) {
    const { callShopifyGraphQL } = await import('./adminClient.js');

    console.log(`[PRODUCT CREATE] 🙈 Setting visibility for product ${productId} (POS only)...`);

    // 1. Get Publications (Sales Channels)
    // We need to find the IDs for "Online Store" and "Point of Sale"
    const pubsQuery = `
      query {
        publications(first: 20) {
          edges {
            node {
              id
              name
              catalog {
                title
              }
            }
          }
        }
      }
    `;

    const pubsData = await callShopifyGraphQL(pubsQuery);
    const publications = pubsData.publications?.edges?.map(e => e.node) || [];

    const onlineStore = publications.find(p => p.name === 'Online Store' || p.catalog?.title === 'Online Store');
    const pos = publications.find(p => p.name === 'Point of Sale' || p.catalog?.title === 'Point of Sale');

    const productGid = `gid://shopify/Product/${productId}`;

    // 2. Unpublish from Online Store
    if (onlineStore) {
        const unpublishMutation = `
          mutation publishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
            publishableUnpublish(id: $id, input: $input) {
              userErrors {
                field
                message
              }
            }
          }
        `;

        await callShopifyGraphQL(unpublishMutation, {
            id: productGid,
            input: [{ publicationId: onlineStore.id }]
        });
        console.log(`[PRODUCT CREATE] 🙈 Unpublished ${productId} from Online Store (${onlineStore.id})`);
    } else {
        console.warn(`[PRODUCT CREATE] ⚠️ "Online Store" channel not found.`);
    }

    // 3. Publish to Point of Sale (Ensure it's visible)
    if (pos) {
        const publishMutation = `
          mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) {
              userErrors {
                field
                message
              }
            }
          }
        `;

        await callShopifyGraphQL(publishMutation, {
            id: productGid,
            input: [{ publicationId: pos.id }]
        });
        console.log(`[PRODUCT CREATE] 👁️ Published ${productId} to Point of Sale (${pos.id})`);
    } else {
        console.warn(`[PRODUCT CREATE] ⚠️ "Point of Sale" channel not found.`);
    }
}

export default {
    findShopifyProductByTitle,
    findVariantBySize,
    addVariantToProduct,
    createShopifyProduct,
    findOrCreateShopifyProduct
};
